/// <reference types="node" />
import { Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { dot, distance, type Vec3 } from '../../geometry/vec3'
import { findAdapters, insertAdapter } from '../adapters'
import { bomToCsv, buildBom } from '../bom'
import { toMatrix, worldFrame } from '../frames'
import {
  addInstance,
  computeTransforms,
  connect,
  createModule,
  disconnect,
  getPort,
  mateChecks,
  mateRotation,
  removeInstance,
  setMateAngle,
} from '../moduleOps'
import type { ModuleDoc, PortRef } from '../types'
import { PRODUCTS } from './sampleModules'

/** 建立模組並加入零件，回傳 { doc, ids: { 別名: instanceId } } */
function build(parts: Record<string, string>) {
  let doc = createModule('測試')
  const ids: Record<string, string> = {}
  for (const [alias, model] of Object.entries(parts)) {
    const r = addInstance(doc, model)
    doc = r.doc
    ids[alias] = r.instanceId
  }
  return { doc, ids }
}

const ref = (doc: ModuleDoc, instance: string, portName: string): PortRef => {
  const inst = doc.instances.find((i) => i.id === instance)!
  const port = PRODUCTS[inst.productId].ports.find((p) => p.name === portName)
  if (!port) throw new Error(`${inst.productId} 沒有埠 ${portName}`)
  return { instance, port: port.id }
}

function mate(doc: ModuleDoc, parent: PortRef, child: PortRef, angle = 0) {
  const r = connect(doc, PRODUCTS, parent, child, angle)
  if ('error' in r) throw new Error(r.error)
  return r.doc
}

/** 埠的世界座標 */
function world(doc: ModuleDoc, r: PortRef) {
  const t = computeTransforms(doc, PRODUCTS).transforms[r.instance]
  return worldFrame(t, getPort(doc, PRODUCTS, r)!.frame)
}

/** 檢查鎖合的兩個埠：原點重合、軸線相反 */
function expectMated(doc: ModuleDoc, a: PortRef, b: PortRef) {
  const [wa, wb] = [world(doc, a), world(doc, b)]
  expect(distance(wa.origin, wb.origin)).toBeLessThan(1e-6)
  expect(dot(wa.axis, wb.axis)).toBeCloseTo(-1, 9)
}

const translationOf = (doc: ModuleDoc, instance: string): Vec3 =>
  new Vector3().setFromMatrixPosition(toMatrix(computeTransforms(doc, PRODUCTS).transforms[instance])).toArray()

/** 零件的世界矩陣把本地 X 軸轉到哪裡 */
const xAxisOf = (doc: ModuleDoc, instance: string): Vec3 =>
  new Vector3(1, 0, 0).transformDirection(toMatrix(computeTransforms(doc, PRODUCTS).transforms[instance])).toArray()

const close = (a: Vec3, b: Vec3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6))

describe('鎖合位置', () => {
  it('接頭鎖進閥的 A 口：螺紋朝下、肩面貼齊孔口（平移到 (-6.5, 0, 26)，不旋轉）', () => {
    let { doc, ids } = build({ valve: 'DEMO-VALVE-52-01', fitting: 'DEMO-FITTING-R18-D6' })
    doc = mate(doc, ref(doc, ids.valve, 'A'), ref(doc, ids.fitting, '1'))
    expectMated(doc, ref(doc, ids.valve, 'A'), ref(doc, ids.fitting, '1'))
    close(translationOf(doc, ids.fitting), [-6.5, 0, 26])
    close(xAxisOf(doc, ids.fitting), [1, 0, 0])
  })

  it('繞軸旋轉 90°：位置不變，方向轉 90°', () => {
    let { doc, ids } = build({ valve: 'DEMO-VALVE-52-01', fitting: 'DEMO-FITTING-R18-D6' })
    doc = mate(doc, ref(doc, ids.valve, 'A'), ref(doc, ids.fitting, '1'))
    doc = setMateAngle(doc, doc.mates[0].id, 90)
    expectMated(doc, ref(doc, ids.valve, 'A'), ref(doc, ids.fitting, '1'))
    close(xAxisOf(doc, ids.fitting), [0, 1, 0])
    expect(setMateAngle(doc, doc.mates[0].id, -90).mates[0].angle).toBe(270)
  })

  it('電磁閥以底面的安裝面裝到集裝座第 1 站：橫跨在站位上（閥的長邊沿集裝座的寬度）', () => {
    let { doc, ids } = build({ manifold: 'DEMO-MANIFOLD-4', valve: 'DEMO-VALVE-52-01' })
    doc = mate(doc, ref(doc, ids.manifold, '站1'), ref(doc, ids.valve, '安裝面'))
    // 站位在 x = 14 + 10（每站 20 mm），集裝座高 22；閥的 X（長邊）轉到集裝座的 Y
    close(translationOf(doc, ids.valve), [24, 0, 22])
    close(xAxisOf(doc, ids.valve), [0, 1, 0])
    // 閥底面的 P 正好對準集裝座的供氣通道（y = 0），EA／EB 對準兩條排氣通道
    close(world(doc, ref(doc, ids.valve, 'P')).origin, [24, 0, 22])
    close(world(doc, ref(doc, ids.valve, 'EA')).origin, [24, -13, 22])
  })

  it('底板式電磁閥以安裝面裝到底板式集裝座第 1 站：正好坐在站位上', () => {
    let { doc, ids } = build({ manifold: 'SUBBASE-MANIFOLD-4', valve: 'SUBBASE-VALVE-VB' })
    doc = mate(doc, ref(doc, ids.manifold, '站1'), ref(doc, ids.valve, '安裝面'))
    close(translationOf(doc, ids.valve), [10, 0, 20])
    close(xAxisOf(doc, ids.valve), [1, 0, 0])
  })

  it('三點組合：調壓閥接在過濾器右側且保持直立；接管座接在右端時自動轉 180°', () => {
    let { doc, ids } = build({ filter: 'DEMO-FRL-F40', regulator: 'DEMO-FRL-R40', inlet: 'DEMO-FRL-PB40', outlet: 'DEMO-FRL-PB40' })
    doc = mate(doc, ref(doc, ids.filter, 'OUT'), ref(doc, ids.regulator, 'IN'))
    close(translationOf(doc, ids.regulator), [40, 0, 0])
    close(xAxisOf(doc, ids.regulator), [1, 0, 0])

    doc = mate(doc, ref(doc, ids.filter, 'IN'), ref(doc, ids.inlet, '模組面'))
    close(world(doc, ref(doc, ids.inlet, '管口')).axis, [-1, 0, 0])
    doc = mate(doc, ref(doc, ids.regulator, 'OUT'), ref(doc, ids.outlet, '模組面'))
    close(world(doc, ref(doc, ids.outlet, '管口')).axis, [1, 0, 0])
    // 調壓閥 OUT 面在 x = 60；接管座厚 12 mm，轉 180° 後管口在 x = 72
    close(world(doc, ref(doc, ids.outlet, '管口')).origin, [72, 0, 20])
  })

  it('三層串接：集裝座 P ← 轉接頭 ← 接頭', () => {
    let { doc, ids } = build({ manifold: 'SUBBASE-MANIFOLD-4', bush: 'DEMO-BUSH-R14-RC18', fitting: 'DEMO-FITTING-R18-D6' })
    doc = mate(doc, ref(doc, ids.manifold, 'P'), ref(doc, ids.bush, '1'))
    doc = mate(doc, ref(doc, ids.bush, '2'), ref(doc, ids.fitting, '1'))
    expectMated(doc, ref(doc, ids.manifold, 'P'), ref(doc, ids.bush, '1'))
    expectMated(doc, ref(doc, ids.bush, '2'), ref(doc, ids.fitting, '1'))
    close(world(doc, ref(doc, ids.fitting, '2')).axis, [-1, 0, 0])
  })
})

describe('群組移動（re-root）與限制', () => {
  it('後點的零件若已在另一個群組中，整個群組一起移過來，彼此相對位置不變', () => {
    let { doc, ids } = build({ valve: 'DEMO-VALVE-52-01', fitting: 'DEMO-FITTING-R18-D6', cyl: 'DEMO-CYL-16-50' })
    doc = mate(doc, ref(doc, ids.valve, 'A'), ref(doc, ids.fitting, '1'))
    const t0 = computeTransforms(doc, PRODUCTS).transforms
    const relative = toMatrix(t0[ids.fitting]).invert().multiply(toMatrix(t0[ids.valve]))

    // 接頭（群組中的子零件）接到氣缸 A 口：閥＋接頭一起移動
    doc = mate(doc, ref(doc, ids.cyl, 'A'), ref(doc, ids.fitting, '2'))
    expectMated(doc, ref(doc, ids.cyl, 'A'), ref(doc, ids.fitting, '2'))
    expectMated(doc, ref(doc, ids.valve, 'A'), ref(doc, ids.fitting, '1'))
    const t1 = computeTransforms(doc, PRODUCTS).transforms
    const after = toMatrix(t1[ids.fitting]).invert().multiply(toMatrix(t1[ids.valve]))
    after.elements.forEach((v, i) => expect(v).toBeCloseTo(relative.elements[i], 6))
    close(translationOf(doc, ids.cyl), [0, 0, 0])
  })

  it('同一群組內再連接（形成迴圈）、自己接自己、埠已被使用 → 拒絕', () => {
    let { doc, ids } = build({ valve: 'DEMO-VALVE-52-01', f1: 'DEMO-FITTING-R18-D6', silencer: 'DEMO-SILENCER-R18' })
    doc = mate(doc, ref(doc, ids.valve, 'A'), ref(doc, ids.f1, '1'))
    expect(connect(doc, PRODUCTS, ref(doc, ids.valve, 'B'), ref(doc, ids.f1, '2'))).toEqual({ error: 'already-connected' })
    expect(connect(doc, PRODUCTS, ref(doc, ids.valve, 'B'), ref(doc, ids.valve, 'P'))).toEqual({ error: 'same-part' })
    expect(connect(doc, PRODUCTS, ref(doc, ids.valve, 'A'), ref(doc, ids.silencer, '1'))).toEqual({ error: 'port-in-use' })
  })

  it('拆開後所有零件保持原位', () => {
    let { doc, ids } = build({ valve: 'DEMO-VALVE-52-01', fitting: 'DEMO-FITTING-R18-D6' })
    doc = mate(doc, ref(doc, ids.valve, 'A'), ref(doc, ids.fitting, '1'), 45)
    const before = computeTransforms(doc, PRODUCTS).transforms
    doc = disconnect(doc, PRODUCTS, doc.mates[0].id)
    expect(doc.mates).toHaveLength(0)
    expect(computeTransforms(doc, PRODUCTS).transforms).toEqual(before)
  })

  it('移除中間的零件：子零件保持原位，成為獨立群組', () => {
    let { doc, ids } = build({ manifold: 'SUBBASE-MANIFOLD-4', bush: 'DEMO-BUSH-R14-RC18', fitting: 'DEMO-FITTING-R18-D6' })
    doc = mate(doc, ref(doc, ids.manifold, 'P'), ref(doc, ids.bush, '1'))
    doc = mate(doc, ref(doc, ids.bush, '2'), ref(doc, ids.fitting, '1'))
    const before = computeTransforms(doc, PRODUCTS).transforms[ids.fitting]
    doc = removeInstance(doc, PRODUCTS, ids.bush)
    expect(doc.instances).toHaveLength(2)
    expect(doc.mates).toHaveLength(0)
    expect(computeTransforms(doc, PRODUCTS).transforms[ids.fitting]).toEqual(before)
  })
})

describe('搭配檢查、轉接頭、BOM', () => {
  it('每個鎖合都會檢查螺紋；接錯的顯示錯誤', () => {
    let { doc, ids } = build({ valve: 'DEMO-VALVE-52-01', ok: 'DEMO-FITTING-R18-D6', bad: 'DEMO-FITTING-NPT18-D6' })
    doc = mate(doc, ref(doc, ids.valve, 'A'), ref(doc, ids.ok, '1'))
    doc = mate(doc, ref(doc, ids.valve, 'B'), ref(doc, ids.bad, '1'))
    expect(mateChecks(doc, PRODUCTS).map((c) => c.result.level)).toEqual(['ok', 'error'])
  })

  it('找出並插入轉接頭：集裝座 P（Rc1/4 母）接 R1/8 接頭', () => {
    let { doc, ids } = build({ manifold: 'SUBBASE-MANIFOLD-4', fitting: 'DEMO-FITTING-R18-D6' })
    const a = ref(doc, ids.manifold, 'P')
    const b = ref(doc, ids.fitting, '1')
    const options = findAdapters(Object.values(PRODUCTS), getPort(doc, PRODUCTS, a)!.spec!, getPort(doc, PRODUCTS, b)!.spec!)
    expect(options.map((o) => o.product.modelCode)).toEqual(['DEMO-BUSH-R14-RC18'])
    expect(options[0].levels).toEqual(['ok', 'ok'])

    const r = insertAdapter(doc, PRODUCTS, a, b, options[0])
    if ('error' in r) throw new Error(r.error)
    doc = r.doc
    expect(mateChecks(doc, PRODUCTS).every((c) => c.result.level === 'ok')).toBe(true)
    expectMated(doc, a, { instance: r.instanceId, port: options[0].portForA.id })
    expectMated(doc, { instance: r.instanceId, port: options[0].portForB.id }, b)
  })

  it('安裝面固定、螺紋可旋轉', () => {
    const manifold = PRODUCTS['DEMO-MANIFOLD-4']
    const valve = PRODUCTS['DEMO-VALVE-52-01']
    expect(mateRotation(manifold.ports.find((p) => p.name === '站1'), valve.ports[0])).toBe('fixed')
    expect(mateRotation(valve.ports[0], valve.ports[1])).toBe('free')
  })

  it('BOM 依產品彙總數量；CSV 有 UTF-8 BOM 且正確跳脫', () => {
    let { doc } = build({ valve: 'DEMO-VALVE-52-01', s1: 'DEMO-SILENCER-R18', s2: 'DEMO-SILENCER-R18', f: 'DEMO-FITTING-R18-D6' })
    doc = { ...doc, name: '客戶 A, 閥組', customer: '大"同"公司' }
    const rows = buildBom(doc, PRODUCTS)
    expect(rows.map((r) => [r.index, r.product.modelCode, r.quantity])).toEqual([
      [1, 'DEMO-VALVE-52-01', 1],
      [2, 'DEMO-SILENCER-R18', 2],
      [3, 'DEMO-FITTING-R18-D6', 1],
    ])
    const csv = bomToCsv(doc, rows)
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain('"模組：客戶 A, 閥組"')
    expect(csv).toContain('"客戶：大""同""公司"')
    expect(csv).toContain('項次,型號,名稱,類別,數量')
    expect(csv).toContain('2,DEMO-SILENCER-R18,範例消音器 R1/8,消音器,2')
  })

  it('埠被刪除時鎖合標示為損壞，子零件放在父零件位置', () => {
    let { doc, ids } = build({ valve: 'DEMO-VALVE-52-01', fitting: 'DEMO-FITTING-R18-D6' })
    doc = mate(doc, ref(doc, ids.valve, 'A'), ref(doc, ids.fitting, '1'))
    const valve = PRODUCTS['DEMO-VALVE-52-01']
    const without = { ...PRODUCTS, [valve.id]: { ...valve, ports: valve.ports.filter((p) => p.name !== 'A') } }
    const { transforms, broken } = computeTransforms(doc, without)
    expect(broken).toEqual([doc.mates[0].id])
    expect(transforms[ids.fitting]).toEqual(new Matrix4().toArray())
  })
})
