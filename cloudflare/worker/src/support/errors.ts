import { describeErrno, ERRNO } from './errno'

/** 面向浏览器的错误，带 HTTP 状态与错误码 */
export class ApiException extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiException'
  }

  static badRequest(message: string): ApiException {
    return new ApiException(400, 'BAD_REQUEST', message)
  }
  static unauthorized(message: string): ApiException {
    return new ApiException(401, 'UNAUTHORIZED', message)
  }
  static notFound(message: string): ApiException {
    return new ApiException(404, 'NOT_FOUND', message)
  }
  static conflict(message: string): ApiException {
    return new ApiException(409, 'CONFLICT', message)
  }
}

/** 调用百度开放平台失败 */
export class BaiduPanException extends Error {
  constructor(
    readonly errno: number,
    message: string,
  ) {
    super(message)
    this.name = 'BaiduPanException'
  }

  /** 授权失效，需要用户重新走 OAuth */
  get isAuthFailure(): boolean {
    return this.errno === ERRNO.INVALID_TOKEN
  }

  get isNotFound(): boolean {
    return this.errno === ERRNO.NOT_FOUND || this.errno === ERRNO.BAD_PATH
  }

  get isQuotaExceeded(): boolean {
    return this.errno === ERRNO.QUOTA_EXCEEDED
  }

  /** 下载链接过期或签名失效，重新获取 dlink 后重试即可 */
  get isDlinkStale(): boolean {
    return this.errno === ERRNO.DLINK_EXPIRED || this.errno === ERRNO.BAD_SIGNATURE
  }

  static of(errno: number, errmsg: string | undefined, action: string): BaiduPanException {
    const detail = errmsg && errmsg.trim() ? errmsg : describeErrno(errno)
    return new BaiduPanException(errno, `${action} 失败：${detail} (errno=${errno})`)
  }
}
