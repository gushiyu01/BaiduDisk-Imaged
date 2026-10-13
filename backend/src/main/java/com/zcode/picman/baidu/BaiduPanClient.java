package com.zcode.picman.baidu;

import com.zcode.picman.baidu.BaiduDtos.CreateResp;
import com.zcode.picman.baidu.BaiduDtos.FileManagerResp;
import com.zcode.picman.baidu.BaiduDtos.FileMeta;
import com.zcode.picman.baidu.BaiduDtos.FileMetasResp;
import com.zcode.picman.baidu.BaiduDtos.FsEntry;
import com.zcode.picman.baidu.BaiduDtos.ListResp;
import com.zcode.picman.baidu.BaiduDtos.PrecreateResp;
import com.zcode.picman.baidu.BaiduDtos.Quota;
import com.zcode.picman.baidu.BaiduDtos.SliceResp;
import com.zcode.picman.baidu.BaiduDtos.Uinfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * 百度网盘开放平台统一封装。所有对百度的调用都必须经过这里，
 * 业务层不应该出现任何 HTTP、URL 拼接或 errno 判断。
 * <p>
 * 封装了三件业务层不该重复关心的事：令牌自动刷新与一次重试、错误码到异常的映射、
 * 以及分片上传的完整握手流程。
 */
@Component
public class BaiduPanClient {

    private static final Logger log = LoggerFactory.getLogger(BaiduPanClient.class);

    private static final String API_FILE = "https://pan.baidu.com/rest/2.0/xpan/file";
    private static final String API_MULTIMEDIA = "https://pan.baidu.com/rest/2.0/xpan/multimedia";
    private static final String API_NAS = "https://pan.baidu.com/rest/2.0/xpan/nas";
    private static final String API_QUOTA = "https://pan.baidu.com/api/quota";

    /** filemetas 单次最多查 100 个 fsid */
    private static final int METAS_BATCH = 100;
    /** 列目录单页条数，官方建议不超过 1000 */
    private static final int LIST_PAGE = 1000;
    /** 递归列目录的硬上限，防止异常数据导致无限翻页 */
    private static final int LIST_MAX_ENTRIES = 50_000;

    private final BaiduHttp http;
    private final BaiduTokenStore tokens;
    private final BaiduPanProperties props;

    public BaiduPanClient(BaiduHttp http, BaiduTokenStore tokens, BaiduPanProperties props) {
        this.http = http;
        this.tokens = tokens;
        this.props = props;
    }

    // ------------------------------------------------------------------ 账号

    public Uinfo uinfo() {
        return withAuthRetry(token -> {
            Uinfo r = http.getJson(API_NAS + "?" + BaiduHttp.query(BaiduHttp.params(
                    "method", "uinfo", "access_token", token)), Uinfo.class);
            check(r.errno(), r.errmsg(), "查询账号信息");
            return r;
        });
    }

    public Quota quota() {
        return withAuthRetry(token -> {
            Quota r = http.getJson(API_QUOTA + "?" + BaiduHttp.query(BaiduHttp.params(
                    "access_token", token, "checkfree", "1", "checkexpire", "1")), Quota.class);
            check(r.errno(), r.errmsg(), "查询容量");
            return r;
        });
    }

    // ------------------------------------------------------------------ 目录

    /** 列一层目录，自动翻页取全。 */
    public List<FsEntry> listAll(String dir) {
        List<FsEntry> all = new ArrayList<>();
        int start = 0;
        while (true) {
            final int s = start;
            ListResp page = withAuthRetry(token -> {
                ListResp r = http.getJson(API_FILE + "?" + BaiduHttp.query(BaiduHttp.params(
                        "method", "list",
                        "access_token", token,
                        "dir", dir,
                        "order", "name",
                        "start", String.valueOf(s),
                        "limit", String.valueOf(LIST_PAGE),
                        "web", "1")), ListResp.class);
                check(r.errno(), r.errmsg(), "列出目录 " + dir);
                return r;
            });

            List<FsEntry> batch = page.list() == null ? List.of() : page.list();
            all.addAll(batch);
            if (batch.size() < LIST_PAGE || all.size() >= LIST_MAX_ENTRIES) {
                break;
            }
            start += LIST_PAGE;
        }
        return all;
    }

    /**
     * 递归列出目录下所有条目（含子目录本身）。用 BFS 逐层展开，
     * 比 search 接口更可预测，也不会被索引延迟影响。
     */
    public List<FsEntry> listRecursive(String rootDir) {
        List<FsEntry> result = new ArrayList<>();
        List<FsEntry> dirs = new ArrayList<>();
        dirs.add(FsEntry.ofDir(rootDir));
        while (!dirs.isEmpty()) {
            FsEntry dir = dirs.remove(0);
            List<FsEntry> children;
            try {
                children = listAll(dir.path());
            } catch (BaiduPanException e) {
                if (e.isNotFound()) {
                    log.warn("目录不存在，跳过：{}", dir.path());
                    continue;
                }
                throw e;
            }
            for (FsEntry child : children) {
                result.add(child);
                if (child.isDir()) {
                    dirs.add(child);
                }
                if (result.size() >= LIST_MAX_ENTRIES) {
                    log.warn("条目数达到上限 {}，提前结束遍历", LIST_MAX_ENTRIES);
                    return result;
                }
            }
        }
        return result;
    }

    public void mkdir(String path) {
        withAuthRetry(token -> {
            CreateResp r = http.postForm(API_FILE + "?" + BaiduHttp.query(BaiduHttp.params(
                    "method", "create", "access_token", token)),
                    BaiduHttp.params("path", path, "isdir", "1", "size", "0", "rtype", "0"),
                    CreateResp.class);
            // 已经存在不算失败，调用方通常只关心「目录可用」
            if (r.errno() == BaiduErrno.ALREADY_EXISTS) {
                return r;
            }
            check(r.errno(), r.errmsg(), "创建目录 " + path);
            return r;
        });
    }

    // ------------------------------------------------------------------ 元数据

    /** 按 fsid 批量查元数据。dlink/thumb/extra 决定百度是否返回下载地址、缩略图、图片宽高。 */
    public List<FileMeta> fileMetas(List<Long> fsIds, boolean withDlink, boolean withThumb, boolean withExtra) {
        List<FileMeta> out = new ArrayList<>();
        for (int i = 0; i < fsIds.size(); i += METAS_BATCH) {
            List<Long> batch = fsIds.subList(i, Math.min(i + METAS_BATCH, fsIds.size()));
            FileMetasResp r = withAuthRetry(token -> {
                FileMetasResp resp = http.getJson(API_MULTIMEDIA + "?" + BaiduHttp.query(BaiduHttp.params(
                        "method", "filemetas",
                        "access_token", token,
                        "fsids", toJsonArray(batch),
                        "dlink", withDlink ? "1" : "0",
                        "thumb", withThumb ? "1" : "0",
                        "extra", withExtra ? "1" : "0")), FileMetasResp.class);
                check(resp.errno(), resp.errmsg(), "查询文件元数据");
                return resp;
            });
            if (r.list() != null) {
                out.addAll(r.list());
            }
        }
        return out;
    }

    public FileMeta fileMeta(long fsId) {
        List<FileMeta> l = fileMetas(List.of(fsId), true, true, true);
        return l.isEmpty() ? null : l.get(0);
    }

    /**
     * 按路径查元数据。用于刚上传完、还没写进本地索引的文件。
     * <p>
     * 这里刻意不用官方的 method=meta 接口——它没在实测范围内，返回结构不确定。
     * 走已验证的「列父目录 + filemetas」组合，慢一点但结果确定。
     */
    public FileMeta metaByPath(String path, boolean withDlink, boolean withThumb) {
        int slash = path.lastIndexOf('/');
        String parent = slash <= 0 ? "/" : path.substring(0, slash);
        for (FsEntry entry : listAll(parent)) {
            if (!entry.isDir() && path.equals(entry.path())) {
                List<FileMeta> metas = fileMetas(List.of(entry.fsId()), withDlink, withThumb, true);
                return metas.isEmpty() ? null : metas.get(0);
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ 上传

    /**
     * 完整上传一个本地文件。流程：precreate → 逐片 superfile2 → create。
     * <p>
     * 分片必须串行上传，百度官方明确不支持并行分片。
     *
     * @param overwrite true 时同名覆盖（rtype=3），false 时同名报错
     */
    public CreateResp upload(String remotePath, Path localFile, boolean overwrite) {
        long size;
        try {
            size = Files.size(localFile);
        } catch (IOException e) {
            throw new BaiduPanException("读取待上传文件失败：" + e.getMessage(), e);
        }
        if (size <= 0) {
            throw new BaiduPanException("不允许上传空文件：" + remotePath, null);
        }

        String rtype = overwrite ? "3" : "0";
        List<String> blockMd5 = computeBlockMd5(localFile, size);

        // 1) 预上传
        PrecreateResp pre = withAuthRetry(token -> {
            PrecreateResp r = http.postForm(API_FILE + "?" + BaiduHttp.query(BaiduHttp.params(
                    "method", "precreate", "access_token", token)),
                    BaiduHttp.params(
                            "path", remotePath,
                            "size", String.valueOf(size),
                            "isdir", "0",
                            "block_list", toJsonArray(blockMd5),
                            "autoinit", "1",
                            "rtype", rtype),
                    PrecreateResp.class);
            check(r.errno(), r.errmsg(), "预上传 " + remotePath);
            return r;
        });

        if (pre.uploadid() == null || pre.uploadid().isBlank()) {
            throw new BaiduPanException("预上传未返回 uploadid：" + remotePath, null);
        }

        // 2) 判断要传哪些分片。
        //    实测 return_type=1 + block_list=[0] 表示「需要上传第 0 片」，不是秒传，
        //    所以只以 block_list 为准；只有 return_type=2 才是云端已有内容。
        List<Integer> need = pre.blockList();
        if (need == null || need.isEmpty()) {
            if (pre.returnType() != null && pre.returnType() == 2) {
                need = List.of();
            } else {
                need = allIndices(blockMd5.size());
            }
        }

        for (int seq : need) {
            if (seq < 0 || seq >= blockMd5.size()) {
                throw new BaiduPanException("百度要求上传的分片序号越界：%d".formatted(seq), null);
            }
            uploadSlice(remotePath, pre.uploadid(), seq, localFile, size);
        }

        // 3) 创建文件，拿 fs_id
        return withAuthRetry(token -> {
            CreateResp r = http.postForm(API_FILE + "?" + BaiduHttp.query(BaiduHttp.params(
                    "method", "create", "access_token", token)),
                    BaiduHttp.params(
                            "path", remotePath,
                            "size", String.valueOf(size),
                            "isdir", "0",
                            "block_list", toJsonArray(blockMd5),
                            "uploadid", pre.uploadid(),
                            "rtype", rtype),
                    CreateResp.class);
            check(r.errno(), r.errmsg(), "创建文件 " + remotePath);
            return r;
        });
    }

    private void uploadSlice(String remotePath, String uploadId, int seq, Path localFile, long totalSize) {
        long from = (long) seq * props.sliceSize();
        long to = Math.min(from + props.sliceSize(), totalSize);
        byte[] chunk;
        try (InputStream in = Files.newInputStream(localFile)) {
            in.skipNBytes(from);
            chunk = in.readNBytes((int) (to - from));
        } catch (IOException e) {
            throw new BaiduPanException("读取分片 %d 失败：%s".formatted(seq, e.getMessage()), e);
        }

        String url = props.uploadHost() + "/rest/2.0/pcs/superfile2?" + BaiduHttp.query(BaiduHttp.params(
                "method", "upload",
                "access_token", tokens.accessToken(),
                "type", "tmpfile",
                "path", remotePath,
                "uploadid", uploadId,
                "partseq", String.valueOf(seq)));

        SliceResp resp = http.postMultipart(url, "file", remotePath, chunk, SliceResp.class);
        // 成功响应没有 errno，只有 md5，所以用 isSuccess() 判断
        if (!resp.isSuccess()) {
            String msg = resp.errmsg() == null ? BaiduErrno.describe(resp.errno() == null ? -1 : resp.errno()) : resp.errmsg();
            throw new BaiduPanException(resp.errno() == null ? -1 : resp.errno(),
                    "上传分片 %d 失败：%s".formatted(seq, msg));
        }
        if (!chunkMd5(chunk).equalsIgnoreCase(resp.md5())) {
            throw new BaiduPanException(BaiduErrno.SLICE_MISMATCH,
                    "分片 %d 校验不一致：本地 %s，云端 %s".formatted(seq, chunkMd5(chunk), resp.md5()));
        }
    }

    // ------------------------------------------------------------------ 文件管理

    /** 删除文件或目录。目录会被递归删除。 */
    public void delete(List<String> paths) {
        if (paths == null || paths.isEmpty()) {
            return;
        }
        FileManagerResp r = withAuthRetry(token -> http.postForm(
                API_FILE + "?" + BaiduHttp.query(BaiduHttp.params(
                        "method", "filemanager", "access_token", token, "opera", "delete")),
                BaiduHttp.params("async", "0", "filelist", toJsonArray(paths)),
                FileManagerResp.class));

        if (r.errno() == BaiduErrno.OK) {
            return;
        }
        if (r.errno() == BaiduErrno.PARTIAL_FAILURE && r.info() != null) {
            // 逐个看失败原因，-9 视为已经不存在，不算错误
            List<String> hardFailures = new ArrayList<>();
            for (FileManagerResp.FileManagerInfo info : r.info()) {
                if (info.errno() != BaiduErrno.OK && info.errno() != BaiduErrno.NOT_FOUND) {
                    hardFailures.add("%s(errno=%d)".formatted(info.path(), info.errno()));
                }
            }
            if (hardFailures.isEmpty()) {
                return;
            }
            throw new BaiduPanException(BaiduErrno.PARTIAL_FAILURE,
                    "部分文件删除失败：" + String.join(", ", hardFailures));
        }
        throw BaiduPanException.of(r.errno(), r.errmsg(), "删除");
    }

    /**
     * 重命名。
     * <p>
     * 注意：实测重命名会让百度重新分配 fs_id，调用方不能用旧 fs_id 继续引用这个文件，
     * 必须重新查一次元数据。
     */
    public void rename(String path, String newName) {
        FileManagerResp r = withAuthRetry(token -> http.postForm(
                API_FILE + "?" + BaiduHttp.query(BaiduHttp.params(
                        "method", "filemanager", "access_token", token, "opera", "rename")),
                BaiduHttp.params("async", "0", "filelist",
                        toJsonArray(List.of(Map.of("path", path, "newname", newName, "ondup", "fail")))),
                FileManagerResp.class));
        check(r.errno(), r.errmsg(), "重命名 " + path);
    }

    // ------------------------------------------------------------------ 下载

    /** 打开原图下载流。rangeHeader 形如 "bytes=0-1023"，可为 null。 */
    public BaiduHttp.RemoteStream openDlink(String dlink, String rangeHeader) {
        String url = BaiduHttp.withToken(dlink, tokens.accessToken());
        return http.openStream(url, rangeHeader);
    }

    /** 取回官方缩略图字节。url 直接来自 filemetas 的 thumbs 字段，同样需要 access_token 和 UA。 */
    public byte[] fetchThumb(String thumbUrl, int maxBytes) {
        String url = BaiduHttp.withToken(thumbUrl, tokens.accessToken());
        return http.getBytes(url, maxBytes);
    }

    // ------------------------------------------------------------------ 内部工具

    private interface TokenCall<T> {
        T apply(String token);
    }

    /**
     * 统一鉴权重试：出错且判断是令牌失效时，强制刷新一次再重试。
     * 刷新失败会抛出 errno=-6 的异常，上层据此提示用户重新授权。
     */
    private <T> T withAuthRetry(TokenCall<T> action) {
        String token = tokens.accessToken();
        try {
            return action.apply(token);
        } catch (BaiduPanException e) {
            if (!e.isAuthFailure()) {
                throw e;
            }
            log.info("access_token 失效，刷新后重试一次");
            String fresh = tokens.forceRefresh();
            return action.apply(fresh);
        }
    }

    private static void check(int errno, String errmsg, String action) {
        if (errno != BaiduErrno.OK) {
            throw BaiduPanException.of(errno, errmsg, action);
        }
    }

    private List<String> computeBlockMd5(Path file, long size) {
        try {
            if (size <= props.sliceSize()) {
                return List.of(md5OfRange(file, 0, size));
            }
            List<String> out = new ArrayList<>();
            for (long off = 0; off < size; off += props.sliceSize()) {
                out.add(md5OfRange(file, off, Math.min(off + props.sliceSize(), size)));
            }
            return out;
        } catch (IOException e) {
            throw new BaiduPanException("计算文件校验值失败：" + e.getMessage(), e);
        }
    }

    private String md5OfRange(Path file, long from, long to) throws IOException {
        MessageDigest md = newDigest();
        try (InputStream in = Files.newInputStream(file)) {
            in.skipNBytes(from);
            byte[] buf = new byte[64 * 1024];
            long remaining = to - from;
            while (remaining > 0) {
                int want = (int) Math.min(buf.length, remaining);
                int read = in.read(buf, 0, want);
                if (read < 0) {
                    break;
                }
                md.update(buf, 0, read);
                remaining -= read;
            }
        }
        return HexFormat.of().formatHex(md.digest());
    }

    private static String chunkMd5(byte[] data) {
        MessageDigest md = newDigest();
        md.update(data);
        return HexFormat.of().formatHex(md.digest());
    }

    private static MessageDigest newDigest() {
        try {
            return MessageDigest.getInstance("MD5");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("JVM 不支持 MD5", e);
        }
    }

    private static List<Integer> allIndices(int n) {
        List<Integer> l = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            l.add(i);
        }
        return l;
    }

    private String toJsonArray(List<?> values) {
        try {
            return http.mapper().writeValueAsString(values);
        } catch (Exception e) {
            throw new BaiduPanException("序列化请求参数失败：" + e.getMessage(), e);
        }
    }
}
