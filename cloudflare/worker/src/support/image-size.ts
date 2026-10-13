/**
 * 从图片文件头解析宽高。
 *
 * 为什么要自己解析：百度 filemetas 的 extra=1 不保证返回 width/height
 * （实测同一个文件时有时无），所以拿不到时得自己解。
 * Java 版靠 ImageIO 解，Worker 里没有，只能读头。
 *
 * 只需要文件开头的一小段（各格式的尺寸信息都在前面），不必下载整张图。
 * 支持 PNG / JPEG / GIF / WebP / BMP —— 覆盖图库里绝大多数文件。
 */

export interface ImageSize {
  width: number
  height: number
}

/** 各格式判定需要的最小字节数 */
export const HEADER_PROBE_BYTES = 64 * 1024

export function parseImageSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 16) return null
  try {
    if (isPng(bytes)) return pngSize(bytes)
    if (isJpeg(bytes)) return jpegSize(bytes)
    if (isGif(bytes)) return gifSize(bytes)
    if (isWebp(bytes)) return webpSize(bytes)
    if (isBmp(bytes)) return bmpSize(bytes)
  } catch {
    // 头部不完整或格式异常，交给调用方兜底
  }
  return null
}

const ascii = (b: Uint8Array, offset: number, text: string): boolean => {
  if (offset + text.length > b.length) return false
  for (let i = 0; i < text.length; i++) {
    if (b[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

function isPng(b: Uint8Array): boolean {
  return b[0] === 0x89 && ascii(b, 1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a
}

/** PNG：IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后，宽高各 4 字节大端 */
function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function isJpeg(b: Uint8Array): boolean {
  return b[0] === 0xff && b[1] === 0xd8
}

/**
 * JPEG：从头开始扫标记段，找 SOF0~SOF15（排除 DHT=0xC4 / JPG=0xC8 / DAC=0xCC），
 * SOF 段里就是高宽（各 2 字节大端，高位在前的是高度）。
 */
function jpegSize(b: Uint8Array): ImageSize | null {
  let offset = 2
  while (offset + 3 < b.length) {
    if (b[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = b[offset + 1]
    // 填充字节
    if (marker === 0xff) {
      offset++
      continue
    }
    // 无长度字段的标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = (b[offset + 2] << 8) | b[offset + 3]
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (offset + 9 >= b.length) return null
      const height = (b[offset + 5] << 8) | b[offset + 6]
      const width = (b[offset + 7] << 8) | b[offset + 8]
      return { width, height }
    }
    // 扫描段之后就是熵编码数据，再往后没有尺寸信息了
    if (marker === 0xda) return null
    if (length < 2) return null
    offset += 2 + length
  }
  return null
}

function isGif(b: Uint8Array): boolean {
  return ascii(b, 0, 'GIF8')
}

/** GIF：逻辑屏幕宽高在固定偏移，小端 */
function gifSize(b: Uint8Array): ImageSize | null {
  if (b.length < 10) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
}

function isWebp(b: Uint8Array): boolean {
  return ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')
}

/** WebP 有三种子格式，尺寸位置各不相同 */
function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 30) return null
  const chunk = String.fromCharCode(b[12], b[13], b[14], b[15])

  if (chunk === 'VP8X') {
    // 扩展格式：宽高为 24 位小端，存的是「值 - 1」
    const w = b[24] | (b[25] << 8) | (b[26] << 16)
    const h = b[27] | (b[28] << 8) | (b[29] << 16)
    return { width: w + 1, height: h + 1 }
  }
  if (chunk === 'VP8L') {
    // 无损：14 位宽 + 14 位高，打包在 4 字节里
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8 ') {
    // 有损：关键帧头里，宽高各 2 字节小端（低 14 位有效）
    if (b.length < 30) return null
    const w = (b[26] | (b[27] << 8)) & 0x3fff
    const h = (b[28] | (b[29] << 8)) & 0x3fff
    return { width: w, height: h }
  }
  return null
}

function isBmp(b: Uint8Array): boolean {
  return b[0] === 0x42 && b[1] === 0x4d
}

/** BMP：DIB 头里宽高各 4 字节小端（高度可能是负数表示自上而下） */
function bmpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 26) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) }
}
