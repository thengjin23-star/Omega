import { Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import { computeTransforms, getPort, setMateAngle } from '../moduleOps'
import { moduleReport } from '../moduleReport'
import { copyUnit, freeMountPorts, pasteUnit } from '../unitClipboard'
import { builder, PRODUCTS } from './sampleModules'

/** 集裝座＋站 1 的閥（A Ø6、B Ø4 接頭） */
function island() {
  const b = builder()
  b.add('m', 'DEMO-MANIFOLD-4')
  b.add('v', 'DEMO-VALVE-52-01')
  b.mate('m', '站1', 'v', '安裝面')
  b.add('fa', 'DEMO-FITTING-R18-D6')
  b.add('fb', 'DEMO-FITTING-R18-D4')
  b.mate('v', 'A', 'fa', '1')
  b.mate('v', 'B', 'fb', '1')
  return b
}

const FREE = new Matrix4().makeTranslation(500, 0, 0).toArray()
const stationOf = (doc: ReturnType<typeof island>['doc'], ref: { instance: string; port: string } | undefined) => ref && getPort(doc, PRODUCTS, ref)?.name

describe('複製、貼上一組零件', () => {
  it('複製集裝座上的閥：閥＋接在閥上的接頭，記下裝在哪一種站位（不含集裝座）', () => {
    const b = island()
    const clip = copyUnit(b.doc, PRODUCTS, b.ids.v)!
    expect(clip.members.map((m) => m.productId)).toEqual(['DEMO-VALVE-52-01', 'DEMO-FITTING-R18-D6', 'DEMO-FITTING-R18-D4'])
    expect(clip.mates).toHaveLength(2)
    expect(clip.mount).toMatchObject({ baseInstance: b.ids.m })
    expect(freeMountPorts(b.doc, PRODUCTS, clip, b.ids.m).map((r) => stationOf(b.doc, r))).toEqual(['站2', '站3', '站4'])
  })

  it('連續貼上：依序裝到站 2、3、4，位置只差站距；站滿了放在旁邊', () => {
    const b = island()
    const clip = copyUnit(b.doc, PRODUCTS, b.ids.v)!
    let doc = b.doc
    const placed: string[] = []
    const valves: string[] = []
    for (let k = 0; k < 4; k++) {
      const r = pasteUnit(doc, PRODUCTS, clip, { freePlacement: FREE })!
      doc = r.doc
      placed.push(stationOf(doc, r.mountedOn) ?? '旁邊')
      valves.push(r.instances[0])
    }
    expect(placed).toEqual(['站2', '站3', '站4', '旁邊'])
    expect(doc.instances).toHaveLength(4 + 4 * 3)
    const t = computeTransforms(doc, PRODUCTS).transforms
    const x = (id: string) => t[id][12]
    // 站距 20 mm：閥與它的接頭一起平移
    expect(x(valves[0]) - x(b.ids.v)).toBeCloseTo(20, 6)
    expect(x(valves[2]) - x(b.ids.v)).toBeCloseTo(60, 6)
    for (let i = 0; i < 16; i++) if (i < 12 || i > 14) expect(t[valves[1]][i]).toBeCloseTo(t[b.ids.v][i], 9)
    // 第 4 次：沒有空站，放在指定的位置，自己是一組
    expect(x(valves[3])).toBeCloseTo(500, 6)
    // 搭配檢查：沒有錯誤
    expect(moduleReport(doc, PRODUCTS).filter((r) => r.level === 'error')).toEqual([])
  })

  it('貼上的零件與原本的彼此獨立：改一組的鎖合角度，另一組不變', () => {
    const b = island()
    const clip = copyUnit(b.doc, PRODUCTS, b.ids.v)!
    const r = pasteUnit(b.doc, PRODUCTS, clip, { freePlacement: FREE })!
    const copyFitting = r.instances[1]
    const mate = r.doc.mates.find((m) => m.child.instance === copyFitting || m.parent.instance === copyFitting)!
    const before = computeTransforms(r.doc, PRODUCTS).transforms[b.ids.fa]
    const doc = setMateAngle(r.doc, mate.id, 90)
    expect(computeTransforms(doc, PRODUCTS).transforms[b.ids.fa]).toEqual(before)
    expect(doc.mates.find((m) => m.child.instance === b.ids.fa || m.parent.instance === b.ids.fa)!.angle).toBe(0)
  })

  it('貼到另一個集裝座：選取的底座有同規格的空站就裝上去', () => {
    const b = island()
    b.add('m2', 'DEMO-MANIFOLD-4')
    const clip = copyUnit(b.doc, PRODUCTS, b.ids.v)!
    const r = pasteUnit(b.doc, PRODUCTS, clip, { base: b.ids.m2, freePlacement: FREE })!
    expect(r.mountedOn?.instance).toBe(b.ids.m2)
    expect(stationOf(r.doc, r.mountedOn)).toBe('站1')
  })

  it('沒有裝在底座上的零件：整組貼在旁邊', () => {
    const b = builder()
    b.add('v', 'DEMO-VALVE-52-01')
    b.add('f', 'DEMO-FITTING-R18-D6')
    b.mate('v', 'A', 'f', '1')
    const clip = copyUnit(b.doc, PRODUCTS, b.ids.v)!
    expect(clip.mount).toBeUndefined()
    const r = pasteUnit(b.doc, PRODUCTS, clip, { freePlacement: FREE })!
    expect(r.mountedOn).toBeUndefined()
    expect(r.doc.instances).toHaveLength(4)
    expect(r.doc.mates).toHaveLength(2)
  })
})
