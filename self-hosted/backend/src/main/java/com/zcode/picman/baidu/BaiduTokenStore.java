package com.zcode.picman.baidu;

import com.zcode.picman.repository.SystemConfigRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Instant;

/**
 * 令牌仓库。access_token / refresh_token 只在这里读写，也只存在服务端数据库里。
 * <p>
 * 两个必须注意的点：
 * <ul>
 *   <li>refresh_token 是一次性的，用掉就作废，必须立刻把返回的新值覆盖回去。</li>
 *   <li>因此刷新动作必须串行化——两个线程同时刷新会让其中一个拿到已失效的 token。</li>
 * </ul>
 */
@Component
public class BaiduTokenStore {

    private static final Logger log = LoggerFactory.getLogger(BaiduTokenStore.class);

    private static final String KEY_ACCESS = "baidu.access_token";
    private static final String KEY_REFRESH = "baidu.refresh_token";
    private static final String KEY_EXPIRES_AT = "baidu.expires_at";
    private static final String KEY_SCOPE = "baidu.scope";

    private static final String TOKEN_URL = "https://openapi.baidu.com/oauth/2.0/token";
    private static final String AUTHORIZE_URL = "https://openapi.baidu.com/oauth/2.0/authorize";

    /** 提前多久刷新，避免请求正好卡在过期瞬间 */
    private static final long REFRESH_WINDOW_MS = 5 * 60 * 1000L;

    private final SystemConfigRepository config;
    private final BaiduPanProperties props;
    private final BaiduHttp http;

    private final Object refreshLock = new Object();

    public BaiduTokenStore(SystemConfigRepository config, BaiduPanProperties props, BaiduHttp http) {
        this.config = config;
        this.props = props;
        this.http = http;
    }

    public record TokenStatus(boolean authorized, Instant expiresAt, String scope) {
        public static TokenStatus unauthorized() {
            return new TokenStatus(false, null, null);
        }
    }

    // ------------------------------------------------------------------ 授权流程

    /** 生成用户授权链接。redirect_uri 固定 oob，百度会把授权码直接显示在页面上。 */
    public String authorizeUrl() {
        requireConfigured();
        return AUTHORIZE_URL + "?" + BaiduHttp.query(BaiduHttp.params(
                "response_type", "code",
                "client_id", props.appKey(),
                "redirect_uri", "oob",
                "scope", "basic,netdisk",
                "display", "page"));
    }

    /** 用授权码换取令牌。授权码 10 分钟有效且只能用一次。 */
    public TokenStatus exchangeCode(String code) {
        requireConfigured();
        if (code == null || code.isBlank()) {
            throw new BaiduPanException("授权码不能为空", null);
        }
        BaiduDtos.TokenResp resp = http.postForm(TOKEN_URL, BaiduHttp.params(
                "grant_type", "authorization_code",
                "code", code.trim(),
                // 用户从浏览器复制授权码时经常多带一个换行或空格
                "client_id", props.appKey(),
                "client_secret", props.secretKey(),
                "redirect_uri", "oob"), BaiduDtos.TokenResp.class);

        if (resp.error() != null) {
            throw new BaiduPanException(
                    "换取令牌失败：%s %s".formatted(resp.error(), nullToEmpty(resp.errorDescription())), null);
        }
        persist(resp);
        log.info("百度网盘授权成功，scope={}", resp.scope());
        return status();
    }

    public TokenStatus status() {
        String access = config.find(KEY_ACCESS).orElse(null);
        if (access == null || access.isBlank()) {
            return TokenStatus.unauthorized();
        }
        long exp = parseLong(config.getOr(KEY_EXPIRES_AT, "0"));
        return new TokenStatus(true, Instant.ofEpochMilli(exp), config.getOr(KEY_SCOPE, null));
    }

    public void clear() {
        synchronized (refreshLock) {
            config.delete(KEY_ACCESS);
            config.delete(KEY_REFRESH);
            config.delete(KEY_EXPIRES_AT);
            config.delete(KEY_SCOPE);
        }
        log.info("已清除百度网盘授权");
    }

    // ------------------------------------------------------------------ 取用令牌

    /**
     * 取一个当前有效的 access_token，必要时自动刷新。
     *
     * @throws BaiduPanException errno = -6，表示需要用户重新授权
     */
    public String accessToken() {
        synchronized (refreshLock) {
            String access = config.find(KEY_ACCESS).orElse(null);
            if (access == null || access.isBlank()) {
                throw new BaiduPanException(BaiduErrno.INVALID_TOKEN, "尚未完成百度网盘授权，请先授权");
            }
            long exp = parseLong(config.getOr(KEY_EXPIRES_AT, "0"));
            if (exp - System.currentTimeMillis() > REFRESH_WINDOW_MS) {
                return access;
            }
            return refreshLocked();
        }
    }

    /** 强制刷新，供接口调用失败后重试用 */
    public String forceRefresh() {
        synchronized (refreshLock) {
            return refreshLocked();
        }
    }

    private String refreshLocked() {
        String refresh = config.find(KEY_REFRESH).orElse(null);
        if (refresh == null || refresh.isBlank()) {
            clearLocked();
            throw new BaiduPanException(BaiduErrno.INVALID_TOKEN, "刷新令牌不存在，请重新授权百度网盘");
        }
        BaiduDtos.TokenResp resp;
        try {
            resp = http.postForm(TOKEN_URL, BaiduHttp.params(
                    "grant_type", "refresh_token",
                    "refresh_token", refresh,
                    "client_id", props.appKey(),
                    "client_secret", props.secretKey()), BaiduDtos.TokenResp.class);
        } catch (BaiduPanException e) {
            // 网络问题不应该把本地授权清掉，只有百度明确拒绝才清
            throw e;
        }

        if (resp.error() != null) {
            log.warn("刷新令牌失败：{} {}", resp.error(), nullToEmpty(resp.errorDescription()));
            // refresh_token 一旦刷新失败就永久作废，只能重新授权
            clearLocked();
            throw new BaiduPanException(BaiduErrno.INVALID_TOKEN,
                    "百度网盘授权已失效（%s），请重新授权".formatted(resp.error()));
        }
        persist(resp);
        log.info("已刷新百度网盘 access_token");
        return resp.accessToken();
    }

    private void persist(BaiduDtos.TokenResp resp) {
        if (resp.accessToken() == null || resp.accessToken().isBlank()) {
            throw new BaiduPanException("百度未返回 access_token："
                    + nullToEmpty(resp.errorDescription()), null);
        }
        long expiresIn = resp.expiresIn() == null ? 2592000L : resp.expiresIn();
        config.put(KEY_ACCESS, resp.accessToken());
        if (resp.refreshToken() != null && !resp.refreshToken().isBlank()) {
            config.put(KEY_REFRESH, resp.refreshToken());
        }
        config.put(KEY_EXPIRES_AT, String.valueOf(System.currentTimeMillis() + expiresIn * 1000L));
        if (resp.scope() != null && !resp.scope().isBlank()) {
            config.put(KEY_SCOPE, resp.scope());
        }
    }

    private void clearLocked() {
        config.delete(KEY_ACCESS);
        config.delete(KEY_REFRESH);
        config.delete(KEY_EXPIRES_AT);
        config.delete(KEY_SCOPE);
    }

    private void requireConfigured() {
        if (!props.isConfigured()) {
            throw new BaiduPanException(
                    "后端未配置百度网盘应用凭证，请设置环境变量 BAIDU_DISK_APP_KEY 与 BAIDU_DISK_SECRET_KEY", null);
        }
    }

    private static long parseLong(String s) {
        try {
            return Long.parseLong(s.trim());
        } catch (Exception e) {
            return 0L;
        }
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
