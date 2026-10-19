import { describe, expect, it } from 'vitest'
import { mateHints } from '../mateHints'
import { addInstance } from '../moduleOps'
import { builder, PRODUCTS } from './sampleModules'

describe('接合建議', () => {
  it('選取電磁閥：先建議裝到集裝座的空站（依站號），再列可以接在 A／B 上的接頭', () => {
    const b = builder()
    b.add('m', 'DEMO-MANIFOLD-4')
    b.add('v1', 'DEMO-VALVE-52-01')
    b.mate('m', '站1', 'v1', '安裝面')
    b.add('v2', 'DEMO-VALVE-52-01')
    b.add('f', 'DEMO-FITTING-R18-D6')
    const name = (ref: { instance: string; port: string }) => {
      const inst = b.doc.instances.find((i) => i.id === ref.instance)!
      return `${inst.productId}.${PRODUCTS[inst.productId].ports.find((p) => p.id === ref.port)!.name}`
    }
    const hints = mateHints(b.doc, PRODUCTS, b.ids.v2)
    expect(hints[0].mount).toBe(true)
    // 站 1 已經有閥：建議站 2、站 3
    expect(hints.filter((h) => h.mount).map((h) => name(h.to))).toEqual(['DEMO-MANIFOLD-4.站2', 'DEMO-MANIFOLD-4.站3'])
    // 閥的 A 口可以接 R1/8 接頭；同一組（集裝座上的閥）不會被建議（避免迴圈）
    expect(hints.some((h) => name(h.from) === 'DEMO-VALVE-52-01.A' && name(h.to) === 'DEMO-FITTING-R18-D6.1')).toBe(true)
    expect(hints.every((h) => h.to.instance !== b.ids.v1)).toBe(true)
  })

  it('規格不合的不建議；兩個快插口之間不建議（要用 PU 管）', () => {
    let doc = addInstance(builder().doc, 'DEMO-FITTING-NPT18-D6').doc
    const npt = doc.instances[0].id
    doc = addInstance(doc, 'DEMO-VALVE-52-01').doc
    doc = addInstance(doc, 'DEMO-FITTING-R18-D6').doc
    const hints = mateHints(doc, PRODUCTS, npt)
    // NPT 公牙不能鎖進 Rc 母牙；Ø6 快插口與另一個接頭的 Ø6 快插口也不建議
    expect(hints).toEqual([])
  })
})
