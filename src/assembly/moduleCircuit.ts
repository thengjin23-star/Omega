import { commonChannelOf, manifoldLayout } from '../catalog/manifold'
import { effectivePneumatic, FITTING_TYPE, MANIFOLD_TYPE } from '../catalog/pneumatic'
import { productLabel, type Product } from '../catalog/types'
import { DEFAULT_SUPPLY_PRESSURE, portKey, registry, type Circuit, type CircuitNode, type Tube } from '../engine'
import { usedPorts, type ProductMap } from './moduleOps'
import type { ModuleDoc } from './types'

/**
 * 由 3D 模組推出氣動迴路（給 3D 模擬與「產生迴路圖」使用）：
 *
 * - 有氣動功能的零件（閥、氣缸、速控閥、消音器、三點組合…）是迴路的元件，功能埠依 portMap 對到產品的埠；
 *   參數 = 產品氣動功能的參數，再以零件在模組中的參數（ModuleInstance.params）覆蓋
 * - 鎖合、接頭（氣流直接通過）、PU 管把產品的埠連成「網路」（union-find）
 * - 集裝座：底板式閥裝在某一站時，閥的 P／EA／EB 接到共用通路、A／B 接到該站出口；
 *   閥本身有 P／排氣口（底面被安裝面封住，例如亞德客 4V）時，那些埠接到共用通路，A／B 用閥上的埠
 * - 供氣口：模組指定的埠接上一個氣源
 * - 空著的排氣埠視為直接排大氣；其他空著的埠視為封閉（並提出提醒）
 */

export type ModuleWarningKind = 'no-supply' | 'no-function' | 'unmapped-port' | 'unmounted-valve' | 'open-port' | 'open-exhaust'

export interface ModuleWarning {
  kind: ModuleWarningKind
  text: string
  instance?: string
  port?: string
}

/** 迴路中的一個端點（引擎節點的功能埠） */
export interface NetEndpoint {
  node: string
  port: string
}

export interface ModuleCircuit {
  circuit: Circuit
  /** 引擎節點 → 模組零件；供氣口、排氣口等虛擬節點沒有對應零件 */
  nodeInstance: Record<string, string | undefined>
  /** 每個網路的引擎端點 */
  nets: NetEndpoint[][]
  /** 產品埠（instance:port）→ 網路編號 */
  netOfPort: Record<string, number>
  /** PU 管 id → 網路編號 */
  netOfTube: Record<string, number>
  warnings: ModuleWarning[]
}

export const SUPPLY_NODE = 'supply'

class UnionFind {
  private parent = new Map<string, string>()

  find(x: string): string {
    let root = x
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!
    // 路徑壓縮
    let cur = x
    while (cur !== root) {
      const next = this.parent.get(cur) ?? root
      this.parent.set(cur, root)
      cur = next
    }
    if (!this.parent.has(root)) this.parent.set(root, root)
    return root
  }

  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

const phys = (instance: string, port: string) => `${instance}:${port}`
const func = (node: string, port: string) => `@${node}:${port}`

/** 底板式閥的功能埠要接到集裝座的哪個通路 */
function manifoldTarget(portId: string, layout: NonNullable<ReturnType<typeof manifoldLayout>>, station: { A?: string; B?: string }): string | undefined {
  const c = layout.common
  switch (portId) {
    case 'P':
      return c.P
    case 'A':
      return station.A
    case 'B':
      return station.B
    case 'EA':
      return c.EA ?? c.R
    case 'EB':
      return c.EB ?? c.R
    case 'R':
      // 3 口閥：排氣接共用排氣（沒有單一 R 時接 EA）
      return c.R ?? c.EA ?? c.EB
    default:
      return undefined
  }
}

export function deriveModuleCircuit(doc: ModuleDoc, products: ProductMap): ModuleCircuit {
  const uf = new UnionFind()
  const warnings: ModuleWarning[] = []
  const nodes: CircuitNode[] = []
  const nodeInstance: Record<string, string | undefined> = {}
  const instanceOf = new Map(doc.instances.map((i) => [i.id, i]))
  const productOf = (instance: string): Product | undefined => {
    const inst = instanceOf.get(instance)
    return inst && products[inst.productId]
  }
  const label = (instance: string) => {
    const p = productOf(instance)
    return p ? p.modelCode || productLabel(p) : instance
  }
  const portName = (instance: string, port: string) => productOf(instance)?.ports.find((p) => p.id === port)?.name ?? port
  const isInterface = (instance: string, port: string) => productOf(instance)?.ports.find((p) => p.id === port)?.spec?.kind === 'interface'

  // 產品的每個埠都先登記（沒有任何連接的埠也要有網路）
  for (const inst of doc.instances) for (const port of productOf(inst.id)?.ports ?? []) uf.find(phys(inst.id, port.id))

  // ---- 鎖合：管路埠直接相通；安裝面記下「哪個閥裝在集裝座的哪一站」 ----
  const mountedOn = new Map<string, { manifold: string; mount: string; own: string }>()
  for (const m of doc.mates) {
    const a = m.parent
    const b = m.child
    if (isInterface(a.instance, a.port) || isInterface(b.instance, b.port)) {
      const pa = productOf(a.instance)
      const pb = productOf(b.instance)
      if (pa && effectivePneumatic(pa)?.type === MANIFOLD_TYPE) mountedOn.set(b.instance, { manifold: a.instance, mount: a.port, own: b.port })
      else if (pb && effectivePneumatic(pb)?.type === MANIFOLD_TYPE) mountedOn.set(a.instance, { manifold: b.instance, mount: b.port, own: a.port })
      continue
    }
    uf.union(phys(a.instance, a.port), phys(b.instance, b.port))
  }
  // ---- PU 管 ----
  for (const t of doc.tubes ?? []) uf.union(phys(t.a.instance, t.a.port), phys(t.b.instance, t.b.port))

  // ---- 零件的氣動功能 ----
  const baseMounted: { instance: string; type: string }[] = []
  for (const inst of doc.instances) {
    const product = productOf(inst.id)
    if (!product) continue
    const fn = effectivePneumatic(product)
    if (!fn) {
      if (product.category !== 'other') warnings.push({ kind: 'no-function', text: `「${label(inst.id)}」沒有設定氣動功能，模擬時視為封閉`, instance: inst.id })
      continue
    }
    if (fn.type === FITTING_TYPE) {
      // 接頭、轉接頭、接管座：所有管路埠相通
      const piping = product.ports.filter((p) => p.spec?.kind !== 'interface')
      for (let i = 1; i < piping.length; i++) uf.union(phys(inst.id, piping[0].id), phys(inst.id, piping[i].id))
      continue
    }
    if (fn.type === MANIFOLD_TYPE || !registry.has(fn.type)) continue
    const def = registry.get(fn.type)
    // 零件在模組中的參數（氣缸代號、線圈訊號、負載…）覆蓋產品的參數
    nodes.push({ id: inst.id, type: fn.type, params: inst.params ? { ...fn.params, ...inst.params } : fn.params })
    nodeInstance[inst.id] = inst.id
    const piping = product.ports.filter((p) => p.spec?.kind !== 'interface')
    if (!piping.length && product.ports.some((p) => p.spec?.kind === 'interface')) {
      baseMounted.push({ instance: inst.id, type: fn.type })
      continue
    }
    for (const port of def.ports) {
      const target = fn.portMap[port.id]
      if (target && product.ports.some((p) => p.id === target)) uf.union(func(inst.id, port.id), phys(inst.id, target))
      else {
        uf.find(func(inst.id, port.id))
        warnings.push({ kind: 'unmapped-port', text: `「${label(inst.id)}」的功能埠 ${port.id} 沒有對應到產品的埠`, instance: inst.id, port: port.id })
      }
    }
  }

  // ---- 裝在集裝座上的閥：底面被安裝面封住的 P／排氣口接到集裝座的共用通路（A／B 在閥上） ----
  for (const [instance, on] of mountedOn) {
    const product = productOf(instance)
    const manifold = productOf(on.manifold)
    const layout = manifold && manifoldLayout(manifold)
    if (!product || !layout) continue
    for (const port of product.ports) {
      if (port.sealedBy !== on.own) continue
      const target = commonChannelOf(layout, port.name)
      if (target) uf.union(phys(instance, port.id), phys(on.manifold, target))
    }
  }

  // ---- 底板式閥：經由集裝座的通路 ----
  for (const { instance, type } of baseMounted) {
    const def = registry.get(type)
    const on = mountedOn.get(instance)
    const manifold = on && productOf(on.manifold)
    const layout = manifold && manifoldLayout(manifold)
    const station = layout?.stations.find((s) => s.mount === on!.mount)
    if (!on || !layout || !station) {
      warnings.push({ kind: 'unmounted-valve', text: `底板式閥「${label(instance)}」沒有裝在集裝座上`, instance })
      for (const port of def.ports) uf.find(func(instance, port.id))
      continue
    }
    for (const port of def.ports) {
      const target = manifoldTarget(port.id, layout, station)
      if (target) uf.union(func(instance, port.id), phys(on.manifold, target))
      else uf.find(func(instance, port.id))
    }
  }

  // ---- 供氣口 ----
  if (doc.supply && productOf(doc.supply.instance)?.ports.some((p) => p.id === doc.supply!.port)) {
    nodes.push({ id: SUPPLY_NODE, type: 'airSupply', params: { pressure: doc.supply.pressure ?? DEFAULT_SUPPLY_PRESSURE } })
    nodeInstance[SUPPLY_NODE] = undefined
    uf.union(func(SUPPLY_NODE, 'P'), phys(doc.supply.instance, doc.supply.port))
  } else {
    warnings.push({ kind: 'no-supply', text: '還沒有指定供氣口：選一個埠設為供氣口後才能模擬' })
  }

  // ---- 整理網路 ----
  const groups = new Map<string, { endpoints: NetEndpoint[]; ports: string[] }>()
  const groupOf = (key: string) => {
    const root = uf.find(key)
    let g = groups.get(root)
    if (!g) groups.set(root, (g = { endpoints: [], ports: [] }))
    return g
  }
  for (const node of nodes) for (const port of registry.get(node.type).ports) groupOf(func(node.id, port.id)).endpoints.push({ node: node.id, port: port.id })
  for (const inst of doc.instances) for (const port of productOf(inst.id)?.ports ?? []) groupOf(phys(inst.id, port.id)).ports.push(phys(inst.id, port.id))

  // 空著的產品埠：沒有鎖合、沒有 PU 管、不是供氣口
  // （裝在集裝座上的閥，底面被封住的埠也算接了：由集裝座供氣、排氣）
  const used = usedPorts(doc, products)
  if (doc.supply) used.add(phys(doc.supply.instance, doc.supply.port))
  const roleOf = (e: NetEndpoint) => registry.get(nodes.find((n) => n.id === e.node)!.type).ports.find((p) => p.id === e.port)?.role

  let vents = 0
  const nets: NetEndpoint[][] = []
  const netOfPort: Record<string, number> = {}
  for (const g of groups.values()) {
    const open = g.ports.filter((k) => !used.has(k) && !isInterfaceKey(k))
    const onlyExhaust = g.endpoints.length > 0 && g.endpoints.every((e) => roleOf(e) === 'exhaust')
    if (open.length && onlyExhaust) {
      // 閥的排氣經由空著的埠直接排大氣
      const id = `vent${++vents}`
      nodes.push({ id, type: 'exhaust' })
      nodeInstance[id] = undefined
      g.endpoints.push({ node: id, port: 'E' })
      for (const key of open) {
        const [instance, port] = splitKey(key)
        warnings.push({ kind: 'open-exhaust', text: `「${label(instance)}」的 ${portName(instance, port)} 直接排大氣（建議加裝消音器）`, instance, port })
      }
    } else if (open.length && g.endpoints.length) {
      for (const key of open) {
        const [instance, port] = splitKey(key)
        warnings.push({ kind: 'open-port', text: `「${label(instance)}」的 ${portName(instance, port)} 沒有接（模擬時視為封閉）`, instance, port })
      }
    }
    const index = nets.length
    nets.push(g.endpoints)
    for (const key of g.ports) netOfPort[key] = index
  }

  // 每個網路的端點以管線串起來（引擎的管線是理想導通）
  const tubes: Tube[] = []
  nets.forEach((endpoints, i) => {
    for (let k = 1; k < endpoints.length; k++)
      tubes.push({ id: `net${i}-${k}`, from: portKey(endpoints[0].node, endpoints[0].port), to: portKey(endpoints[k].node, endpoints[k].port) })
  })
  const netOfTube: Record<string, number> = {}
  for (const t of doc.tubes ?? []) {
    const n = netOfPort[phys(t.a.instance, t.a.port)]
    if (n !== undefined) netOfTube[t.id] = n
  }
  // 重要的提醒排前面
  const order: ModuleWarningKind[] = ['no-supply', 'unmounted-valve', 'unmapped-port', 'no-function', 'open-exhaust', 'open-port']
  warnings.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  return { circuit: { nodes, tubes }, nodeInstance, nets, netOfPort, netOfTube, warnings }

  function isInterfaceKey(key: string) {
    const [instance, port] = splitKey(key)
    return isInterface(instance, port)
  }
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(':')
  return [key.slice(0, i), key.slice(i + 1)]
}
