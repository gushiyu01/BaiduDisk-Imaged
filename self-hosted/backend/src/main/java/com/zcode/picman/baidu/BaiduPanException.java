package com.zcode.picman.baidu;

/**
 * 调用百度网盘开放平台失败。区分「授权失效」和「其他失败」，便于上层决定是提示重新授权还是提示重试。
 */
public class BaiduPanException extends RuntimeException {

    private final int errno;

    public BaiduPanException(int errno, String message) {
        super(message);
        this.errno = errno;
    }

    public BaiduPanException(String message, Throwable cause) {
        super(message, cause);
        this.errno = Integer.MIN_VALUE;
    }

    public int getErrno() {
        return errno;
    }

    /** 授权失效，需要用户重新走 OAuth */
    public boolean isAuthFailure() {
        return errno == BaiduErrno.INVALID_TOKEN;
    }

    public boolean isNotFound() {
        return errno == BaiduErrno.NOT_FOUND || errno == BaiduErrno.BAD_PATH;
    }

    public boolean isQuotaExceeded() {
        return errno == BaiduErrno.QUOTA_EXCEEDED;
    }

    /** 下载链接过期或签名失效，重新获取 dlink 后重试即可 */
    public boolean isDlinkStale() {
        return errno == BaiduErrno.DLINK_EXPIRED || errno == BaiduErrno.BAD_SIGNATURE;
    }

    public static BaiduPanException of(int errno, String errmsg, String action) {
        String detail = (errmsg == null || errmsg.isBlank()) ? BaiduErrno.describe(errno) : errmsg;
        return new BaiduPanException(errno, "%s 失败：%s (errno=%d)".formatted(action, detail, errno));
    }
}
