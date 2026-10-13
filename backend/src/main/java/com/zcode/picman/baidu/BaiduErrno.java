package com.zcode.picman.baidu;

/**
 * 百度网盘开放平台业务错误码。仅收录本项目实际处理和实测验证过的。
 */
public final class BaiduErrno {

    /** 成功 */
    public static final int OK = 0;

    /** 身份验证失败：access_token 无效或已过期 */
    public static final int INVALID_TOKEN = -6;

    /** 文件或目录名非法 / 无权访问 */
    public static final int BAD_PATH = -7;

    /** 文件已存在 */
    public static final int ALREADY_EXISTS = -8;

    /** 文件或目录不存在 */
    public static final int NOT_FOUND = -9;

    /** 网盘容量不足 */
    public static final int QUOTA_EXCEEDED = -10;

    /** 一次删除/操作部分失败，需看 info[].errno */
    public static final int PARTIAL_FAILURE = 12;

    /** 文件越权访问（官方文档所述 /apps 沙箱限制；实测本应用未触发） */
    public static final int OUT_OF_APP_DIR = 20011;

    /** 无上传权限 */
    public static final int NO_UPLOAD_PERMISSION = 31024;

    /** 上传分片数超限或首片小于 4MB */
    public static final int BAD_SLICE_SIZE = 31299;

    /** 命中防盗链，通常是 User-Agent 不是 pan.baidu.com */
    public static final int HOTLINK_BLOCKED = 31326;

    /** 分享/下载链接已过期，重新获取 dlink 即可 */
    public static final int DLINK_EXPIRED = 31360;

    /** 下载签名错误 */
    public static final int BAD_SIGNATURE = 31362;

    /** 分片缺失或不匹配 */
    public static final int SLICE_MISMATCH = 31363;

    /** 分片大小超过会员档位上限 */
    public static final int SLICE_TOO_LARGE = 31364;

    /** 文件大小超过上限 */
    public static final int FILE_TOO_LARGE = 31365;

    private BaiduErrno() {
    }

    public static String describe(int errno) {
        return switch (errno) {
            case OK -> "成功";
            case INVALID_TOKEN -> "身份验证失败，access_token 无效或已过期";
            case BAD_PATH -> "文件或目录名非法，或无权访问";
            case ALREADY_EXISTS -> "文件已存在";
            case NOT_FOUND -> "文件或目录不存在";
            case QUOTA_EXCEEDED -> "网盘容量不足";
            case PARTIAL_FAILURE -> "批量操作部分失败";
            case OUT_OF_APP_DIR -> "超出应用可访问目录范围";
            case NO_UPLOAD_PERMISSION -> "无上传权限";
            case BAD_SLICE_SIZE -> "上传分片大小不符合要求";
            case HOTLINK_BLOCKED -> "命中防盗链限制";
            case DLINK_EXPIRED -> "下载链接已过期";
            case BAD_SIGNATURE -> "下载签名错误";
            case SLICE_MISMATCH -> "上传分片缺失或不匹配";
            case SLICE_TOO_LARGE -> "分片超过当前会员档位上限";
            case FILE_TOO_LARGE -> "文件大小超过上限";
            default -> "未知错误码 " + errno;
        };
    }
}
