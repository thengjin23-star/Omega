import { buildBom } from '../assembly/bom'
import { tubeFrames, type ProductMap } from '../assembly/moduleOps'
import { tubeBom, tubeControlPoints, tubeInnerDiameter, tubeLabelOf } from '../assembly/tubes'
import type { Mat4, ModuleDoc } from '../assembly/types'
import type { Tessellation } from '../catalog/tessellation'
import { hasModel, productLabel } from '../catalog/types'
import type { StepPart, StepTube } from './stepAssembly'

/** PU 管在 STEP 中的顏色（與 3D 畫面相同） */
const TUBE_COLOR = '#38bdf8'

const hex = (c: readonly number[]) =>
  `#${c
    .slice(0, 3)
    .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0'))
    .join('')}`

export interface StepPlan {
  parts: StepPart[]
  /** 零件實例 → 在 STEP 檔頂層的第幾個（與 parts 的順序相同；寫進模組資料，重新匯入時用） */
  roots: Record<string, number>
  /** PU 管：沿畫面上的曲線掃出的圓管 */
  tubes: StepTube[]
  /** 要讀取的原始檔（sha256） */
  sources: string[]
  /** 不會寫入 STEP 的零件 */
  skipped: { name: string; reason: string }[]
}

/**
 * 整理 STEP 組立檔的內容：每個零件實例一個實體，名稱為「項次_型號」（同一產品有多個時加 _1、_2…），
 * 顏色取模型本身的顏色。沒有 3D 檔或原始檔為 IGES 的零件略過。
 * PU 管依零件表的項次命名「項次_PU 管 Ø6_1」。
 */
export function collectStepParts(
  doc: ModuleDoc,
  products: ProductMap,
  meshes: Readonly<Record<string, Tessellation>>,
  transforms: Readonly<Record<string, Mat4>>,
): StepPlan {
  const itemOf = new Map(buildBom(doc, products).map((r) => [r.product.id, r.index]))
  const counts = new Map<string, number>()
  for (const inst of doc.instances) counts.set(inst.productId, (counts.get(inst.productId) ?? 0) + 1)
  const seen = new Map<string, number>()
  const parts: StepPart[] = []
  const roots: Record<string, number> = {}
  const skipped: StepPlan['skipped'] = []
  const sources = new Set<string>()
  for (const inst of doc.instances) {
    const product = products[inst.productId]
    const matrix = transforms[inst.id]
    if (!product || !matrix) continue
    const k = (seen.get(product.id) ?? 0) + 1
    seen.set(product.id, k)
    const code = (product.modelCode || productLabel(product)).replace(/[\r\n'\\]/g, ' ').trim()
    const name = `${itemOf.get(product.id) ?? 0}_${code}${(counts.get(product.id) ?? 1) > 1 ? `_${k}` : ''}`
    if (!hasModel(product)) {
      if (k === 1) skipped.push({ name: code, reason: '沒有 3D 檔' })
      continue
    }
    if (product.source.format !== 'step') {
      if (k === 1) skipped.push({ name: code, reason: 'IGES 檔無法寫入 STEP 組立檔' })
      continue
    }
    const color = meshes[product.source.sha256]?.parts.find((p) => p.color)?.color
    roots[inst.id] = parts.length
    parts.push({ name, source: product.source.sha256, matrix, color: color ? hex(color) : undefined })
    sources.add(product.source.sha256)
  }
  const rows = buildBom(doc, products).length
  const tubeItems = new Map(tubeBom(doc).map((t, i) => [t.label, rows + i + 1]))
  const tubeCount = new Map<string, number>()
  const tubes: StepTube[] = []
  for (const tube of doc.tubes ?? []) {
    const ends = tubeFrames(doc, products, tube, transforms)
    if (!ends) continue
    const label = tubeLabelOf(tube)
    const k = (tubeCount.get(label) ?? 0) + 1
    tubeCount.set(label, k)
    tubes.push({
      name: `${tubeItems.get(label) ?? 0}_PU 管 ${label}_${k}`,
      points: tubeControlPoints(ends[0], ends[1]),
      od: tube.od,
      id: tubeInnerDiameter(tube.od),
      color: TUBE_COLOR,
    })
  }
  return { parts, roots, tubes, sources: [...sources], skipped }
}
