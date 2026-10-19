import { hasModel, type Product, type ProductPort } from '../catalog/types'
import type { StepModuleMeta } from '../drawing/stepMeta'
import { newId } from '../utils/id'
import { distance, dot } from '../geometry/vec3'
import { fromMatrix, toMatrix } from './frames'
import { computeTransforms, type ProductMap } from './moduleOps'
import type { Mat4, ModuleDoc, PortRef } from './types'

/**
 * 從本程式匯出的 STEP 還原模組：
 * 1. 每個產品先找本機產品庫（同一個原始檔，或先前從組立檔取出過的）；沒有的才從 STEP 取出幾何建立新產品
 * 2. 依匯出時的資料重建零件、根零件位置、鎖合、PU 管
 * 3. 本機產品的埠與匯出時不同（例如改過埠）而使零件位置改變時，該零件改成固定在匯出時的位置（不靠鎖合）
 */

export interface RestoreLookup {
  /** 依原始檔 sha256 找本機產品（也比對 derivedFrom：之前從組立檔取出的同一個零件） */
  bySha(sha256: string): Product | undefined
  /** 沒有 3D 檔的產品：依型號找 */
  modelOnly(modelCode: string): Product | undefined
}

export interface RestorePlan {
  /** 本機已有的產品：匯出時的產品 id → 本機產品 */
  reuse: Record<string, Product>
  /** 要從 STEP 取出幾何建立的產品：頂層第 root 個零件，套用 matrix 換回零件自己的座標 */
  extract: { productId: string; root: number; matrix: Mat4 }[]
  /** 沒有 3D 檔、本機也沒有的產品：直接建立 */
  modelOnly: string[]
  /** 有 3D 檔但 STEP 裡沒有它的幾何（例如 IGES 零件）、本機也沒有：這些零件無法還原 */
  missing: string[]
}

export function planRestore(meta: StepModuleMeta, lookup: RestoreLookup): RestorePlan {
  const plan: RestorePlan = { reuse: {}, extract: [], modelOnly: [], missing: [] }
  const { transforms } = computeTransforms(meta.module, meta.products)
  for (const product of Object.values(meta.products)) {
    if (!hasModel(product)) {
      const local = lookup.modelOnly(product.modelCode)
      if (local) plan.reuse[product.id] = local
      else plan.modelOnly.push(product.id)
      continue
    }
    const local = lookup.bySha(product.source.sha256)
    if (local) {
      plan.reuse[product.id] = local
      continue
    }
    const inst = meta.module.instances.find((i) => i.productId === product.id && meta.roots[i.id] !== undefined && transforms[i.id])
    if (!inst) {
      plan.missing.push(product.id)
      continue
    }
    plan.extract.push({ productId: product.id, root: meta.roots[inst.id], matrix: fromMatrix(toMatrix(transforms[inst.id]).invert()) })
  }
  return plan
}

/** 匯出時的埠 → 本機產品的埠：同 id、同名稱，或位置與方向相同 */
export function mapPorts(from: Product, to: Product): Record<string, string> {
  const map: Record<string, string> = {}
  for (const p of from.ports) {
    const match =
      to.ports.find((q) => q.id === p.id) ??
      uniqueBy(to.ports, (q) => q.name === p.name) ??
      to.ports.find((q) => distance(q.frame.origin, p.frame.origin) < 0.05 && dot(q.frame.axis, p.frame.axis) > 0.999)
    if (match) map[p.id] = match.id
  }
  return map
}

function uniqueBy(ports: readonly ProductPort[], test: (p: ProductPort) => boolean): ProductPort | undefined {
  const found = ports.filter(test)
  return found.length === 1 ? found[0] : undefined
}

export interface RestoreResult {
  doc: ModuleDoc
  /** 鎖合因為埠對不上而改成固定位置的零件數 */
  pinned: number
  /** 無法還原（缺產品）的零件數 */
  skipped: number
  /** 因為埠對不上而略過的 PU 管 */
  droppedTubes: number
}

const MATCH_MM = 0.01
const MATCH_ROT = 1e-5

function samePose(a: Mat4, b: Mat4): boolean {
  for (let i = 0; i < 16; i++) {
    const tol = i >= 12 && i <= 14 ? MATCH_MM : MATCH_ROT
    if (Math.abs(a[i] - b[i]) > tol) return false
  }
  return true
}

/** 依匯出的資料與本機產品重建模組（新的模組 id；位置與匯出時相同） */
export function restoreModule(meta: StepModuleMeta, local: Readonly<Record<string, Product>>): RestoreResult {
  const source = meta.module
  const metaWorld = computeTransforms(source, meta.products).transforms
  const portMaps: Record<string, Record<string, string>> = {}
  for (const [id, product] of Object.entries(meta.products)) if (local[id]) portMaps[id] = mapPorts(product, local[id])

  const kept = source.instances.filter((i) => local[i.productId])
  const keptIds = new Set(kept.map((i) => i.id))
  const productOf = new Map(source.instances.map((i) => [i.id, i.productId]))
  const remap = (ref: PortRef): PortRef | undefined => {
    if (!keptIds.has(ref.instance)) return undefined
    const port = portMaps[productOf.get(ref.instance)!]?.[ref.port]
    return port ? { instance: ref.instance, port } : undefined
  }

  const placements: Record<string, Mat4> = {}
  for (const inst of kept) if (source.placements[inst.id]) placements[inst.id] = source.placements[inst.id]
  let pinned = 0
  const mates = source.mates.flatMap((m) => {
    const parent = remap(m.parent)
    const child = remap(m.child)
    if (parent && child) return [{ ...m, parent, child }]
    // 對不上的鎖合：子零件固定在匯出時的位置
    if (keptIds.has(m.child.instance)) {
      placements[m.child.instance] = metaWorld[m.child.instance]
      pinned++
    }
    return []
  })
  const tubes = (source.tubes ?? []).flatMap((t) => {
    const a = remap(t.a)
    const b = remap(t.b)
    return a && b ? [{ ...t, a, b }] : []
  })
  const supply = source.supply && remap(source.supply)

  const products: ProductMap = Object.fromEntries(kept.map((i) => [i.productId, local[i.productId]]))
  const instances = kept.map((i) => ({ ...i, productId: local[i.productId].id }))
  const localProducts: ProductMap = Object.fromEntries(Object.values(products).map((p) => [p.id, p]))
  let doc: ModuleDoc = {
    ...source,
    id: newId('mod'),
    instances,
    mates,
    placements,
    tubes: tubes.length ? tubes : undefined,
    supply: supply ? { ...source.supply!, ...supply } : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  // 本機產品的埠位置與匯出時不同：沿鎖合推出的位置會不同，改成固定位置（由上而下，一次修一個）
  for (let guard = 0; guard < doc.instances.length; guard++) {
    const { transforms } = computeTransforms(doc, localProducts)
    const off = doc.instances.find((i) => metaWorld[i.id] && transforms[i.id] && !samePose(transforms[i.id], metaWorld[i.id]) && doc.mates.some((m) => m.child.instance === i.id))
    if (!off) break
    doc = {
      ...doc,
      mates: doc.mates.filter((m) => m.child.instance !== off.id),
      placements: { ...doc.placements, [off.id]: metaWorld[off.id] },
    }
    pinned++
  }
  return {
    doc,
    pinned,
    skipped: source.instances.length - kept.length,
    droppedTubes: (source.tubes ?? []).length - tubes.length,
  }
}
