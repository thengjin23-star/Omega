import type { Product } from '../catalog/types'
import { checkMate } from '../threads'
import { groupOf, usedPorts, type ProductMap } from './moduleOps'
import type { ModuleDoc, PortRef } from './types'

export interface MateHint {
  /** 選取的零件上的空埠 */
  from: PortRef
  /** 模組中其他零件（不同組）上可以接的空埠 */
  to: PortRef
  /** 安裝面（閥座、模組面）：通常就是這個零件該裝的位置 */
  mount: boolean
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true })

/**
 * 選取零件時的接合建議：它的空埠可以接到模組中哪些零件的空埠（規格完全相配的才列）。
 * 安裝面排在前面；同一個埠最多列 perPort 個候選（站位依編號，先列前面的空站）。
 */
export function mateHints(doc: ModuleDoc, products: ProductMap, instance: string, limit = 8, perPort = 2): MateHint[] {
  const inst = doc.instances.find((i) => i.id === instance)
  const product: Product | undefined = inst && products[inst.productId]
  if (!product) return []
  const used = usedPorts(doc, products)
  const group = groupOf(doc, instance)
  const hints: MateHint[] = []
  for (const p of [...product.ports].sort(byName)) {
    if (!p.spec || used.has(`${instance}:${p.id}`)) continue
    let count = 0
    for (const other of doc.instances) {
      if (group.has(other.id) || count >= perPort) continue
      const op = products[other.productId]
      for (const q of [...(op?.ports ?? [])].sort(byName)) {
        if (count >= perPort) break
        if (!q.spec || used.has(`${other.id}:${q.id}`)) continue
        // 兩個快插口之間用 PU 管，不是直接鎖合
        if (p.spec.kind === 'tube' && q.spec.kind === 'tube') continue
        if (checkMate(p.spec, q.spec).level !== 'ok') continue
        hints.push({ from: { instance, port: p.id }, to: { instance: other.id, port: q.id }, mount: p.spec.kind === 'interface' })
        count++
      }
    }
  }
  return hints.sort((a, b) => Number(b.mount) - Number(a.mount)).slice(0, limit)
}
