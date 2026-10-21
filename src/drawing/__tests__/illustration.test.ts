import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CALLOUT_STYLE,
  calloutMargins,
  calloutStyle,
  contentBounds,
  illustrationSheet,
  labelAt,
  layoutCallouts,
  leaderCrossings,
  leaderOrigin,
  outlineMask,
  spread,
  visibleAnchors,
  type CalloutLabel,
} from '../illustration'
import type { Pt } from '../types'

/** 由字元圖建立 ID 圖：'.' = 背景，'1'~'9' = 零件編號 */
function idMap(rows: string[]) {
  const height = rows.length
  const width = rows[0].length
  const ids = new Uint32Array(width * height)
  rows.forEach((row, y) => [...row].forEach((ch, x) => (ids[y * width + x] = ch === '.' ? 0 : Number(ch))))
  return { ids, width, height }
}

const measure = (t: string) => t.length * 15

const overlaps = (a: CalloutLabel, b: CalloutLabel) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('visibleAnchors', () => {
  it('取零件看得到的範圍中，離邊緣最遠的點', () => {
    const { ids, width, height } = idMap([
      '..........',
      '.11111....',
      '.11111.22.',
      '.11111.22.',
      '.11111....',
      '.11111....',
      '..........',
    ])
    const { anchors, pixels } = visibleAnchors(ids, width, height, 3)
    expect(pixels).toEqual([25, 4, 0])
    expect(anchors[0]).toEqual([3.5, 3.5])
    const a2 = anchors[1]!
    expect(a2[0]).toBeGreaterThanOrEqual(7)
    expect(a2[0]).toBeLessThanOrEqual(9)
    expect(a2[1]).toBeGreaterThanOrEqual(2)
    expect(a2[1]).toBeLessThanOrEqual(4)
    // 完全被擋住的零件沒有落點
    expect(anchors[2]).toBeUndefined()
  })

  it('被擋住一部分的零件：落點在看得到的較大區塊中', () => {
    // 零件 1 被零件 2 切成左右兩塊，左邊大
    const { ids, width, height } = idMap([
      '.............',
      '.1111111221..',
      '.1111111221..',
      '.1111111221..',
      '.1111111221..',
      '.............',
    ])
    const a = visibleAnchors(ids, width, height, 2).anchors[0]!
    expect(a[0]).toBeLessThan(8)
  })
})

describe('outlineMask', () => {
  it('零件與背景、零件與零件的交界都標記，背景不標記', () => {
    const { ids, width, height } = idMap(['....', '.12.', '.12.', '....'])
    const mask = outlineMask(ids, width, height)
    expect(mask[0]).toBe(0)
    expect(mask[1 * width + 1]).toBe(1)
    expect(mask[1 * width + 2]).toBe(1)
    expect([...mask].filter(Boolean).length).toBe(4)
  })
})

describe('spread', () => {
  it('不重疊、留間隔，且在範圍內', () => {
    const pos = spread([100, 105, 110], [30, 30, 30], 0, 1000, 10)
    expect(pos[1] - pos[0]).toBeGreaterThanOrEqual(40)
    expect(pos[2] - pos[1]).toBeGreaterThanOrEqual(40)
  })
  it('超出上限時往前擠', () => {
    const pos = spread([980, 990], [30, 30], 0, 1000, 10)
    expect(pos[1]).toBeLessThanOrEqual(985)
    expect(pos[1] - pos[0]).toBeGreaterThanOrEqual(40)
  })
})

describe('layoutCallouts', () => {
  const image = { x: 300, y: 150, w: 600, h: 400 }
  const canvas = { w: 1200, h: 700 }

  it('依箭頭落點分到最近的一側；同型號一個標註、多條箭頭', () => {
    const labels = layoutCallouts({
      image,
      canvas,
      measure,
      groups: [
        { key: 'valve', text: '4SV21008BD', anchors: [[400, 500], [500, 510], [600, 505], [700, 500]] },
        { key: 'silencer', text: 'BSL01', anchors: [[320, 300], [320, 400]] },
        { key: 'elbow', text: 'PL1202D', anchors: [[880, 350]] },
        { key: 'plug', text: 'GSC1/4008Z', anchors: [[450, 170], [650, 170]] },
        { key: 'hidden', text: 'X', anchors: [] },
      ],
    })
    const side = Object.fromEntries(labels.map((l) => [l.key, l.side]))
    expect(side).toEqual({ valve: 'bottom', silencer: 'left', elbow: 'right', plug: 'top' })
    expect(labels.find((l) => l.key === 'valve')!.anchors).toHaveLength(4)
    // 標註在零件圖外面
    for (const l of labels) expect(overlaps(l, { ...image, key: '', text: '', side: 'left', anchors: [] })).toBe(false)
  })

  it('同一側的多個標註不重疊，依位置排序（引線不交叉）', () => {
    const groups = Array.from({ length: 6 }, (_, i) => ({ key: `g${i}`, text: `PART-${i}`, anchors: [[310, 160 + ((i * 37) % 6) * 60] as Pt] }))
    const labels = layoutCallouts({ image, canvas, measure, groups })
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) expect(overlaps(labels[i], labels[j])).toBe(false)
    const left = labels.filter((l) => l.side === 'left').sort((a, b) => a.y - b.y)
    const anchorsY = left.map((l) => l.anchors[0][1])
    expect([...anchorsY].sort((a, b) => a - b)).toEqual(anchorsY)
  })

  it('兩個標註的箭頭交錯時，改放到其他一側讓引線不交叉', () => {
    // 閥島：4 顆閥與 8 個接頭都在上方、左右交錯
    const groups = [
      { key: 'valve', text: '4V210-08', anchors: [[420, 220], [520, 225], [620, 230], [720, 235]] as Pt[] },
      { key: 'fitting', text: 'PC6-02', anchors: [[400, 180], [460, 182], [500, 185], [560, 188], [600, 190], [660, 192], [700, 195], [760, 198]] as Pt[] },
    ]
    const labels = layoutCallouts({ image, canvas, measure, groups })
    expect(leaderCrossings(labels)).toBe(0)
    for (const l of labels) expect(overlaps(l, { ...image, key: '', text: '', side: 'left', anchors: [] })).toBe(false)
  })

  it('一側放不下時改放到其他側', () => {
    const groups = Array.from({ length: 14 }, (_, i) => ({ key: `g${i}`, text: `P${i}`, anchors: [[305, 160 + i * 28] as Pt] }))
    const labels = layoutCallouts({ image, canvas: { w: 1200, h: 420 }, measure, groups })
    expect(labels).toHaveLength(14)
    expect(new Set(labels.map((l) => l.side)).size).toBeGreaterThan(1)
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) expect(overlaps(labels[i], labels[j])).toBe(false)
  })

  it('拖曳過的標籤用使用者的位置，引線從朝向零件的一邊出發', () => {
    const labels = layoutCallouts({
      image,
      canvas,
      measure,
      groups: [{ key: 'a', text: 'PL802D', anchors: [[600, 300]] }],
      fixed: { a: [950, 280] },
    })
    expect(labels[0]).toMatchObject({ x: 950, y: 280, side: 'right' })
    const o = leaderOrigin(labels[0])
    expect(o[0]).toBeLessThan(950)
    expect(labelAt(labels, [960, 290])?.key).toBe('a')
    expect(labelAt(labels, [100, 100])).toBeUndefined()
  })
})

describe('calloutMargins / contentBounds', () => {
  it('左右留邊放得下最長的標籤', () => {
    const m = calloutMargins(['PL802D', 'GSC1/4008Z'], measure)
    expect(m.side).toBeGreaterThan(measure('GSC1/4008Z'))
    expect(m.top).toBeGreaterThan(26)
  })
  it('外框包含零件圖與所有標註', () => {
    const b = contentBounds({ x: 100, y: 100, w: 200, h: 100 }, [{ key: 'a', text: 'A', side: 'left', anchors: [], x: 20, y: 120, w: 50, h: 34 }])
    expect(b).toEqual({ x: 20, y: 100, w: 280, h: 100 })
  })
})

describe('calloutStyle（標註字體大小）', () => {
  it('沒設定時是預設樣式；超出範圍取最近的值', () => {
    expect(calloutStyle(undefined)).toEqual(DEFAULT_CALLOUT_STYLE)
    expect(calloutStyle(26)).toEqual(DEFAULT_CALLOUT_STYLE)
    expect(calloutStyle(Number.NaN)).toEqual(DEFAULT_CALLOUT_STYLE)
    expect(calloutStyle(4).font).toBe(12)
    expect(calloutStyle(200).font).toBe(64)
    expect(calloutStyle(40)).toMatchObject({ font: 40, pad: 6 })
  })

  it('字放大：標籤變大、留邊變大，仍然不重疊、在零件圖外面', () => {
    const image = { x: 0, y: 0, w: 600, h: 400 }
    const groups = [
      { key: 'v', text: '4V210-08', anchors: [[100, 380], [300, 380], [500, 380]] as Pt[] },
      { key: 'a', text: 'PC6-01', anchors: [[120, 20], [480, 20]] as Pt[] },
      { key: 'b', text: 'PC4-01', anchors: [[300, 30]] as Pt[] },
      { key: 's', text: 'BSL-01', anchors: [[20, 200]] as Pt[] },
    ]
    const sized = (font: number) => {
      const style = calloutStyle(font)
      const m = (t: string) => (t.length * 15 * style.font) / 26
      const margins = calloutMargins(
        groups.map((g) => g.text),
        m,
        style,
      )
      const img = { ...image, x: margins.side, y: margins.top }
      const canvas = { w: img.w + margins.side * 2, h: img.h + margins.top * 2 }
      const labels = layoutCallouts({ image: img, canvas, measure: m, style, groups: groups.map((g) => ({ ...g, anchors: g.anchors.map((a): Pt => [a[0] + img.x, a[1] + img.y]) })) })
      return { margins, labels, img }
    }
    const small = sized(16)
    const big = sized(48)
    expect(big.margins.side).toBeGreaterThan(small.margins.side)
    expect(big.margins.top).toBeGreaterThan(small.margins.top)
    expect(big.labels[0].h).toBe(48 + calloutStyle(48).pad * 2)
    expect(small.labels[0].h).toBe(16 + calloutStyle(16).pad * 2)
    for (const { labels, img } of [small, big]) {
      expect(labels).toHaveLength(4)
      for (let i = 0; i < labels.length; i++) {
        expect(overlaps(labels[i], { ...img, key: '', text: '', side: 'left', anchors: [] })).toBe(false)
        for (let j = i + 1; j < labels.length; j++) expect(overlaps(labels[i], labels[j])).toBe(false)
      }
    }
  })
})

describe('illustrationSheet', () => {
  it('圖框、標題欄、零件圖與標註都在圖紙內', () => {
    const labels = layoutCallouts({
      image: { x: 200, y: 100, w: 600, h: 300 },
      canvas: { w: 1000, h: 500 },
      measure,
      groups: [
        { key: 'v', text: '4SV21008BD', anchors: [[300, 380], [500, 380]] },
        { key: 'f', text: 'PL802D', anchors: [[250, 150]] },
      ],
    })
    const input = {
      paper: 'A3' as const,
      title: { company: { name: '甲乙氣動' }, title: '閥島 示意圖', customer: '大明精機', date: '2026-10-13' },
      canvas: { w: 1000, h: 500 },
      image: { dataUrl: 'data:image/png;base64,AAAA', rect: { x: 200, y: 100, w: 600, h: 300 } },
      labels,
      notes: ['這個角度看不到（未標註）：BSL01'],
    }
    const sheet = illustrationSheet(input)
    expect(sheet.width).toBe(420)
    // PDF 的標註字高與示意圖的字高成比例
    const sizeOf = (s: typeof sheet, text: string) => s.primitives.flatMap((p) => (p.kind === 'text' && p.text === text ? [p.size] : []))[0]
    const bigger = illustrationSheet({ ...input, style: calloutStyle(39) })
    expect(sizeOf(bigger, 'PL802D') / sizeOf(sheet, 'PL802D')).toBeCloseTo(39 / 26, 6)
    const texts = sheet.primitives.flatMap((p) => (p.kind === 'text' ? [p.text] : []))
    expect(texts).toEqual(expect.arrayContaining(['4SV21008BD', 'PL802D', '閥島 示意圖', '大明精機', '不依比例', '這個角度看不到（未標註）：BSL01']))
    const image = sheet.primitives.find((p) => p.kind === 'image' && p.layer === 'SYMBOL')
    expect(image).toBeDefined()
    // 3 條引線（2 + 1）＋ 3 個箭頭
    expect(sheet.primitives.filter((p) => p.kind === 'polyline' && p.layer === 'BALLOON')).toHaveLength(6)
    for (const p of sheet.primitives) {
      const pts: readonly Pt[] = p.kind === 'polyline' ? p.points : p.kind === 'text' || p.kind === 'image' ? [p.at] : [p.center]
      for (const [x, y] of pts) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(420)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(297)
      }
    }
  })
})
