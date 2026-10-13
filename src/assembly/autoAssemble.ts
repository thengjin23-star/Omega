/**
 * 依型號清單自動組裝：使用者只給「要用哪些零件、各幾個」，系統依埠的規格（螺紋、快插管徑、安裝面）、
 * 以前的搭配記錄、埠的用途（排氣口配消音器）與清單上指定的埠，決定每個零件接在哪裡。
 *
 * 1. 先選「底座」：集裝座優先，否則選能接最多其他零件的產品。
 * 2. 反覆在已放好的零件的空埠上，放分數最高的一組（安裝面最先 → 指定埠 → 用過的搭配 → 埠的用途）。
 *    轉接頭接上後，它的另一端也成為空埠，接頭就能接在轉接頭上。
 * 3. 接不上的零件如果能自己當底座（例如氣缸＋速度控制閥），另起一組；否則列為「沒有接上」並說明原因。
 */
import { findAdapters } from './adapters'
import { exactKey, specStatKey } from './memory'
import { addInstance, connect, createModule, usedPorts, type ProductMap } from './moduleOps'
import { normalizePortName } from './partsList'
import type { ModuleDoc } from './types'
import type { Product, ProductPort } from '../catalog/types'
import { checkMate, formatSpec, type MateLevel } from '../threads'

export interface AssembleItem {
  product: Product
  qty: number
  /** 指定要接的埠名稱（與零件） */
  hint?: { target?: Product; ports: string[] }
  /** 清單第幾行 */
  line?: number
}

export interface Leftover {
  item: number
  qty: number
  reason: string
  /** 加一個轉接頭就能接上的方案 */
  adapters: { adapter: Product; at: string }[]
}

export interface AssembleResult {
  doc: ModuleDoc
  leftovers: Leftover[]
  /** 各組的根零件（依建立順序；之後依序排在右側） */
  roots: string[]
  /** 零件 → 清單項目 */
  itemOf: Record<string, number>
}

/** 排氣用的埠名稱：優先接消音器 */
const EXHAUST_NAMES = new Set(['E', 'EA', 'EB', 'R', 'R1', 'R2', '3', '5', 'EXH', 'EXHAUST', '排氣'])
export const isExhaustPort = (name: string) => EXHAUST_NAMES.has(normalizePortName(name))

const usable = (level: MateLevel) => level === 'ok' || level === 'warn'

/** 指定的埠名稱：完全相同，或後面只多了站號數字（指定「A」也符合集裝座的 A1、A2…） */
export function portMatchesHint(portName: string, hint: string): boolean {
  const p = normalizePortName(portName)
  const h = normalizePortName(hint)
  return p === h || (p.startsWith(h) && /^\d+$/.test(p.slice(h.length)))
}

/** 零件的顯示名稱：型號，同型號有多個時加上 #n */
export function instanceLabels(doc: ModuleDoc, products: ProductMap): Map<string, string> {
  const total = new Map<string, number>()
  for (const i of doc.instances) total.set(i.productId, (total.get(i.productId) ?? 0) + 1)
  const seen = new Map<string, number>()
  const labels = new Map<string, string>()
  for (const i of doc.instances) {
    const n = (seen.get(i.productId) ?? 0) + 1
    seen.set(i.productId, n)
    const code = products[i.productId]?.modelCode || '（未知零件）'
    labels.set(i.id, (total.get(i.productId) ?? 0) > 1 ? `${code} #${n}` : code)
  }
  return labels
}

interface Candidate {
  instance: string
  port: ProductPort
  item: number
  childPort: ProductPort
  score: number
}

export function autoAssemble(
  items: readonly AssembleItem[],
  products: ProductMap,
  options: { name?: string; customer?: string; stats?: Readonly<Record<string, number>>; library?: readonly Product[] } = {},
): AssembleResult {
  const stats = options.stats ?? {}
  const all: ProductMap = { ...products, ...Object.fromEntries(items.map((i) => [i.product.id, i.product])) }
  let doc: ModuleDoc = createModule(options.name || '未命名模組')
  if (options.customer) doc = { ...doc, customer: options.customer }
  const remaining = items.map((i) => Math.max(0, Math.floor(i.qty)))
  const itemOf: Record<string, number> = {}
  const roots: string[] = []
  const hasSpecs = (p: Product) => p.ports.some((port) => port.spec)

  const add = (k: number) => {
    const r = addInstance(doc, items[k].product.id)
    doc = r.doc
    itemOf[r.instanceId] = k
    remaining[k]--
    return r.instanceId
  }

  const hintAllows = (k: number, host: Product, port: ProductPort) => {
    const hint = items[k].hint
    if (!hint) return true
    if (hint.target && hint.target.id !== host.id) return false
    if (hint.ports.length && !hint.ports.some((h) => portMatchesHint(port.name, h))) return false
    return true
  }

  const candidates = (): Candidate[] => {
    const used = usedPorts(doc)
    const list: Candidate[] = []
    doc.instances.forEach((inst, instOrder) => {
      const host = all[inst.productId]
      host?.ports.forEach((port, portOrder) => {
        const spec = port.spec
        if (!spec || used.has(`${inst.id}:${port.id}`)) return
        items.forEach((item, k) => {
          if (!remaining[k] || !hintAllows(k, host, port)) return
          for (const childPort of item.product.ports) {
            const level = checkMate(spec, childPort.spec).level
            if (!usable(level)) continue
            const memory = Math.min(
              100,
              (stats[exactKey({ product: host.id, port: port.id }, { product: item.product.id, port: childPort.id })] ?? 0) * 10 +
                (stats[specStatKey(spec, { product: item.product.id, port: childPort.id })] ?? 0) * 3,
            )
            const exhaust = isExhaustPort(port.name)
            const silencer = item.product.category === 'silencer'
            const role = exhaust === silencer ? (silencer ? 60 : 0) : -60
            const score =
              (spec.kind === 'interface' ? 1000 : 0) +
              (item.hint ? 300 : 0) +
              memory +
              role +
              (level === 'ok' ? 5 : 0) -
              instOrder * 0.01 -
              portOrder * 0.0001 -
              k * 0.000001
            list.push({ instance: inst.id, port, item: k, childPort, score })
          }
        })
      })
    })
    return list
  }

  /** 選下一個底座：集裝座優先，其次是能接最多其他零件的產品；第二組起一定要能接上其他零件 */
  const pickRoot = (): number | undefined => {
    let best: number | undefined
    let bestScore = -Infinity
    items.forEach((item, k) => {
      if (!remaining[k] || !hasSpecs(item.product)) return
      let accepts = 0
      items.forEach((other, j) => {
        if (!remaining[j] || (j === k && remaining[k] < 2)) return
        const fits = item.product.ports.some((p) => other.product.ports.some((q) => usable(checkMate(p.spec, q.spec).level)))
        if (fits) accepts++
      })
      if (roots.length && !accepts) return
      const score = (item.product.category === 'manifold' ? 1000 : 0) + accepts * 10 + item.product.ports.length
      if (score > bestScore) {
        bestScore = score
        best = k
      }
    })
    return best
  }

  for (let guard = 0; guard < 2000; guard++) {
    const list = candidates()
    if (list.length) {
      const c = list.reduce((a, b) => (b.score > a.score ? b : a))
      const child = add(c.item)
      const r = connect(doc, all, { instance: c.instance, port: c.port.id }, { instance: child, port: c.childPort.id })
      if ('error' in r) {
        // 理論上不會發生（埠都是空的）；保險起見把剛加的零件拿掉並停止這個項目
        doc = { ...doc, instances: doc.instances.filter((i) => i.id !== child) }
        delete itemOf[child]
        remaining[c.item] = 0
        continue
      }
      doc = r.doc
      continue
    }
    const k = pickRoot()
    if (k === undefined) break
    roots.push(add(k))
  }

  // ---- 沒有接上的零件：原因與建議 ----
  const labels = instanceLabels(doc, all)
  const library = options.library ?? Object.values(products)
  const used = usedPorts(doc)
  const leftovers: Leftover[] = []
  items.forEach((item, k) => {
    if (!remaining[k]) return
    const p = item.product
    const specs = p.ports.filter((x) => x.spec).map((x) => `${x.name} ${formatSpec(x.spec!)}`)
    let reason: string
    const adapters: Leftover['adapters'] = []
    if (!p.ports.length) reason = '產品還沒有定義埠，無法自動組裝：請在產品庫匯入 3D 檔並設定埠'
    else if (!specs.length) reason = '埠沒有設定規格（螺紋、管徑或安裝面），無法判斷要接在哪：請在產品庫補上'
    else if (item.hint?.target && !doc.instances.some((i) => i.productId === item.hint!.target!.id))
      reason = `指定接在「${item.hint.target.modelCode}」，但模組中沒有這個零件`
    else {
      const compatibleSomewhere = doc.instances.some((inst) =>
        (all[inst.productId]?.ports ?? []).some((port) => hintAllows(k, all[inst.productId], port) && p.ports.some((q) => usable(checkMate(port.spec, q.spec).level))),
      )
      if (compatibleSomewhere) reason = item.hint?.ports.length ? `指定的埠（${item.hint.ports.join('、')}）都已經接了零件` : '規格相容的埠都已經接滿了（數量比可以接的埠多）'
      else {
        reason = `模組上沒有規格相容的空埠（這個零件：${specs.join('、')}）`
        // 加一個轉接頭就能接上的位置
        for (const inst of doc.instances) {
          for (const port of all[inst.productId]?.ports ?? []) {
            if (!port.spec || used.has(`${inst.id}:${port.id}`) || port.spec.kind === 'tube') continue
            for (const q of p.ports) {
              if (!q.spec) continue
              const option = findAdapters(library, port.spec, q.spec)[0]
              if (option && adapters.length < 3 && !adapters.some((a) => a.adapter.id === option.product.id && a.at === `${labels.get(inst.id)} 的 ${port.name}`))
                adapters.push({ adapter: option.product, at: `${labels.get(inst.id)} 的 ${port.name}` })
            }
          }
        }
      }
    }
    leftovers.push({ item: k, qty: remaining[k], reason, adapters })
  })
  return { doc, leftovers, roots, itemOf }
}
