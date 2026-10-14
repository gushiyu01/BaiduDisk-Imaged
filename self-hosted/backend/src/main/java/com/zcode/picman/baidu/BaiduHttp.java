package com.zcode.picman.baidu;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 百度网盘 HTTP 传输层：超时、UA、重定向、SSRF 校验、JSON 解析都收在这里，
 * 业务代码只看到类型化结果。
 */
@Component
public class BaiduHttp {

    private static final Logger log = LoggerFactory.getLogger(BaiduHttp.class);

    /**
     * 固定使用这个 UA。百度对未上架/第三方应用的 dlink 和缩略图做防盗链，
     * UA 不含 pan.baidu.com 会直接 403（errno 31326）。
     */
    public static final String USER_AGENT = "pan.baidu.com";

    private static final int MAX_REDIRECTS = 5;

    private final HttpClient http;
    private final ObjectMapper mapper;
    private final BaiduPanProperties props;
    private final DlinkGuard guard;

    public BaiduHttp(ObjectMapper mapper, BaiduPanProperties props, DlinkGuard guard) {
        this.mapper = mapper;
        this.props = props;
        this.guard = guard;
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofMillis(props.connectTimeoutMs()))
                // 手动跟随重定向，这样每一跳都能过 SSRF 校验并保留 Range 头
                .followRedirects(HttpClient.Redirect.NEVER)
                .version(HttpClient.Version.HTTP_1_1)
                .build();
    }

    public ObjectMapper mapper() {
        return mapper;
    }

    // ------------------------------------------------------------------ URI 构造

    /** 用 URLEncoder 拼查询串。百度要求 path 等参数必须编码，手拼极易出错。 */
    public static String query(Map<String, String> params) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : params.entrySet()) {
            if (e.getValue() == null) {
                continue;
            }
            if (sb.length() > 0) {
                sb.append('&');
            }
            sb.append(URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8))
              .append('=')
              .append(URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8));
        }
        return sb.toString();
    }

    public static Map<String, String> params(String... kv) {
        if (kv.length % 2 != 0) {
            throw new IllegalArgumentException("参数必须成对出现");
        }
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put(kv[i], kv[i + 1]);
        }
        return m;
    }

    /** 在已有 URL 后面追加 access_token，保留原有签名参数 */
    public static String withToken(String url, String token) {
        if (token == null || token.isBlank()) {
            return url;
        }
        return url + (url.contains("?") ? "&" : "?") + "access_token=" + urlEncode(token);
    }

    private static String urlEncode(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------------ JSON 调用

    public <T> T getJson(String url, Class<T> type) {
        HttpRequest req = base(url).GET().build();
        return sendJson(req, url, type);
    }

    public <T> T postForm(String url, Map<String, String> form, Class<T> type) {
        HttpRequest req = base(url)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(query(form), StandardCharsets.UTF_8))
                .build();
        return sendJson(req, url, type);
    }

    /**
     * multipart/form-data 上传。手写而不是用 BodyPublishers.ofFile 之类的现成封装，
     * 因为百度分片接口要求字段名固定为 file、且必须一次性带上完整二进制分片。
     */
    public <T> T postMultipart(String url, String fieldName, String filename, byte[] content, Class<T> type) {
        String boundary = "----picman" + UUID.randomUUID().toString().replace("-", "");
        byte[] body = buildMultipart(boundary, fieldName, filename, content);
        HttpRequest req = base(url)
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build();
        return sendJson(req, url, type);
    }

    private static byte[] buildMultipart(String boundary, String fieldName, String filename, byte[] content) {
        byte[] prefix = ("--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"" + fieldName + "\"; filename=\"" + filename + "\"\r\n"
                + "Content-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8);
        byte[] suffix = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8);
        byte[] out = new byte[prefix.length + content.length + suffix.length];
        System.arraycopy(prefix, 0, out, 0, prefix.length);
        System.arraycopy(content, 0, out, prefix.length, content.length);
        System.arraycopy(suffix, 0, out, prefix.length + content.length, suffix.length);
        return out;
    }

    private <T> T sendJson(HttpRequest req, String url, Class<T> type) {
        try {
            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            String body = resp.body();
            if (body == null || body.isBlank()) {
                throw new BaiduPanException("百度接口返回空响应：HTTP %d %s".formatted(resp.statusCode(), safeHost(url)), null);
            }
            if (resp.statusCode() >= 400 && !looksLikeJson(body)) {
                throw new BaiduPanException(
                        "百度接口返回 HTTP %d：%s".formatted(resp.statusCode(), truncate(body)), null);
            }
            return mapper.readValue(body, type);
        } catch (IOException e) {
            throw new BaiduPanException("调用百度接口失败（%s）：%s".formatted(safeHost(url), e.getMessage()), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BaiduPanException("调用百度接口被中断", e);
        }
    }

    // ------------------------------------------------------------------ 流式下载

    /**
     * 打开一个可流式读取的下载。返回的 RemoteStream 由调用方负责关闭。
     * <p>
     * 注意：HttpRequest 的 timeout 只覆盖到响应头到达，正文字节流不受它约束，
     * 所以大图不会因为传输久而被超时掐断。
     */
    public RemoteStream openStream(String url, String rangeHeader) {
        return openStream(url, rangeHeader, 0);
    }

    private RemoteStream openStream(String url, String rangeHeader, int depth) {
        if (depth > MAX_REDIRECTS) {
            throw new BaiduPanException("下载地址重定向次数过多", null);
        }
        guard.assertAllowed(url, "下载地址");

        HttpRequest.Builder b = base(url).GET();
        if (rangeHeader != null && !rangeHeader.isBlank()) {
            b.header("Range", rangeHeader);
        }

        HttpResponse<InputStream> resp;
        try {
            resp = http.send(b.build(), HttpResponse.BodyHandlers.ofInputStream());
        } catch (IOException e) {
            throw new BaiduPanException("下载失败（%s）：%s".formatted(safeHost(url), e.getMessage()), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BaiduPanException("下载被中断", e);
        }

        int code = resp.statusCode();
        if (code >= 300 && code < 400) {
            String location = resp.headers().firstValue("Location").orElse(null);
            closeQuietly(resp.body());
            if (location == null || location.isBlank()) {
                throw new BaiduPanException("下载地址返回 %d 但没有 Location 头".formatted(code), null);
            }
            String next = URI.create(url).resolve(location).toString();
            // 每一跳都重新校验主机，避免被 302 到内网地址
            return openStream(next, rangeHeader, depth + 1);
        }

        if (code >= 400) {
            String body = readAllQuietly(resp.body());
            String errno = extractErrno(body);
            throw new BaiduPanException(
                    "下载失败：HTTP %d %s%s".formatted(code, truncate(body), errno), null);
        }
        return new RemoteStream(code, HttpResponseHeaders.from(resp.headers()), resp.body());
    }

    /** 取回整个响应体，用于缩略图这种小文件 */
    public byte[] getBytes(String url, int maxBytes) {
        try (RemoteStream rs = openStream(url, null)) {
            byte[] data = rs.body().readNBytes(maxBytes + 1);
            if (data.length > maxBytes) {
                throw new BaiduPanException("响应体超过上限 %d 字节".formatted(maxBytes), null);
            }
            return data;
        } catch (IOException e) {
            throw new BaiduPanException("读取响应失败：" + e.getMessage(), e);
        }
    }

    // ------------------------------------------------------------------ 小工具

    private HttpRequest.Builder base(String url) {
        return HttpRequest.newBuilder(URI.create(url))
                .header("User-Agent", USER_AGENT)
                .header("Accept", "*/*")
                .timeout(Duration.ofMillis(props.readTimeoutMs()));
    }

    private static boolean looksLikeJson(String s) {
        String t = s.trim();
        return t.startsWith("{") || t.startsWith("[");
    }

    private static String extractErrno(String body) {
        int i = body == null ? -1 : body.indexOf("\"errno\"");
        if (i < 0) {
            return "";
        }
        int end = Math.min(body.length(), i + 32);
        return " (" + body.substring(i, end).replaceAll("\\s+", "") + ")";
    }

    private static String safeHost(String url) {
        try {
            return URI.create(url).getHost();
        } catch (Exception e) {
            return "unknown";
        }
    }

    private static String truncate(String s) {
        if (s == null) {
            return "";
        }
        String t = s.replaceAll("\\s+", " ").trim();
        return t.length() <= 200 ? t : t.substring(0, 200) + "…";
    }

    private static String readAllQuietly(InputStream in) {
        try (in) {
            return new String(in.readNBytes(4096), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    private static void closeQuietly(InputStream in) {
        try {
            in.close();
        } catch (IOException ignored) {
        }
    }

    /** 一个已打开的下载响应。调用方必须关闭。 */
    public record RemoteStream(int status, HttpResponseHeaders headers, InputStream body) implements AutoCloseable {

        @Override
        public void close() {
            closeQuietly(body);
        }

        public boolean isPartial() {
            return status == 206;
        }
    }

    /** 只暴露我们需要的那几个响应头，避免把 JDK 类型泄漏到业务层 */
    public record HttpResponseHeaders(String contentType, long contentLength, String contentRange, String acceptRanges) {

        public static HttpResponseHeaders from(HttpHeaders h) {
            long len = -1;
            String cl = h.firstValue("content-length").orElse(null);
            if (cl != null) {
                try {
                    len = Long.parseLong(cl.trim());
                } catch (NumberFormatException ignored) {
                    // 上游偶尔给出异常值，保持 -1 表示未知
                }
            }
            return new HttpResponseHeaders(
                    h.firstValue("content-type").orElse(null),
                    len,
                    h.firstValue("content-range").orElse(null),
                    h.firstValue("accept-ranges").orElse(null));
        }
    }
}
