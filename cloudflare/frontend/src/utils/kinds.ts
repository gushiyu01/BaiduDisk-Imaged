import type { AssetKind } from '../types'

/**
 * 文件类型的展示配置。
 * 卡片、表格、筛选器都用这一份，避免图标和配色在不同页面各写一遍。
 */
export interface KindStyle {
  /** Element Plus 图标组件名（应用里已全局注册） */
  icon: string
  /** el-tag 的 type */
  tagType: string
  /** 瀑布流里没有真实尺寸时用的兜底宽高比 */
  fallbackRatio: number
}

export const KIND_STYLES: Record<AssetKind, KindStyle> = {
  IMAGE: { icon: 'Picture', tagType: 'success', fallbackRatio: 1 },
  VIDEO: { icon: 'VideoCamera', tagType: 'warning', fallbackRatio: 16 / 9 },
  AUDIO: { icon: 'Headset', tagType: 'primary', fallbackRatio: 4 / 3 },
  DOC: { icon: 'Document', tagType: 'info', fallbackRatio: 4 / 3 },
  OTHER: { icon: 'Files', tagType: '', fallbackRatio: 4 / 3 }
}

export function kindStyle(kind: AssetKind): KindStyle {
  return KIND_STYLES[kind] ?? KIND_STYLES.OTHER
}

/** 只有图片和视频有资格去请求缩略图 */
export function isMediaKind(kind: AssetKind): boolean {
  return kind === 'IMAGE' || kind === 'VIDEO'
}

/** 点击卡片应该走预览还是播放 */
export function isPlayableKind(kind: AssetKind): boolean {
  return kind === 'VIDEO' || kind === 'AUDIO'
}
