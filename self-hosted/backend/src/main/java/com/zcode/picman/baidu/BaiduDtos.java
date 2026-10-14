package com.zcode.picman.baidu;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.Map;

/**
 * 百度网盘开放平台的响应对象。
 * <p>
 * 字段以实测响应为准，不是照抄文档：例如分片上传成功时只返回 {md5, request_id}，没有 errno，
 * 所以 SliceResp.errno 是可空类型，判断成功不能只看 errno==0。
 */
public final class BaiduDtos {

    private BaiduDtos() {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record TokenResp(
            @JsonProperty("access_token") String accessToken,
            @JsonProperty("refresh_token") String refreshToken,
            @JsonProperty("expires_in") Long expiresIn,
            String scope,
            String error,
            @JsonProperty("error_description") String errorDescription
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Uinfo(
            int errno,
            String errmsg,
            @JsonProperty("baidu_name") String baiduName,
            @JsonProperty("netdisk_name") String netdiskName,
            @JsonProperty("avatar_url") String avatarUrl,
            @JsonProperty("vip_type") Integer vipType,
            Long uk
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Quota(
            int errno,
            String errmsg,
            Long total,
            Long used,
            Long free
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record FsEntry(
            @JsonProperty("fs_id") Long fsId,
            String path,
            @JsonProperty("server_filename") String serverFilename,
            Long size,
            Integer isdir,
            Integer category,
            String md5,
            @JsonProperty("server_mtime") Long serverMtime,
            @JsonProperty("server_ctime") Long serverCtime,
            Map<String, String> thumbs,
            Integer width,
            Integer height
    ) {
        public boolean isDir() {
            return isdir != null && isdir == 1;
        }

        /** 构造一个仅用于 BFS 占位的目录条目 */
        public static FsEntry ofDir(String path) {
            return new FsEntry(null, path, null, 0L, 1, 6, null, null, null, null, null, null);
        }

        public String name() {
            if (serverFilename != null && !serverFilename.isBlank()) {
                return serverFilename;
            }
            int i = path == null ? -1 : path.lastIndexOf('/');
            return i < 0 ? String.valueOf(path) : path.substring(i + 1);
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ListResp(
            int errno,
            String errmsg,
            List<FsEntry> list,
            @JsonProperty("request_id") Long requestId
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record FileMeta(
            @JsonProperty("fs_id") Long fsId,
            String path,
            @JsonProperty("server_filename") String serverFilename,
            Long size,
            String md5,
            Integer category,
            String dlink,
            Map<String, String> thumbs,
            Integer width,
            Integer height,
            Integer errno
    ) {
        /** 优先取清晰度最高的缩略图。实测百度返回 icon / url1 / url2 / url3 / url4。 */
        public String bestThumbUrl() {
            if (thumbs == null || thumbs.isEmpty()) {
                return null;
            }
            for (String key : new String[]{"url4", "url3", "url2", "url1", "icon"}) {
                String v = thumbs.get(key);
                if (v != null && !v.isBlank()) {
                    return v;
                }
            }
            return thumbs.values().stream().filter(v -> v != null && !v.isBlank()).findFirst().orElse(null);
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record FileMetasResp(
            int errno,
            String errmsg,
            List<FileMeta> list,
            @JsonProperty("request_id") Long requestId
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record PrecreateResp(
            int errno,
            String errmsg,
            String path,
            String uploadid,
            @JsonProperty("return_type") Integer returnType,
            @JsonProperty("block_list") List<Integer> blockList,
            @JsonProperty("fs_id") Long fsId
    ) {
    }

    /** 分片上传响应。成功时百度不返回 errno，只有 md5 和 request_id。 */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record SliceResp(
            String md5,
            @JsonProperty("request_id") Long requestId,
            Integer errno,
            String errmsg
    ) {
        public boolean isSuccess() {
            return (errno == null || errno == BaiduErrno.OK) && md5 != null;
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record CreateResp(
            int errno,
            String errmsg,
            @JsonProperty("fs_id") Long fsId,
            String path,
            Integer category,
            String md5,
            Long size,
            @JsonProperty("server_filename") String serverFilename,
            Long ctime,
            Long mtime
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record FileManagerResp(
            int errno,
            String errmsg,
            List<FileManagerInfo> info,
            @JsonProperty("request_id") Long requestId
    ) {
        @JsonIgnoreProperties(ignoreUnknown = true)
        public record FileManagerInfo(int errno, String path) {
        }
    }
}
