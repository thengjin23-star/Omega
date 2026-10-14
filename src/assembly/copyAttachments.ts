import { addInstance, connect, groupOf, parentMateOf, usedPorts, type ProductMap } from './moduleOps'
import type { Mate, ModuleDoc, PortRef } from './types'

/** 接在某個零件上的一串零件（例如接頭、轉接頭＋接頭、消音器） */
export interface AttachmentBranch {
  /** 接在來源零件的哪個埠 */
  port: string
  /** 直接接上的零件與它接的埠 */
  first: PortRef
  angle: number
  /** 分支裡的其他鎖合（由近到遠） */
  edges: { near: PortRef; far: PortRef; angle: number }[]
  members: string[]
}

const otherEnd = (m: Mate, instance: string): { self: PortRef; other: PortRef } | undefined =>
  m.parent.instance === instance ? { self: m.parent, other: m.child } : m.child.instance === instance ? { self: m.child, other: m.parent } : undefined

/**
 * 接在零件上、可以複製到相同零件的分支（接頭、消音器、轉接頭＋接頭…）。
 * 「底座」那一側不算：含有同一個產品的其他零件、含有接了 3 個以上零件的零件（例如集裝座），
 * 或含有接了 2 個以上零件的群組根零件。
 */
export function attachmentBranches(doc: ModuleDoc, instanceId: string): AttachmentBranch[] {
  const productOf = new Map(doc.instances.map((i) => [i.id, i.productId]))
  const productId = productOf.get(instanceId)
  if (!productId) return []
  const root = [...groupOf(doc, instanceId)].find((id) => !parentMateOf(doc, id))
  const degree = new Map<string, number>()
  for (const m of doc.mates) for (const id of [m.parent.instance, m.child.instance]) degree.set(id, (degree.get(id) ?? 0) + 1)
  const isBase = (members: string[]) =>
    members.some((id) => productOf.get(id) === productId || (degree.get(id) ?? 0) >= 3) ||
    (!!root && root !== instanceId && members.includes(root) && (degree.get(root) ?? 0) >= 2)
  const branches: AttachmentBranch[] = []
  for (const m of doc.mates) {
    const end = otherEnd(m, instanceId)
    if (!end) continue
    const members = [end.other.instance]
    const seen = new Set([instanceId, end.other.instance])
    const edges: AttachmentBranch['edges'] = []
    for (let i = 0; i < members.length; i++) {
      const cur = members[i]
      for (const e of doc.mates) {
        const ends = otherEnd(e, cur)
        if (!ends || seen.has(ends.other.instance)) continue
        seen.add(ends.other.instance)
        members.push(ends.other.instance)
        edges.push({ near: ends.self, far: ends.other, angle: e.angle })
      }
    }
    if (isBase(members)) continue
    branches.push({ port: end.self.port, first: end.other, angle: m.angle, edges, members })
  }
  return branches
}

export interface CopyResult {
  doc: ModuleDoc
  /** 加入的零件數 */
  added: number
  /** 有加到零件的相同零件數 */
  targets: number
  /** 對應的埠已有零件而略過的次數 */
  skipped: number
  /** 來源零件上可複製的分支數 */
  branches: number
}

/**
 * 把接在 instanceId 上的零件（接頭、消音器…，含轉接頭等串接），
 * 照樣接到模組中其他相同產品的零件的同一個埠（那個埠空著時）。
 * 鎖合角度相同；PU 管、零件參數不複製。
 */
export function copyAttachments(doc: ModuleDoc, products: ProductMap, instanceId: string): CopyResult {
  const productOf = new Map(doc.instances.map((i) => [i.id, i.productId]))
  const productId = productOf.get(instanceId)
  const branches = attachmentBranches(doc, instanceId)
  const result: CopyResult = { doc, added: 0, targets: 0, skipped: 0, branches: branches.length }
  if (!productId || !branches.length) return result
  let next = doc
  for (const target of doc.instances.filter((i) => i.productId === productId && i.id !== instanceId)) {
    let any = false
    for (const branch of branches) {
      if (usedPorts(next, products).has(`${target.id}:${branch.port}`)) {
        result.skipped++
        continue
      }
      // 先在副本上做，任何一步失敗就整個分支不加
      let trial = next
      const clones = new Map<string, string>()
      const clone = (id: string) => {
        const r = addInstance(trial, productOf.get(id)!)
        trial = r.doc
        clones.set(id, r.instanceId)
        return r.instanceId
      }
      const first = clone(branch.first.instance)
      let r = connect(trial, products, { instance: target.id, port: branch.port }, { instance: first, port: branch.first.port }, branch.angle)
      let ok = !('error' in r)
      if (!('error' in r)) trial = r.doc
      for (const e of branch.edges) {
        if (!ok) break
        const near = clones.get(e.near.instance)!
        const far = clone(e.far.instance)
        r = connect(trial, products, { instance: near, port: e.near.port }, { instance: far, port: e.far.port }, e.angle)
        if ('error' in r) ok = false
        else trial = r.doc
      }
      if (!ok) continue
      next = trial
      result.added += branch.members.length
      any = true
    }
    if (any) result.targets++
  }
  result.doc = next
  return result
}
