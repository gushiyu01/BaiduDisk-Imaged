/** 文件扩展名 → MIME。决定浏览器内联显示还是下载，必须稳定，不用平台的猜测。 */
const BY_EXT: Record<string, string> = {
  // 图片
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff',
  tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  svg: 'image/svg+xml', ico: 'image/x-icon',
  // 视频
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', webm: 'video/webm', wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp',
  ts: 'video/mp2t', rmvb: 'application/vnd.rn-realmedia-vbr',
  // 这几个也在 VIDEO_EXTS 里（会被当成可播放的视频），表里必须有条目，
  // 否则 /raw 一律按 octet-stream 强制下载 —— 明明浏览器能放却被下载
  m2ts: 'video/mp2t', f4v: 'video/mp4', vob: 'video/mpeg',
  rm: 'application/vnd.rn-realmedia',
  // 音频
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
  ogg: 'audio/ogg', m4a: 'audio/mp4', wma: 'audio/x-ms-wma', opus: 'audio/opus',
  ape: 'audio/x-ape', aiff: 'audio/aiff', mid: 'audio/midi', midi: 'audio/midi',
  // 文档
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', xml: 'application/xml', yaml: 'application/yaml',
  yml: 'application/yaml', html: 'text/html', htm: 'text/html', rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
  // 压缩包
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip',
}

export const OCTET_STREAM = 'application/octet-stream'

export function mimeFromFilename(filename: string | null | undefined, ext: string): string {
  void filename
  return BY_EXT[ext] ?? OCTET_STREAM
}

/**
 * 能不能让浏览器在本应用的同源下内联打开。
 *
 * 只有图片（不含 SVG）、视频、音频、PDF 算安全：SVG 和 HTML 一样，
 * 顶层打开就能执行脚本，脚本拿着用户的会话可以调用全部管理接口。
 * 其余类型必须强制下载（或至少不给可执行的内容类型）。
 */
export function isInlineSafeMime(mime: string): boolean {
  const type = mime.split(';')[0].trim().toLowerCase()
  if (type === 'application/pdf') return true
  // image/svg+xml 以及各种写法的 svg 变体（image/svg 等）一律不放行
  if (type.startsWith('image/')) return !type.includes('svg')
  return type.startsWith('video/') || type.startsWith('audio/')
}

/** 按魔数判断，不信文件名也不信上游 Content-Type */
export function detectImageMime(bytes: Uint8Array): string {
  if (bytes.length < 4) return OCTET_STREAM
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  return OCTET_STREAM
}
