import { describe, expect, it } from 'vitest'
import { autoAssemble, instanceLabels, portMatchesHint, type AssembleItem } from '../autoAssemble'
import { exactKey } from '../memory'
import { addInstance, connect, createModule, getPort, mateChecks } from '../moduleOps'
import { moduleReport } from '../moduleReport'
import type { ModuleDoc } from '../types'
import { PRODUCTS, portId } from './sampleModules'

const P = (code: string) => PRODUCTS[code]
const item = (code: string, qty = 1, hint?: { target?: string; ports: string[] }): AssembleItem => ({
  product: P(code),
  qty,
  ...(hint && { hint: { ports: hint.ports, ...(hint.target && { target: P(hint.target) }) } }),
})

/** 每個鎖合：「父零件型號.埠 ← 子零件型號」 */
function placements(doc: ModuleDoc) {
  const codeOf = (id: string) => doc.instances.find((i) => i.id === id)!.productId
  return doc.mates.map((m) => `${codeOf(m.parent.instance)}.${getPort(doc, PRODUCTS, m.parent)!.name}←${codeOf(m.child.instance)}`)
}
const on = (doc: ModuleDoc, host: string, port: string) => placements(doc).filter((p) => p.startsWith(`${host}.${port}←`)).map((p) => p.split('←')[1])

describe('autoAssemble', () => {
  it('亞德客式閥島：閥橫跨在集裝座站位上，A／B 接頭在閥上，P 接頭與消音器在集裝座端面', () => {
    // 與「依清單組裝」的範例清單相同：P 與消音器沒有指定零件，閥底面的 P／EA／EB 裝上後已封住，只剩集裝座的
    const r = autoAssemble(
      [
        item('DEMO-MANIFOLD-4'),
        item('DEMO-VALVE-52-01', 4),
        item('DEMO-FITTING-R18-D6', 4, { ports: ['A'] }),
        item('DEMO-FITTING-R18-D4', 4, { ports: ['B'] }),
        item('DEMO-FITTING-R18-D6', 1, { ports: ['P'] }),
        item('DEMO-SILENCER-R18', 2, { ports: ['EA', 'EB'] }),
      ],
      PRODUCTS,
      { name: '閥島' },
    )
    expect(r.leftovers).toEqual([])
    expect(r.roots).toHaveLength(1)
    expect(r.doc.instances.find((i) => i.id === r.roots[0])!.productId).toBe('DEMO-MANIFOLD-4')
    expect(r.doc.instances).toHaveLength(16)
    for (const st of ['站1', '站2', '站3', '站4']) expect(on(r.doc, 'DEMO-MANIFOLD-4', st)).toEqual(['DEMO-VALVE-52-01'])
    expect(on(r.doc, 'DEMO-VALVE-52-01', 'A')).toEqual(Array(4).fill('DEMO-FITTING-R18-D6'))
    expect(on(r.doc, 'DEMO-VALVE-52-01', 'B')).toEqual(Array(4).fill('DEMO-FITTING-R18-D4'))
    expect(on(r.doc, 'DEMO-VALVE-52-01', 'P')).toEqual([])
    expect(on(r.doc, 'DEMO-MANIFOLD-4', 'P')).toEqual(['DEMO-FITTING-R18-D6'])
    expect(on(r.doc, 'DEMO-MANIFOLD-4', 'EA')).toEqual(['DEMO-SILENCER-R18'])
    expect(on(r.doc, 'DEMO-MANIFOLD-4', 'EB')).toEqual(['DEMO-SILENCER-R18'])
    expect(mateChecks(r.doc, PRODUCTS).every((c) => c.result.level === 'ok')).toBe(true)
    // 閥底面的埠由集裝座封住，不算空著
    const report = moduleReport(r.doc, PRODUCTS)
    expect(report.filter((x) => x.level !== 'info')).toEqual([])
    expect(report.map((x) => x.title)).toEqual(['快插口 Ø6 快插 × 5、Ø4 快插 × 4 空著'])
  })

  it('底板式閥島：集裝座當底座，閥裝在站位，接頭依指定埠，轉接頭＋接頭串接，消音器到排氣口', () => {
    const r = autoAssemble(
      [
        item('SUBBASE-VALVE-VB', 4),
        item('DEMO-FITTING-R18-D6', 4, { ports: ['A'] }),
        item('DEMO-FITTING-R18-D4', 4, { ports: ['B'] }),
        item('SUBBASE-MANIFOLD-4'),
        item('DEMO-BUSH-R14-RC18'),
        item('DEMO-FITTING-R18-D6', 1, { target: 'DEMO-BUSH-R14-RC18', ports: [] }),
        item('DEMO-SILENCER-R18', 2),
      ],
      PRODUCTS,
      { name: '閥島' },
    )
    expect(r.leftovers).toEqual([])
    expect(r.roots).toHaveLength(1)
    expect(r.doc.instances.find((i) => i.id === r.roots[0])!.productId).toBe('SUBBASE-MANIFOLD-4')
    expect(r.doc.instances).toHaveLength(17)
    for (const st of ['站1', '站2', '站3', '站4']) expect(on(r.doc, 'SUBBASE-MANIFOLD-4', st)).toEqual(['SUBBASE-VALVE-VB'])
    for (const n of [1, 2, 3, 4]) {
      expect(on(r.doc, 'SUBBASE-MANIFOLD-4', `A${n}`)).toEqual(['DEMO-FITTING-R18-D6'])
      expect(on(r.doc, 'SUBBASE-MANIFOLD-4', `B${n}`)).toEqual(['DEMO-FITTING-R18-D4'])
    }
    expect(on(r.doc, 'SUBBASE-MANIFOLD-4', 'P')).toEqual(['DEMO-BUSH-R14-RC18'])
    expect(on(r.doc, 'DEMO-BUSH-R14-RC18', '2')).toEqual(['DEMO-FITTING-R18-D6'])
    expect(on(r.doc, 'SUBBASE-MANIFOLD-4', 'EA')).toEqual(['DEMO-SILENCER-R18'])
    expect(on(r.doc, 'SUBBASE-MANIFOLD-4', 'EB')).toEqual(['DEMO-SILENCER-R18'])
    // 所有搭配都正確
    expect(mateChecks(r.doc, PRODUCTS).every((c) => c.result.level === 'ok')).toBe(true)
    // 檢查：沒有問題，只有快插口的說明
    const report = moduleReport(r.doc, PRODUCTS)
    expect(report.filter((x) => x.level !== 'info')).toEqual([])
    expect(report.map((x) => x.title)).toEqual(['快插口 Ø6 快插 × 5、Ø4 快插 × 4 空著'])
  })

  it('沒有指定埠：消音器優先接排氣口；用過的搭配優先', () => {
    const r = autoAssemble([item('DEMO-VALVE-52-01'), item('DEMO-FITTING-R18-D4', 2), item('DEMO-FITTING-R18-D6'), item('DEMO-SILENCER-R18', 2)], PRODUCTS)
    expect(r.leftovers).toEqual([])
    expect(on(r.doc, 'DEMO-VALVE-52-01', 'EA')).toEqual(['DEMO-SILENCER-R18'])
    expect(on(r.doc, 'DEMO-VALVE-52-01', 'EB')).toEqual(['DEMO-SILENCER-R18'])
    // 記錄過「P 接 Ø6」：Ø6 就放到 P
    const stats = { [exactKey({ product: 'DEMO-VALVE-52-01', port: portId('DEMO-VALVE-52-01', 'P') }, { product: 'DEMO-FITTING-R18-D6', port: portId('DEMO-FITTING-R18-D6', '1') })]: 3 }
    const r2 = autoAssemble([item('DEMO-VALVE-52-01'), item('DEMO-FITTING-R18-D4', 2), item('DEMO-FITTING-R18-D6'), item('DEMO-SILENCER-R18', 2)], PRODUCTS, { stats })
    expect(on(r2.doc, 'DEMO-VALVE-52-01', 'P')).toEqual(['DEMO-FITTING-R18-D6'])
    expect(on(r2.doc, 'DEMO-VALVE-52-01', 'A')).toEqual(['DEMO-FITTING-R18-D4'])
  })

  it('接不上的零件：另起一組（氣缸＋速度控制閥），或列出原因', () => {
    const r = autoAssemble(
      [item('DEMO-VALVE-52-01'), item('DEMO-FITTING-R18-D4', 7), item('DEMO-CYL-16-50'), item('DEMO-SC-M5-D4', 2), item('DEMO-FITTING-NPT18-D6')],
      PRODUCTS,
    )
    expect(r.roots.map((id) => r.doc.instances.find((i) => i.id === id)!.productId)).toEqual(['DEMO-VALVE-52-01', 'DEMO-CYL-16-50'])
    expect(on(r.doc, 'DEMO-CYL-16-50', 'A')).toEqual(['DEMO-SC-M5-D4'])
    expect(on(r.doc, 'DEMO-CYL-16-50', 'B')).toEqual(['DEMO-SC-M5-D4'])
    const left = Object.fromEntries(r.leftovers.map((l) => [l.item, l]))
    // Ø4 接頭 7 個，閥只有 5 個埠
    expect(left[1]).toMatchObject({ qty: 2 })
    expect(left[1].reason).toContain('接滿')
    // NPT 接頭：閥的 Rc 埠不相容（閥的埠也都接滿了）
    expect(left[4].reason).toMatch(/接滿|沒有規格相容/)
  })

  it('指定的零件不在清單中', () => {
    const r = autoAssemble([item('DEMO-VALVE-52-01'), item('DEMO-SILENCER-R18', 1, { target: 'SUBBASE-MANIFOLD-4', ports: ['EA'] })], PRODUCTS)
    expect(r.leftovers[0].reason).toContain('SUBBASE-MANIFOLD-4')
  })

  it('指定埠的名稱比對', () => {
    expect(portMatchesHint('A1', 'A')).toBe(true)
    expect(portMatchesHint('a 埠', 'A')).toBe(true)
    expect(portMatchesHint('AB', 'A')).toBe(false)
    expect(portMatchesHint('EA', 'E')).toBe(false)
  })
})

describe('moduleReport', () => {
  it('沒接的埠（排氣口提醒消音器）、搭配不對（NPT 接 Rc）與建議', () => {
    let doc = createModule('檢查')
    const add = (code: string) => {
      const r = addInstance(doc, code)
      doc = r.doc
      return r.instanceId
    }
    const v = add('DEMO-VALVE-52-01')
    const npt = add('DEMO-FITTING-NPT18-D6')
    const r = connect(doc, PRODUCTS, { instance: v, port: portId('DEMO-VALVE-52-01', 'A') }, { instance: npt, port: portId('DEMO-FITTING-NPT18-D6', '1') })
    if ('error' in r) throw new Error(r.error)
    doc = r.doc
    const report = moduleReport(doc, PRODUCTS)
    const byTitle = (t: string) => report.find((x) => x.title.includes(t))
    expect(report[0].level).toBe('error')
    expect(report[0].title).toContain('搭配不對')
    expect(report[0].detail).toMatch(/NPT|牙/)
    const ea = byTitle('排氣口 EA')!
    expect(ea.level).toBe('warn')
    expect(ea.fixes!.map((f) => f.label)).toEqual(['DEMO-SILENCER-R18'])
    const b = byTitle('B 埠沒接')!
    expect(b.fixes!.map((f) => f.label)).toEqual(expect.arrayContaining(['DEMO-FITTING-R18-D4', 'DEMO-FITTING-R18-D6']))
    expect(b.at).toEqual({ instance: v, port: portId('DEMO-VALVE-52-01', 'B') })
    expect(instanceLabels(doc, PRODUCTS).get(v)).toBe('DEMO-VALVE-52-01')
  })
})
