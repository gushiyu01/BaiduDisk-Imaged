/**
 * 百度网盘开放平台业务错误码。
 * 只收录本项目实际处理和实测验证过的，释义与 Java 版保持一致。
 */
export const ERRNO = {
  OK: 0,
  /** access_token 无效或已过期 */
  INVALID_TOKEN: -6,
  BAD_PATH: -7,
  ALREADY_EXISTS: -8,
  NOT_FOUND: -9,
  QUOTA_EXCEEDED: -10,
  PARTIAL_FAILURE: 12,
  OUT_OF_APP_DIR: 20011,
  NO_UPLOAD_PERMISSION: 31024,
  BAD_SLICE_SIZE: 31299,
  /** 命中防盗链，通常是 User-Agent 不是 pan.baidu.com */
  HOTLINK_BLOCKED: 31326,
  /** 下载链接过期，重新取 dlink 即可 */
  DLINK_EXPIRED: 31360,
  BAD_SIGNATURE: 31362,
  SLICE_MISMATCH: 31363,
  SLICE_TOO_LARGE: 31364,
  FILE_TOO_LARGE: 31365,
} as const

export function describeErrno(errno: number): string {
  switch (errno) {
    case ERRNO.OK: return '成功'
    case ERRNO.INVALID_TOKEN: return '身份验证失败，access_token 无效或已过期'
    case ERRNO.BAD_PATH: return '文件或目录名非法，或无权访问'
    case ERRNO.ALREADY_EXISTS: return '文件已存在'
    case ERRNO.NOT_FOUND: return '文件或目录不存在'
    case ERRNO.QUOTA_EXCEEDED: return '网盘容量不足'
    case ERRNO.PARTIAL_FAILURE: return '批量操作部分失败'
    case ERRNO.OUT_OF_APP_DIR: return '超出应用可访问目录范围'
    case ERRNO.NO_UPLOAD_PERMISSION: return '无上传权限'
    case ERRNO.BAD_SLICE_SIZE: return '上传分片大小不符合要求'
    case ERRNO.HOTLINK_BLOCKED: return '命中防盗链限制'
    case ERRNO.DLINK_EXPIRED: return '下载链接已过期'
    case ERRNO.BAD_SIGNATURE: return '下载签名错误'
    case ERRNO.SLICE_MISMATCH: return '上传分片缺失或不匹配'
    case ERRNO.SLICE_TOO_LARGE: return '分片超过当前会员档位上限'
    case ERRNO.FILE_TOO_LARGE: return '文件大小超过上限'
    default: return `未知错误码 ${errno}`
  }
}
