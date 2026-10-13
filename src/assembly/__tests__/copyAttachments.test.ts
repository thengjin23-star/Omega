import { Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import { attachmentBranches, copyAttachments } from '../copyAttachments'
import { computeTransforms } from '../moduleOps'
import { builder, PRODUCTS, valveIsland } from './sampleModules'

/** 子零件相對於某零件的位置（4×4） */
function relative(doc: Parameters<typeof computeTransforms>[0], base: string, part: string): number[] {
  const { transforms } = computeTransforms(doc, PRODUCTS)
  const inv = new Matrix4().fromArray(transforms[base]).invert()
  return new Matrix4().multiplyMatrices(inv, new Matrix4().fromArray(transforms[part])).toArray().map((v) => Math.round(v * 1000) / 1000 + 0)
}

const attachedTo = (doc: Parameters<typeof computeTransforms>[0], instance: string, port: string) =>
  doc.mates.find((m) => (m.parent.instance === instance && m.parent.port === port) || (m.child.instance === instance && m.child.port === port))

describe('copyAttachments', () => {
  /** 兩顆相同的管接式閥：閥 1 接好 A（轉接頭＋接頭）、B、EA；閥 2 的 B 已經接了別的接頭 */
  function twoValves() {
    const b = builder()
    b.add('v1', 'DEMO-VALVE-52-01')
    b.add('v2', 'DEMO-VALVE-52-01')
    b.add('bush', 'DEMO-BUSH-R14-RC18')
    b.add('fa', 'DEMO-FITTING-R18-D6')
    b.add('fb', 'DEMO-FITTING-R18-D4')
    b.add('ea', 'DEMO-SILENCER-R18')
    b.add('other', 'DEMO-FITTING-R18-D6')
    b.mate('v1', 'A', 'bush', '1')
    b.mate('bush', '2', 'fa', '1')
    b.mate('v1', 'B', 'fb', '1')
    // 先點零件、後點閥：閥是子零件，方向不同也要能複製
    b.mate('ea', '1', 'v1', 'EA')
    b.mate('v2', 'B', 'other', '1')
    return b
  }

  it('找出接在零件上的分支（含串接的轉接頭＋接頭）', () => {
    const b = twoValves()
    const branches = attachmentBranches(b.doc, b.ids.v1)
    expect(branches.map((x) => x.members.length).sort()).toEqual([1, 1, 2])
  })

  it('照樣接到另一顆相同的閥；已經有零件的埠略過；位置與來源相同', () => {
    const b = twoValves()
    const r = copyAttachments(b.doc, PRODUCTS, b.ids.v1)
    expect(r).toMatchObject({ added: 3, targets: 1, skipped: 1, branches: 3 })
    const doc = r.doc
    expect(doc.instances).toHaveLength(7 + 3)
    // 閥 2 的 A：轉接頭，再接 Ø6 接頭
    const mA = attachedTo(doc, b.ids.v2, b.ref('v1', 'A').port)!
    const bush2 = mA.parent.instance === b.ids.v2 ? mA.child.instance : mA.parent.instance
    expect(doc.instances.find((i) => i.id === bush2)?.productId).toBe('DEMO-BUSH-R14-RC18')
    const chain = doc.mates.find((m) => m.parent.instance === bush2 || (m.child.instance === bush2 && m.id !== mA.id))!
    const fa2 = chain.parent.instance === bush2 ? chain.child.instance : chain.parent.instance
    expect(doc.instances.find((i) => i.id === fa2)?.productId).toBe('DEMO-FITTING-R18-D6')
    // 相對位置與閥 1 的相同
    expect(relative(doc, b.ids.v2, bush2)).toEqual(relative(doc, b.ids.v1, b.ids.bush))
    expect(relative(doc, b.ids.v2, fa2)).toEqual(relative(doc, b.ids.v1, b.ids.fa))
    // EA 消音器（來源是子零件的方向）也有
    const mEA = attachedTo(doc, b.ids.v2, b.ref('v1', 'EA').port)!
    const ea2 = mEA.parent.instance === b.ids.v2 ? mEA.child.instance : mEA.parent.instance
    expect(relative(doc, b.ids.v2, ea2)).toEqual(relative(doc, b.ids.v1, b.ids.ea))
    // B 埠原本的接頭不變
    expect(attachedTo(doc, b.ids.v2, b.ref('v1', 'B').port)!.child.instance).toBe(b.ids.other)
  })

  it('再套用一次不會重複加', () => {
    const b = twoValves()
    const once = copyAttachments(b.doc, PRODUCTS, b.ids.v1).doc
    const twice = copyAttachments(once, PRODUCTS, b.ids.v1)
    expect(twice.added).toBe(0)
    expect(twice.skipped).toBe(3)
  })

  it('集裝座那一側（群組的根）不算接在閥上的零件', () => {
    const b = valveIsland()
    expect(attachmentBranches(b.doc, b.ids.v1)).toEqual([])
    expect(copyAttachments(b.doc, PRODUCTS, b.ids.v1).added).toBe(0)
  })
})
