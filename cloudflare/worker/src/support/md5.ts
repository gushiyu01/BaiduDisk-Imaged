/**
 * MD5（RFC 1321）。
 *
 * 为什么自己写：百度的 precreate / create 需要每个 4MB 分片的 MD5 作为 block_list，
 * 而 Web Crypto（crypto.subtle）只支持 SHA 系列，没有 MD5。
 * Worker 里又不能引 Node 的 crypto 模块。
 *
 * 所有内部运算用 >>> 0 保持 32 位无符号语义，避免 JS 位运算的有符号陷阱。
 */

const S = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
])

const K = new Uint32Array(64)
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)
}

const HEX = '0123456789abcdef'

/** 计算 MD5，返回 32 位小写十六进制字符串 */
export function md5(input: Uint8Array): string {
  const len = input.length
  const bitLen = len * 8

  // 填充：0x80 后补 0 到 56 mod 64，再接 8 字节小端长度
  const paddedLength = (((len + 8) >> 6) + 1) << 6
  const buffer = new Uint8Array(paddedLength)
  buffer.set(input)
  buffer[len] = 0x80

  // 长度按 64 位小端写入（高 32 位对 JS 能处理的输入恒为 0，
  // 但分片最大 4MB，这里仍然按规范写全，避免日后调大分片时出错）
  const view = new DataView(buffer.buffer)
  view.setUint32(paddedLength - 8, bitLen >>> 0, true)
  view.setUint32(paddedLength - 4, Math.floor(bitLen / 4294967296), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  const m = new Uint32Array(16)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      m[i] = view.getUint32(offset + i * 4, true)
    }

    let a = a0
    let b = b0
    let c = c0
    let d = d0

    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number

      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }

      const tmp = d
      d = c
      c = b

      const rotated = (((a + f + K[i] + m[g]) >>> 0) << S[i]) | (((a + f + K[i] + m[g]) >>> 0) >>> (32 - S[i]))
      b = (b + (rotated >>> 0)) >>> 0
      a = tmp
    }

    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, a0, true)
  outView.setUint32(4, b0, true)
  outView.setUint32(8, c0, true)
  outView.setUint32(12, d0, true)

  let hex = ''
  for (let i = 0; i < 16; i++) {
    hex += HEX[out[i] >> 4] + HEX[out[i] & 0x0f]
  }
  return hex
}
