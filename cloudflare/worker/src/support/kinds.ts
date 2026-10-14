/**
 * 文件大类推导。与 Java 版 FileKinds 同一套规则：
 * 百度 category 只有 7 个粗粒度值且大量文件归到「其他」，所以扩展名优先、category 兜底。
 */
export type AssetKind = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOC' | 'OTHER'

export const ALL_KINDS: AssetKind[] = ['IMAGE', 'VIDEO', 'AUDIO', 'DOC', 'OTHER']

export const KIND_LABELS: Record<AssetKind, string> = {
  IMAGE: '图片',
  VIDEO: '视频',
  AUDIO: '音频',
  DOC: '文档',
  OTHER: '其他',
}

export const KIND_ICONS: Record<AssetKind, string> = {
  IMAGE: 'Picture',
  VIDEO: 'VideoCamera',
  AUDIO: 'Headset',
  DOC: 'Document',
  OTHER: 'Files',
}

export const KIND_TAG_TYPES: Record<AssetKind, string> = {
  IMAGE: 'success',
  VIDEO: 'warning',
  AUDIO: 'primary',
  DOC: 'info',
  OTHER: '',
}

const VIDEO_EXTS = new Set([
  'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg',
  '3gp', 'ts', 'rmvb', 'rm', 'vob', 'm2ts', 'f4v',
])

const AUDIO_EXTS = new Set([
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'ape', 'opus', 'aiff', 'mid', 'midi',
])

const DOC_EXTS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'markdown',
  'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'html', 'htm', 'rtf',
  'epub', 'mobi', 'azw3', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key',
])

export const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif',
])

/** 小写扩展名，不含点 */
export function extensionOf(filename: string | null | undefined): string {
  if (!filename) return ''
  const slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'))
  const dot = filename.lastIndexOf('.')
  if (dot < 0 || dot <= slash || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

export function isImageFilename(filename: string): boolean {
  return IMAGE_EXTS.has(extensionOf(filename))
}

export function kindOf(category: number | null | undefined, filename: string): AssetKind {
  const ext = extensionOf(filename)
  if (ext) {
    if (IMAGE_EXTS.has(ext)) return 'IMAGE'
    if (VIDEO_EXTS.has(ext)) return 'VIDEO'
    if (AUDIO_EXTS.has(ext)) return 'AUDIO'
    if (DOC_EXTS.has(ext)) return 'DOC'
  }
  switch (category) {
    case 1: return 'VIDEO'
    case 2: return 'AUDIO'
    case 3: return 'IMAGE'
    case 4: return 'DOC'
    default: return 'OTHER'
  }
}

export function isValidKind(value: string): value is AssetKind {
  return (ALL_KINDS as string[]).includes(value)
}

/** 只有图片和视频值得去取百度缩略图 */
export function hasThumbnail(kind: AssetKind): boolean {
  return kind === 'IMAGE' || kind === 'VIDEO'
}

/** 点击卡片走预览还是播放 */
export function isPlayable(kind: AssetKind): boolean {
  return kind === 'VIDEO' || kind === 'AUDIO'
}
