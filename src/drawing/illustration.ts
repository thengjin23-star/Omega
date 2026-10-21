/**
 * 示意圖：著色的 3D 圖，旁邊標上每個零件的型號，箭頭指向零件；同型號只寫一次、拉多條箭頭。
 * 這裡是與繪圖無關的部分：由 ID 圖找出每個零件看得到的位置、排標註、產生 PDF 圖紙。
 * 座標單位為「示意圖像素」，原點在左上角、y 向下。
 */
import { PAPER, MARGIN, TITLE_BLOCK_HEIGHT, Draw, drawFrame, drawTitleBlock, type Rect, type TitleInfo } from './sheet'
import type { PaperSize } from '../settings/settings'
import type { Pt, Sheet } from './types'

// ---------------------------------------------------------------------------
// ID 圖：每個像素記零件編號（0 = 背景，i + 1 = 第 i 個零件）
// ---------------------------------------------------------------------------

/**
 * 每個零件看得到的「最裡面」的點（離零件邊緣最遠的像素），當作箭頭的落點；
 * 完全被擋住的零件為 undefined。ids 由上而下逐列排列。
 */
export function visibleAnchors(ids: Uint32Array, width: number, height: number, count: number): { anchors: (Pt | undefined)[]; pixels: number[] } {
  const n = width * height
  const INF = 1 << 29
  const dist = new Int32Array(n)
  // 邊緣（上下左右任一鄰居不同，或在圖的外框）= 0，其餘先設成無限大
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const id = ids[i]
      const edge =
        x === 0 || y === 0 || x === width - 1 || y === height - 1 || ids[i - 1] !== id || ids[i + 1] !== id || ids[i - width] !== id || ids[i + width] !== id
      dist[i] = edge ? 0 : INF
    }
  }
  // 兩趟 3-4 倒角距離轉換
  for (let y = 1; y < height; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      if (dist[i] === 0) continue
      dist[i] = Math.min(dist[i], dist[i - 1] + 3, dist[i - width] + 3, dist[i - width - 1] + 4, dist[i - width + 1] + 4)
    }
  }
  for (let y = height - 2; y >= 0; y--) {
    for (let x = width - 2; x >= 1; x--) {
      const i = y * width + x
      if (dist[i] === 0) continue
      dist[i] = Math.min(dist[i], dist[i + 1] + 3, dist[i + width] + 3, dist[i + width + 1] + 4, dist[i + width - 1] + 4)
    }
  }
  const best = new Int32Array(count + 1).fill(-1)
  const bestAt = new Int32Array(count + 1)
  const pixels = new Array<number>(count).fill(0)
  for (let i = 0; i < n; i++) {
    const id = ids[i]
    if (id === 0 || id > count) continue
    pixels[id - 1]++
    if (dist[i] > best[id]) {
      best[id] = dist[i]
      bestAt[id] = i
    }
  }
  const anchors = pixels.map((p, k): Pt | undefined => {
    if (!p) return undefined
    const i = bestAt[k + 1]
    return [(i % width) + 0.5, Math.floor(i / width) + 0.5]
  })
  return { anchors, pixels }
}

/** 零件輪廓：與右邊或下面的像素屬於不同零件（或背景）的位置，兩側都標記 */
export function outlineMask(ids: Uint32Array, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const id = ids[i]
      if (x + 1 < width && ids[i + 1] !== id) {
        if (id) mask[i] = 1
        if (ids[i + 1]) mask[i + 1] = 1
      }
      if (y + 1 < height && ids[i + width] !== id) {
        if (id) mask[i] = 1
        if (ids[i + width]) mask[i + width] = 1
      }
    }
  }
  return mask
}

// ---------------------------------------------------------------------------
// 標註排版
// ---------------------------------------------------------------------------

export type Side = 'left' | 'right' | 'top' | 'bottom'

export interface CalloutGroup {
  key: string
  text: string
  /** 箭頭落點（示意圖座標） */
  anchors: Pt[]
}

export interface CalloutLabel extends Rect {
  key: string
  text: string
  side: Side
  anchors: Pt[]
}

export interface CalloutStyle {
  /** 字高（px） */
  font: number
  /** 文字外的留白（px） */
  pad: number
  /** 標註與零件圖的距離（px） */
  gap: number
}

export const DEFAULT_CALLOUT_STYLE: CalloutStyle = { font: 26, pad: 4, gap: 56 }

/** 可以設定的標註字高（px） */
export const CALLOUT_FONT_RANGE = { min: 12, max: 64 }

/** 指定字高的標註樣式（超出範圍時取最近的值）；留白跟著字高縮放 */
export function calloutStyle(font: number | undefined): CalloutStyle {
  const size = Number.isFinite(font) ? Math.round(Math.min(CALLOUT_FONT_RANGE.max, Math.max(CALLOUT_FONT_RANGE.min, font!))) : DEFAULT_CALLOUT_STYLE.font
  return { ...DEFAULT_CALLOUT_STYLE, font: size, pad: Math.max(2, Math.round(size * 0.15)) }
}

export interface CalloutLayoutInput {
  /** 零件圖在示意圖上的位置 */
  image: Rect
  /** 示意圖的大小（標註要放在裡面） */
  canvas: { w: number; h: number }
  groups: readonly CalloutGroup[]
  /** 量文字寬度（px） */
  measure: (text: string) => number
  style?: CalloutStyle
  /** 使用者拖曳過的標籤位置（左上角） */
  fixed?: Readonly<Record<string, readonly [number, number]>>
}

const centroid = (pts: readonly Pt[]): Pt => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]

/** 一維排開：依序放在期望位置附近，彼此不重疊並留 gap，且都在 [lo, hi] 內（放不下時往前擠） */
export function spread(desired: readonly number[], sizes: readonly number[], lo: number, hi: number, gap: number): number[] {
  const pos = desired.slice()
  for (let i = 0; i < pos.length; i++) {
    const min = i === 0 ? lo + sizes[0] / 2 : pos[i - 1] + (sizes[i - 1] + sizes[i]) / 2 + gap
    pos[i] = Math.max(pos[i], min)
  }
  for (let i = pos.length - 1; i >= 0; i--) {
    const max = i === pos.length - 1 ? hi - sizes[i] / 2 : pos[i + 1] - (sizes[i] + sizes[i + 1]) / 2 - gap
    pos[i] = Math.min(pos[i], max)
  }
  return pos
}

/** 標籤要留的邊距：左右放得下最長的標籤、上下放得下一行 */
export function calloutMargins(texts: readonly string[], measure: (text: string) => number, style: CalloutStyle = DEFAULT_CALLOUT_STYLE) {
  const widest = Math.max(0, ...texts.map((t) => measure(t))) + style.pad * 2
  const lineH = style.font + style.pad * 2
  return { side: Math.max(120, widest + style.gap + 24), top: lineH + style.gap + 24 }
}

/**
 * 排標註：每個型號依箭頭落點的重心，放到零件圖最近的一側（左、右、上、下），
 * 同一側依位置排序後排開；一側放不下時，離那一側最遠的改放到第二近的一側。
 */
export function layoutCallouts(input: CalloutLayoutInput): CalloutLabel[] {
  const style = input.style ?? DEFAULT_CALLOUT_STYLE
  const { image, canvas } = input
  const h = style.font + style.pad * 2
  const groups = input.groups.filter((g) => g.anchors.length > 0)
  const cx = image.x + image.w / 2
  const cy = image.y + image.h / 2
  const info = groups.map((g) => {
    const c = centroid(g.anchors)
    const w = input.measure(g.text) + style.pad * 2
    // 以零件圖的半寬、半高正規化，長條形的模組也能分到上下或左右
    const dx = (c[0] - cx) / Math.max(image.w / 2, 1)
    const dy = (c[1] - cy) / Math.max(image.h / 2, 1)
    const scores: Record<Side, number> = { left: -dx, right: dx, top: -dy, bottom: dy }
    const order = (Object.keys(scores) as Side[]).sort((a, b) => scores[b] - scores[a])
    return { g, c, w, scores, order, choice: 0 }
  })

  const capacity = (side: Side, members: typeof info) => {
    if (side === 'left' || side === 'right') return members.length * (h + 10) <= canvas.h - 20
    return members.reduce((s, m) => s + m.w + 24, 0) <= canvas.w - 20
  }
  const sideOf = (m: (typeof info)[number]) => m.order[m.choice]
  for (let round = 0; round < groups.length * 4; round++) {
    let moved = false
    for (const side of ['left', 'right', 'top', 'bottom'] as Side[]) {
      const members = info.filter((m) => sideOf(m) === side)
      if (capacity(side, members)) continue
      // 最不適合這一側的那個換到下一個候選
      const worst = members.filter((m) => m.choice < 3).sort((a, b) => a.scores[side] - b.scores[side])[0]
      if (worst) {
        worst.choice++
        moved = true
      }
    }
    if (!moved) break
  }

  const place = (): CalloutLabel[] => {
    const labels: CalloutLabel[] = []
    for (const side of ['left', 'right', 'top', 'bottom'] as Side[]) {
      const members = info.filter((m) => sideOf(m) === side)
      if (!members.length) continue
      const vertical = side === 'left' || side === 'right'
      members.sort((a, b) => (vertical ? a.c[1] - b.c[1] : a.c[0] - b.c[0]))
      const sizes = members.map((m) => (vertical ? h : m.w))
      const centers = spread(
        members.map((m) => (vertical ? m.c[1] : m.c[0])),
        sizes,
        10,
        vertical ? canvas.h - 10 : canvas.w - 10,
        vertical ? 10 : 24,
      )
      members.forEach((m, i) => {
        let x: number
        let y: number
        if (side === 'left') {
          x = image.x - style.gap - m.w
          y = centers[i] - h / 2
        } else if (side === 'right') {
          x = image.x + image.w + style.gap
          y = centers[i] - h / 2
        } else {
          x = centers[i] - m.w / 2
          y = side === 'top' ? image.y - style.gap - h : image.y + image.h + style.gap
        }
        labels.push({ key: m.g.key, text: m.g.text, side, anchors: m.g.anchors, x, y, w: m.w, h })
      })
    }
    return labels
  }

  // 引線交叉時：試著把標註換到其他放得下的一側，交叉變少就採用（交叉一樣多時不動）
  let labels = place()
  let crossed = leaderCrossings(labels)
  for (let round = 0; round < 3 && crossed > 0; round++) {
    let improved = false
    for (const m of info) {
      const current = m.choice
      let best = { choice: current, crossed, labels }
      for (let c = 0; c < 4; c++) {
        if (c === current) continue
        m.choice = c
        if (!capacity(sideOf(m), info.filter((x) => sideOf(x) === sideOf(m)))) continue
        const ls = place()
        const k = leaderCrossings(ls)
        if (k < best.crossed) best = { choice: c, crossed: k, labels: ls }
      }
      m.choice = best.choice
      if (best.choice !== current) {
        labels = best.labels
        crossed = best.crossed
        improved = true
      }
    }
    if (!improved) break
  }

  // 拖曳過的標籤：用使用者的位置
  return labels.map((l) => {
    const p = input.fixed?.[l.key]
    return p ? { ...l, x: p[0], y: p[1], side: sideFacing({ ...l, x: p[0], y: p[1] }, centroid(l.anchors)) } : l
  })
}

/** 不同標註的引線互相交叉的次數 */
export function leaderCrossings(labels: readonly CalloutLabel[]): number {
  const segs = labels.flatMap((l) => l.anchors.map((a) => ({ key: l.key, a: leaderOrigin(l), b: a })))
  let n = 0
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) if (segs[i].key !== segs[j].key && segmentsCross(segs[i].a, segs[i].b, segs[j].a, segs[j].b)) n++
  return n
}

const orient = (a: Pt, b: Pt, c: Pt) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
/** 兩線段在內部相交（共用端點不算） */
function segmentsCross(p1: Pt, p2: Pt, q1: Pt, q2: Pt): boolean {
  return orient(p1, p2, q1) * orient(p1, p2, q2) < 0 && orient(q1, q2, p1) * orient(q1, q2, p2) < 0
}

/** 標籤朝向箭頭落點重心的那一邊 */
function sideFacing(box: Rect, target: Pt): Side {
  const dx = target[0] - (box.x + box.w / 2)
  const dy = target[1] - (box.y + box.h / 2)
  if (Math.abs(dx) * box.h >= Math.abs(dy) * box.w) return dx > 0 ? 'left' : 'right'
  return dy > 0 ? 'top' : 'bottom'
}

/** 引線的起點：標籤朝向零件那一邊的中點，稍微往外 */
export function leaderOrigin(label: CalloutLabel, offset = 4): Pt {
  switch (label.side) {
    case 'left':
      return [label.x + label.w + offset, label.y + label.h / 2]
    case 'right':
      return [label.x - offset, label.y + label.h / 2]
    case 'top':
      return [label.x + label.w / 2, label.y + label.h + offset]
    case 'bottom':
      return [label.x + label.w / 2, label.y - offset]
  }
}

/** 點在哪個標籤上（由上層往下找） */
export function labelAt(labels: readonly CalloutLabel[], p: Pt, slop = 4): CalloutLabel | undefined {
  for (let i = labels.length - 1; i >= 0; i--) {
    const l = labels[i]
    if (p[0] >= l.x - slop && p[0] <= l.x + l.w + slop && p[1] >= l.y - slop && p[1] <= l.y + l.h + slop) return l
  }
  return undefined
}

/** 零件圖＋標註的外框（裁切留白用） */
export function contentBounds(image: Rect, labels: readonly CalloutLabel[]): Rect {
  let x0 = image.x
  let y0 = image.y
  let x1 = image.x + image.w
  let y1 = image.y + image.h
  for (const l of labels) {
    x0 = Math.min(x0, l.x)
    y0 = Math.min(y0, l.y)
    x1 = Math.max(x1, l.x + l.w)
    y1 = Math.max(y1, l.y + l.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// ---------------------------------------------------------------------------
// PDF 圖紙：圖框＋標題欄，零件圖為點陣圖，標註與引線為向量
// ---------------------------------------------------------------------------

export interface IllustrationSheetInput {
  paper: PaperSize
  title: Omit<TitleInfo, 'scale' | 'projection'>
  /** 示意圖大小（px） */
  canvas: { w: number; h: number }
  /** 零件圖（PNG data URL）與它在示意圖上的位置 */
  image: { dataUrl: string; rect: Rect }
  labels: readonly CalloutLabel[]
  style?: CalloutStyle
  /** 圖面下方的附註（例如看不到的零件） */
  notes?: readonly string[]
}

export function illustrationSheet(input: IllustrationSheetInput): Sheet {
  const style = input.style ?? DEFAULT_CALLOUT_STYLE
  const paper = PAPER[input.paper]
  const d = new Draw()
  drawFrame(d, paper.width, paper.height)
  const tw = input.paper === 'A3' ? 180 : 130
  const right = paper.width - MARGIN
  const bottom = paper.height - MARGIN
  drawTitleBlock(d, right - tw, bottom - TITLE_BLOCK_HEIGHT, tw, { ...input.title, scale: '不依比例', projection: 'none' })

  // 可用範圍：圖框內、標題欄上方（附註放在左下角）
  const notes = input.notes ?? []
  const area = { x: MARGIN + 6, y: MARGIN + 6, w: paper.width - 2 * MARGIN - 12, h: paper.height - 2 * MARGIN - TITLE_BLOCK_HEIGHT - 12 }
  const k = Math.min(area.w / input.canvas.w, area.h / input.canvas.h)
  const ox = area.x + (area.w - input.canvas.w * k) / 2
  const oy = area.y + (area.h - input.canvas.h * k) / 2
  const T = (p: Pt): Pt => [ox + p[0] * k, oy + p[1] * k]

  const r = input.image.rect
  d.out.push({ kind: 'image', layer: 'SYMBOL', at: T([r.x, r.y]), width: r.w * k, height: r.h * k, dataUrl: input.image.dataUrl })
  const lineW = 0.3
  const arrowLen = Math.min(3, 14 * k)
  for (const l of input.labels) {
    const o = T(leaderOrigin(l))
    for (const a of l.anchors) {
      const tip = T(a)
      d.line(o, tip, 'BALLOON', lineW)
      d.arrow(tip, [tip[0] - o[0], tip[1] - o[1]], 'BALLOON', arrowLen, arrowLen * 0.32)
    }
    const at = T([l.x + l.w / 2, l.y + l.h / 2])
    d.text(at, l.text, style.font * k, { align: 'center', valign: 'middle' })
  }
  notes.forEach((line, i) => d.text([MARGIN + 4, bottom - 3 - (notes.length - 1 - i) * 4.2], line, 2.8, { color: '#475569' }))
  return { width: paper.width, height: paper.height, primitives: d.out, scale: 1, title: input.title.title }
}
