import { leaderOrigin, type CalloutLabel, type CalloutStyle } from '../drawing/illustration'
import type { Rect } from '../drawing/sheet'

export const LABEL_FONT_FAMILY = '"Segoe UI", "Noto Sans TC", "Microsoft JhengHei", "PingFang TC", Arial, sans-serif'
export const labelFont = (size: number) => `bold ${size}px ${LABEL_FONT_FAMILY}`
const FOOTER_FONT = (size: number) => `${size}px ${LABEL_FONT_FAMILY}`

/** 下方說明列的高度（示意圖像素） */
export const FOOTER_HEIGHT = 46

let measureCtx: CanvasRenderingContext2D | null | undefined

/** 量標註文字的寬度（示意圖像素） */
export function measureLabel(text: string, size: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * size * 0.62
  measureCtx.font = labelFont(size)
  return measureCtx.measureText(text).width
}

export interface IllustrationPaint {
  /** 要畫的範圍（示意圖像素）：預覽是整張，輸出時裁到內容 */
  view: Rect
  image: Rect
  base: CanvasImageSource
  labels: readonly CalloutLabel[]
  style: CalloutStyle
  /** 下方說明列：左邊模組資訊、右邊公司名稱（加在 view 下方） */
  footer?: { left: string; right?: string }
  /** 預覽時標示滑過或拖曳中的標註 */
  active?: string
}

/** 畫出示意圖：白底、零件圖、引線與箭頭、型號文字（白邊，壓在零件上也看得清楚） */
export function paintIllustration(ctx: CanvasRenderingContext2D, p: IllustrationPaint, scale: number) {
  const { view } = p
  const totalH = view.h + (p.footer ? FOOTER_HEIGHT : 0)
  ctx.save()
  ctx.setTransform(scale, 0, 0, scale, -view.x * scale, -view.y * scale)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(view.x, view.y, view.w, totalH)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(p.base, p.image.x, p.image.y, p.image.w, p.image.h)

  // 引線＋箭頭
  ctx.lineCap = 'round'
  for (const l of p.labels) {
    const o = leaderOrigin(l)
    const active = l.key === p.active
    ctx.strokeStyle = active ? '#2563eb' : '#111827'
    ctx.fillStyle = ctx.strokeStyle
    ctx.lineWidth = active ? 2.6 : 2
    for (const a of l.anchors) {
      const dx = a[0] - o[0]
      const dy = a[1] - o[1]
      const len = Math.hypot(dx, dy) || 1
      const ux = dx / len
      const uy = dy / len
      const head = Math.min(15, len * 0.45)
      const half = head * 0.38
      const bx = a[0] - ux * head
      const by = a[1] - uy * head
      ctx.beginPath()
      ctx.moveTo(o[0], o[1])
      ctx.lineTo(bx, by)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(bx - uy * half, by + ux * half)
      ctx.lineTo(bx + uy * half, by - ux * half)
      ctx.closePath()
      ctx.fill()
    }
  }

  // 型號文字
  ctx.font = labelFont(p.style.font)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  for (const l of p.labels) {
    const cx = l.x + l.w / 2
    const cy = l.y + l.h / 2
    if (l.key === p.active) {
      ctx.fillStyle = 'rgba(37, 99, 235, 0.10)'
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.6)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.roundRect(l.x - 2, l.y - 2, l.w + 4, l.h + 4, 6)
      ctx.fill()
      ctx.stroke()
    }
    ctx.strokeStyle = '#ffffff'
    // 白邊隨字高縮放（預設字高 26 時為 6）
    ctx.lineWidth = Math.max(3, p.style.font * 0.23)
    ctx.strokeText(l.text, cx, cy + 1)
    ctx.fillStyle = '#111827'
    ctx.fillText(l.text, cx, cy + 1)
  }

  if (p.footer) {
    const y = view.y + view.h + FOOTER_HEIGHT / 2
    ctx.strokeStyle = '#cbd5e1'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(view.x + 16, view.y + view.h + 4)
    ctx.lineTo(view.x + view.w - 16, view.y + view.h + 4)
    ctx.stroke()
    ctx.font = FOOTER_FONT(17)
    ctx.fillStyle = '#334155'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillText(p.footer.left, view.x + 18, y)
    if (p.footer.right) {
      ctx.textAlign = 'right'
      ctx.fillStyle = '#64748b'
      ctx.fillText(p.footer.right, view.x + view.w - 18, y)
    }
  }
  ctx.restore()
}

/** 畫成 PNG（scale 倍解析度） */
export function illustrationPng(p: IllustrationPaint, scale: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(p.view.w * scale)
  canvas.height = Math.round((p.view.h + (p.footer ? FOOTER_HEIGHT : 0)) * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('瀏覽器無法產生圖片'))
  paintIllustration(ctx, p, scale)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('圖片產生失敗'))), 'image/png'))
}
