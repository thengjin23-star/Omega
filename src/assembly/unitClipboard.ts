import { specKey } from '../threads'
import { addInstance, computeTransforms, connect, getPort, usedPorts, type ProductMap } from './moduleOps'
import type { Mat4, Mate, ModuleDoc, ModuleInstance, PortRef } from './types'

/**
 * 複製下來的一組零件（例如電磁閥＋接在閥上的接頭、消音器）：一個可以重複使用的組裝單元。
 * 貼上時建立新的零件（彼此獨立），組內的鎖合照原樣接好，再裝到底座（例如集裝座）下一個空的同規格埠。
 */
export interface UnitClip {
  /** 組裡的零件：第 0 個是選取的零件 */
  members: { productId: string; params?: ModuleInstance['params'] }[]
  /** 組內的鎖合（以 members 的編號表示），由近到遠 */
  mates: { near: { member: number; port: string }; far: { member: number; port: string }; angle: number }[]
  /** 這組原本裝在哪裡：底座零件的埠、組這一側的埠、鎖合角度；key = 底座埠的規格（同規格的空埠才貼得上） */
  mount?: { baseInstance: string; basePort: string; port: string; angle: number; key: string }
  /** 複製時第 0 個零件的世界矩陣 */
  world: Mat4
}

/**
 * 複製選取的零件與接在它上面的零件（不含底座那一側）。
 * 例如選取集裝座上的閥：閥＋A／B 接頭＋接頭上的轉接頭…；記下它裝在集裝座的哪一種埠上。
 * 選取的是底座本身（例如集裝座）：整組（集裝座＋閥＋接頭）一起複製，貼在旁邊。
 */
export function copyUnit(doc: ModuleDoc, products: ProductMap, instanceId: string): UnitClip | undefined {
  const inst = doc.instances.find((i) => i.id === instanceId)
  if (!inst || !products[inst.productId]) return undefined
  const ends = (m: Mate, id: string) => (m.parent.instance === id ? { self: m.parent, other: m.child } : m.child.instance === id ? { self: m.child, other: m.parent } : undefined)
  // 底座：選取零件的安裝面（元件側）裝著的那一個；沒有時取鎖合樹的父零件
  const own = doc.mates.filter((m) => ends(m, instanceId))
  const viaMount = own.find((m) => {
    const spec = getPort(doc, products, ends(m, instanceId)!.self)?.spec
    return spec?.kind === 'interface' && spec.role === 'plug'
  })
  const baseMate = viaMount ?? doc.mates.find((m) => m.child.instance === instanceId)
  // 組：從選取的零件出發、不經過底座的鎖合，連得到的零件（由近到遠）
  const order = [instanceId]
  const mates: UnitClip['mates'] = []
  const index = new Map([[instanceId, 0]])
  for (let i = 0; i < order.length; i++) {
    for (const m of doc.mates) {
      if (m === baseMate) continue
      const e = ends(m, order[i])
      if (!e || index.has(e.other.instance)) continue
      index.set(e.other.instance, order.length)
      order.push(e.other.instance)
      mates.push({ near: { member: i, port: e.self.port }, far: { member: index.get(e.other.instance)!, port: e.other.port }, angle: m.angle })
    }
  }
  const instanceOf = new Map(doc.instances.map((i) => [i.id, i]))
  const base = baseMate && ends(baseMate, instanceId)
  const basePort = base && getPort(doc, products, base.other)
  return {
    members: order.map((id) => {
      const i = instanceOf.get(id)!
      return { productId: i.productId, ...(i.params && { params: i.params }) }
    }),
    mates,
    ...(base &&
      basePort?.spec && {
        mount: { baseInstance: base.other.instance, basePort: base.other.port, port: base.self.port, angle: baseMate!.angle, key: specKey(basePort.spec) },
      }),
    world: computeTransforms(doc, products).transforms[instanceId],
  }
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true })

/** 底座上可以貼這組的空埠（與原本裝的埠同規格），依名稱排序（站1、站2…） */
export function freeMountPorts(doc: ModuleDoc, products: ProductMap, clip: UnitClip, base: string): PortRef[] {
  if (!clip.mount) return []
  const inst = doc.instances.find((i) => i.id === base)
  const product = inst && products[inst.productId]
  if (!product) return []
  const used = usedPorts(doc, products)
  return [...product.ports]
    .sort(byName)
    .filter((p) => p.spec && specKey(p.spec) === clip.mount!.key && !used.has(`${base}:${p.id}`))
    .map((p) => ({ instance: base, port: p.id }))
}

export interface PasteResult {
  doc: ModuleDoc
  /** 新的零件（第 0 個對應 clip.members[0]） */
  instances: string[]
  /** 裝到底座的哪個埠；沒有空埠時 undefined（放在 freePlacement） */
  mountedOn?: PortRef
}

/**
 * 貼上一組：建立新的零件、照原樣鎖合；有底座的空埠（base 或原本的底座）就裝上去，
 * 否則放在 freePlacement（呼叫端算好不會重疊的位置）。任何一步失敗回傳 undefined（模組不變）。
 */
export function pasteUnit(doc: ModuleDoc, products: ProductMap, clip: UnitClip, options: { base?: string; freePlacement: Mat4 }): PasteResult | undefined {
  if (clip.members.some((m) => !products[m.productId])) return undefined
  let next = doc
  const ids: string[] = []
  for (const m of clip.members) {
    const r = addInstance(next, m.productId, ids.length === 0 ? options.freePlacement : undefined)
    next = m.params ? { ...r.doc, instances: r.doc.instances.map((i) => (i.id === r.instanceId ? { ...i, params: { ...m.params } } : i)) } : r.doc
    ids.push(r.instanceId)
  }
  for (const m of clip.mates) {
    const r = connect(next, products, { instance: ids[m.near.member], port: m.near.port }, { instance: ids[m.far.member], port: m.far.port }, m.angle)
    if ('error' in r) return undefined
    next = r.doc
  }
  const baseId = options.base ?? (clip.mount && doc.instances.some((i) => i.id === clip.mount!.baseInstance) ? clip.mount.baseInstance : undefined)
  const target = baseId ? freeMountPorts(next, products, clip, baseId)[0] : undefined
  if (target && clip.mount) {
    const r = connect(next, products, target, { instance: ids[0], port: clip.mount.port }, clip.mount.angle)
    if (!('error' in r)) return { doc: r.doc, instances: ids, mountedOn: target }
  }
  return { doc: next, instances: ids }
}
