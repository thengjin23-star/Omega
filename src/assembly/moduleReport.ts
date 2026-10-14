/**
 * 搭配檢查：組好的模組（手動或依清單自動組裝）還有哪些地方沒接、哪些搭配不對，並給建議。
 * - 搭配不對：鎖合的兩端規格不合（✕）或有疑慮（!），不合時列出可用的轉接頭。
 * - 沒接：安裝面（站位）空著、螺紋口空著（排氣口提醒加消音器），列出可以接的零件（常用的排前面），可一鍵補上。
 * - 快插口空著是正常的（之後接 PU 管），只彙總成一行說明。
 */
import { findAdapters } from './adapters'
import { instanceLabels, isExhaustPort } from './autoAssemble'
import { suggestPartners } from './memory'
import { getPort, mateChecks, usedPorts, type ProductMap } from './moduleOps'
import type { ModuleDoc, PortRef } from './types'
import type { Product } from '../catalog/types'
import { formatSpec } from '../threads'

export type ReportLevel = 'error' | 'warn' | 'info'

/** 一鍵補上：在 at 這個埠接上 product 的 port */
export interface ReportFix {
  productId: string
  portId: string
  label: string
  /** 以前接過的次數（0 = 只是規格相容） */
  uses: number
  /** 建議直接補上：以前接過，或排氣口配消音器 */
  recommended: boolean
}

export interface ReportItem {
  key: string
  level: ReportLevel
  title: string
  detail?: string
  /** 沒接的埠 */
  at?: PortRef
  fixes?: ReportFix[]
  /** 相關的零件（點一下選取） */
  instance?: string
}

const LEVEL_ORDER: Record<ReportLevel, number> = { error: 0, warn: 1, info: 2 }

export function moduleReport(
  doc: ModuleDoc,
  products: ProductMap,
  options: { library?: readonly Product[]; stats?: Readonly<Record<string, number>> } = {},
): ReportItem[] {
  const library = options.library ?? Object.values(products)
  const stats = options.stats ?? {}
  const labels = instanceLabels(doc, products)
  const items: ReportItem[] = []
  const portLabel = (ref: PortRef) => `${labels.get(ref.instance) ?? '?'} 的 ${getPort(doc, products, ref)?.name ?? '?'}`

  // ---- 搭配不對 ----
  let unknown = 0
  for (const { mate, result } of mateChecks(doc, products)) {
    if (result.level === 'ok') continue
    if (result.level === 'unknown') {
      unknown++
      continue
    }
    const a = getPort(doc, products, mate.parent)?.spec
    const b = getPort(doc, products, mate.child)?.spec
    const adapters = result.level === 'error' && a && b ? findAdapters(library, a, b).slice(0, 3) : []
    items.push({
      key: `mate:${mate.id}`,
      level: result.level === 'error' ? 'error' : 'warn',
      title: `${result.level === 'error' ? '搭配不對' : '注意'}：${portLabel(mate.parent)} ↔ ${portLabel(mate.child)}`,
      detail: [
        result.summary,
        result.reasons[0],
        adapters.length ? `可改用轉接頭：${adapters.map((o) => o.product.modelCode).join('、')}` : '',
      ]
        .filter(Boolean)
        .join('；'),
      instance: mate.child.instance,
    })
  }

  // ---- 沒接的埠 ----
  const used = usedPorts(doc, products)
  const tubes = new Map<string, number>()
  let noSpec = 0
  for (const inst of doc.instances) {
    const product = products[inst.productId]
    if (!product) continue
    for (const port of product.ports) {
      if (used.has(`${inst.id}:${port.id}`)) continue
      if (doc.supply?.instance === inst.id && doc.supply.port === port.id) continue
      const spec = port.spec
      if (!spec) {
        noSpec++
        continue
      }
      // 閥底面這類「可以裝集裝座、也可以直接接管」的安裝面：不裝也沒關係
      if (spec.kind === 'interface' && product.ports.some((q) => q.sealedBy === port.id)) continue
      if (spec.kind === 'tube') {
        const key = formatSpec(spec)
        tubes.set(key, (tubes.get(key) ?? 0) + 1)
        continue
      }
      const at = { instance: inst.id, port: port.id }
      const fixes = suggestPartners({ product, port }, library, stats)
        .filter((s) => s.level === 'ok' || s.level === 'warn')
        .filter((s) => (spec.kind === 'interface' ? true : isExhaustPort(port.name) ? s.product.category === 'silencer' || s.uses > 0 : true))
        .slice(0, 3)
        .map(
          (s): ReportFix => ({
            productId: s.product.id,
            portId: s.port.id,
            label: s.product.modelCode,
            uses: s.uses,
            recommended: s.uses > 0 || (isExhaustPort(port.name) && s.product.category === 'silencer'),
          }),
        )
      if (spec.kind === 'interface') {
        items.push({
          key: `open:${inst.id}:${port.id}`,
          level: 'warn',
          title: `${labels.get(inst.id)} 的「${port.name}」空著`,
          detail: '需要裝上零件，或加盲板（蓋板）封住',
          at,
          fixes,
          instance: inst.id,
        })
      } else {
        const exhaust = isExhaustPort(port.name)
        items.push({
          key: `open:${inst.id}:${port.id}`,
          level: 'warn',
          title: exhaust ? `${labels.get(inst.id)} 的排氣口 ${port.name} 沒接消音器` : `${labels.get(inst.id)} 的 ${port.name} 埠沒接（${formatSpec(spec)}）`,
          detail: exhaust ? '會直接排到大氣、噪音大；一般會加消音器' : '需要接頭；不用的埠要加塞頭',
          at,
          fixes,
          instance: inst.id,
        })
      }
    }
  }
  if (tubes.size)
    items.push({
      key: 'tubes',
      level: 'info',
      title: `快插口 ${[...tubes].map(([k, n]) => `${k} × ${n}`).join('、')} 空著`,
      detail: '之後接 PU 管（正常）',
    })
  if (noSpec) items.push({ key: 'nospec', level: 'info', title: `${noSpec} 個埠沒有設定規格`, detail: '無法檢查搭配：請在產品庫補上規格' })
  if (unknown) items.push({ key: 'unknown', level: 'info', title: `${unknown} 個鎖合無法檢查`, detail: '至少一端的埠沒有設定規格' })
  return items.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
}
