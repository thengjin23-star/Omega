import { Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import type { Product } from '../../catalog/types'
import { buildStepMeta } from '../../drawing/stepMeta'
import { toMatrix } from '../frames'
import { computeTransforms, setPlacement } from '../moduleOps'
import { mapPorts, planRestore, restoreModule } from '../stepRestore'
import { PRODUCTS, valveCylinder, valveIsland } from './sampleModules'

/** 匯出：每個零件依序一個頂層零件 */
function exported(doc = valveIsland().doc) {
  const roots = Object.fromEntries(doc.instances.map((i, k) => [i.id, k]))
  return buildStepMeta(doc, PRODUCTS, roots)
}

/** 換一台電腦：同樣的原始檔，但產品 id 與埠 id 都不同 */
function reimported(p: Product): Product {
  return { ...p, id: `local-${p.id}`, ports: p.ports.map((q) => ({ ...q, id: `local-${q.id}` })) }
}

const expectSamePoses = (a: Record<string, number[]>, b: Record<string, number[]>) => {
  expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort())
  for (const id of Object.keys(a)) a[id].forEach((v, i) => expect(v).toBeCloseTo(b[id][i], 6))
}

describe('從 STEP 還原模組', () => {
  it('產品庫已有的產品直接沿用；位置、鎖合、PU 管、供氣口都與匯出前相同', () => {
    const b = valveCylinder()
    // 把根零件轉個方向再匯出
    const doc = setPlacement(b.doc, b.ids.v, new Matrix4().makeRotationY(Math.PI / 2).setPosition(10, 20, 30).toArray())
    const meta = exported(doc)
    const plan = planRestore(meta, { bySha: (sha) => Object.values(PRODUCTS).find((p) => p.source.sha256 === sha), modelOnly: () => undefined })
    expect(plan.extract).toEqual([])
    expect(Object.keys(plan.reuse).length).toBe(Object.keys(meta.products).length)
    const r = restoreModule(meta, plan.reuse)
    expect(r.doc.id).not.toBe(doc.id)
    expect(r.pinned).toBe(0)
    expect(r.doc.mates).toEqual(doc.mates)
    expect(r.doc.tubes).toEqual(doc.tubes)
    expect(r.doc.supply).toEqual(doc.supply)
    expectSamePoses(computeTransforms(r.doc, PRODUCTS).transforms, computeTransforms(doc, PRODUCTS).transforms)
  })

  it('另一台電腦（產品與埠的 id 不同）：依埠名稱對回，位置不變', () => {
    const meta = exported()
    const local = Object.fromEntries(Object.values(meta.products).map((p) => [p.id, reimported(p)]))
    const r = restoreModule(meta, local)
    expect(r.pinned).toBe(0)
    expect(r.doc.mates.length).toBe(meta.module.mates.length)
    expect(r.doc.mates.every((m) => m.parent.port.startsWith('local-') && m.child.port.startsWith('local-'))).toBe(true)
    const localMap = Object.fromEntries(Object.values(local).map((p) => [p.id, p]))
    expectSamePoses(computeTransforms(r.doc, localMap).transforms, computeTransforms(meta.module, meta.products).transforms)
  })

  it('本機產品的埠改過位置：該零件改成固定在匯出時的位置，不會跑掉', () => {
    const meta = exported()
    const fitting = Object.values(meta.products).find((p) => p.modelCode === 'DEMO-FITTING-R18-D6')!
    const moved: Product = { ...fitting, ports: fitting.ports.map((q) => (q.name === '1' ? { ...q, frame: { ...q.frame, origin: [0, 0, 5] } } : q)) }
    const local = { ...Object.fromEntries(Object.values(meta.products).map((p) => [p.id, p])), [fitting.id]: moved }
    const r = restoreModule(meta, local)
    expect(r.pinned).toBe(2) // 兩個 Ø6 接頭
    const localMap = Object.fromEntries(Object.values(local).map((p) => [p.id, p]))
    expectSamePoses(computeTransforms(r.doc, localMap).transforms, computeTransforms(meta.module, meta.products).transforms)
  })

  it('產品庫沒有的產品：從 STEP 取出第一個用到它的零件，套用反向矩陣換回零件座標', () => {
    const b = valveIsland()
    const meta = exported(b.doc)
    const plan = planRestore(meta, {
      bySha: (sha) => (sha === PRODUCTS['SUBBASE-MANIFOLD-4'].source.sha256 ? undefined : Object.values(PRODUCTS).find((p) => p.source.sha256 === sha)),
      modelOnly: () => undefined,
    })
    expect(plan.extract.map((e) => e.productId)).toEqual(['SUBBASE-MANIFOLD-4'])
    const [e] = plan.extract
    expect(e.root).toBe(b.doc.instances.findIndex((i) => i.id === b.ids.m))
    const world = toMatrix(computeTransforms(b.doc, PRODUCTS).transforms[b.ids.m])
    const identity = world.multiply(new Matrix4().fromArray(e.matrix)).toArray()
    new Matrix4().toArray().forEach((v, i) => expect(identity[i]).toBeCloseTo(v, 9))
  })

  it('缺少產品的零件略過，接在它上面的零件固定在原位', () => {
    const b = valveIsland()
    const meta = exported(b.doc)
    const local = Object.fromEntries(Object.values(meta.products).filter((p) => p.modelCode !== 'SUBBASE-MANIFOLD-4').map((p) => [p.id, p]))
    const r = restoreModule(meta, local)
    expect(r.skipped).toBe(1)
    // 集裝座上的 2 顆閥、2 個接頭、2 個消音器 → 改成固定位置
    expect(r.pinned).toBe(6)
    expect(r.doc.supply).toBeUndefined()
    const poses = computeTransforms(r.doc, PRODUCTS).transforms
    const before = computeTransforms(b.doc, PRODUCTS).transforms
    for (const id of Object.keys(poses)) poses[id].forEach((v, i) => expect(v).toBeCloseTo(before[id][i], 6))
  })

  it('埠對應：同 id → 同名 → 同位置', () => {
    const valve = PRODUCTS['DEMO-VALVE-52-01']
    const renamed: Product = { ...valve, ports: valve.ports.map((q) => ({ ...q, id: `x-${q.id}`, name: q.name === 'P' ? '1' : q.name })) }
    const map = mapPorts(valve, renamed)
    expect(Object.keys(map).length).toBe(valve.ports.length)
    const p = valve.ports.find((q) => q.name === 'P')!
    expect(renamed.ports.find((q) => q.id === map[p.id])?.name).toBe('1')
  })
})
