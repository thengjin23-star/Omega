/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { addInstance, addTube, computeTransforms, connect, createModule, type ProductMap } from '../../assembly/moduleOps'
import type { ModuleDoc } from '../../assembly/types'
import { portsFromDefs, type SampleManifest } from '../../catalog/samples'
import type { Tessellation } from '../../catalog/tessellation'
import type { Product } from '../../catalog/types'
import { layoutAssemblyDrawing } from '../assemblyLayout'
import { assemblyInput, collectModuleDrawing, drawingOptions } from '../moduleDrawing'
import { today } from '../../utils/date'
import { projectView, standardViews, type StandardView } from '../projection'
import { collectStepParts } from '../stepParts'
import { box } from './fixtures'

const manifest: SampleManifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../public/samples/manifest.json', import.meta.url)), 'utf8'))
const product = (code: string, patch: Partial<Product> = {}): Product => {
  const def = manifest.parts.find((p) => p.modelCode === code)!
  return {
    id: code,
    modelCode: code,
    name: def.name,
    category: def.category,
    source: { fileName: def.file, sha256: `sha-${code}`, format: 'step', bytes: 100 },
    ports: portsFromDefs(def.ports),
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}
const PRODUCTS: ProductMap = {
  'DEMO-VALVE-52-01': product('DEMO-VALVE-52-01', { maker: 'DEMO' }),
  'DEMO-FITTING-R18-D6': product('DEMO-FITTING-R18-D6'),
  'DEMO-SILENCER-R18': product('DEMO-SILENCER-R18', { source: { fileName: 's.igs', sha256: 'sha-s', format: 'iges', bytes: 10 } }),
  'DEMO-CYL-16-50': product('DEMO-CYL-16-50', { source: { fileName: '', sha256: 'none', format: 'step', bytes: 0 } }),
}
/** 每個產品用一個 20 mm 的方塊當網格 */
const cube = (): Tessellation => {
  const b = box(20, 20, 20)
  return {
    parts: [{ name: 'body', color: [1, 0, 0], positions: b.positions, normals: new Float32Array(b.positions.length), indices: b.indices, faceRanges: b.faceRanges }],
    bbox: { min: [-10, -10, -10], max: [10, 10, 10] },
    triangleCount: 12,
  }
}
const MESHES: Record<string, Tessellation> = { 'sha-DEMO-VALVE-52-01': cube(), 'sha-DEMO-FITTING-R18-D6': cube(), 'sha-s': cube() }

function moduleWithFittings(): ModuleDoc {
  let doc = createModule('測試模組')
  const v = addInstance(doc, 'DEMO-VALVE-52-01')
  doc = v.doc
  const port = (code: string, name: string) => PRODUCTS[code].ports.find((p) => p.name === name)!.id
  for (const name of ['A', 'B']) {
    const f = addInstance(doc, 'DEMO-FITTING-R18-D6')
    const r = connect(f.doc, PRODUCTS, { instance: v.instanceId, port: port('DEMO-VALVE-52-01', name) }, { instance: f.instanceId, port: port('DEMO-FITTING-R18-D6', '1') })
    if ('error' in r) throw new Error(r.error)
    doc = r.doc
  }
  const s = addInstance(doc, 'DEMO-SILENCER-R18')
  doc = s.doc
  doc = addInstance(doc, 'DEMO-CYL-16-50').doc
  return doc
}

describe('collectModuleDrawing', () => {
  it('零件表項次、網格、對外接口（沒有接上的埠，轉到世界座標）', () => {
    const doc = moduleWithFittings()
    const { transforms } = computeTransforms(doc, PRODUCTS)
    const src = collectModuleDrawing(doc, PRODUCTS, MESHES, transforms)
    expect(src.bom.map((r) => [r.item, r.modelCode, r.quantity])).toEqual([
      [1, 'DEMO-VALVE-52-01', 1],
      [2, 'DEMO-FITTING-R18-D6', 2],
      [3, 'DEMO-SILENCER-R18', 1],
      [4, 'DEMO-CYL-16-50', 1],
    ])
    expect(src.bom[0].maker).toBe('DEMO')
    // 閥、2 個接頭、消音器有網格；氣缸沒有 3D
    expect(src.instances.map((i) => i.item)).toEqual([1, 2, 2, 3])
    expect(src.withoutModel).toEqual(['DEMO-CYL-16-50'])
    expect(src.geometry(src.instances[0].key)?.positions.length).toBe(72)
    // 閥的 A、B 接了接頭 → 閥剩 EA、P、EB（沒裝集裝座的安裝面不列）；接頭剩快插端 2 個；消音器 1 個；氣缸 A、B
    const ports = src.ports.map((p) => `${p.item}:${p.port}`)
    expect(ports).toEqual(['1:EA', '1:P', '1:EB', '2:2', '2:2', '3:1', '4:A', '4:B'])
    // 接頭的快插端在閥 A 埠的上方，軸向朝外
    const fittingPort = src.ports[3]
    expect(fittingPort.spec).toContain('Ø6')
    expect(fittingPort.axis[2]).toBeCloseTo(1, 6)
    expect(fittingPort.origin[2]).toBeGreaterThan(26)
  })

  it('組成組立圖的輸入：側視圖依投影法、選項、標題欄', () => {
    const doc = { ...moduleWithFittings(), customer: '客戶甲' }
    const { transforms } = computeTransforms(doc, PRODUCTS)
    const src = collectModuleDrawing(doc, PRODUCTS, MESHES, transforms)
    const bases = standardViews()
    const meshes = src.instances.map((i) => ({ ...src.geometry(i.key)!, key: i.key, matrix: i.matrix, item: i.item }))
    const points = src.ports.map((p) => p.origin)
    const views = Object.fromEntries(
      (['front', 'top', 'right', 'left', 'iso'] as StandardView[]).map((n) => [n, projectView(meshes, bases[n], { points, hidden: n !== 'iso' })]),
    ) as Record<StandardView, ReturnType<typeof projectView>>
    const options = drawingOptions({ projection: 'first', hidden: false, number: 'D-1' }, { paper: 'A3', projection: 'third' })
    expect(options).toMatchObject({ front: '-y', paper: 'A3', projection: 'first', hidden: false, iso: true, number: 'D-1' })
    const input = assemblyInput(doc, src, views, options, { company: { name: '公司' }, drawer: '王' }, '2026-01-02')
    expect(input.views.side.bounds).toEqual(views.left.bounds)
    expect(input.views.front.hidden.length).toBe(0)
    expect(input.title).toMatchObject({ title: '測試模組', customer: '客戶甲', drawingNo: 'D-1', date: '2026-01-02', drawer: '王' })
    expect(input.ports).toHaveLength(8)
    // 接頭的快插端朝上：在俯視圖正對觀察者
    const p = input.ports[3]
    expect(p.views.top?.facing).toBeCloseTo(1, 6)
    const drawing = layoutAssemblyDrawing(input)
    expect(drawing.sheets.length).toBeGreaterThan(0)
    expect(drawing.warnings).toEqual([])
  })

  it('today：當地日期 YYYY-MM-DD', () => {
    expect(today(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('collectStepParts', () => {
  it('名稱為「項次_型號」、同產品加序號；沒有 3D 或 IGES 的略過', () => {
    const doc = moduleWithFittings()
    const { transforms } = computeTransforms(doc, PRODUCTS)
    const plan = collectStepParts(doc, PRODUCTS, MESHES, transforms)
    expect(plan.parts.map((p) => p.name)).toEqual(['1_DEMO-VALVE-52-01', '2_DEMO-FITTING-R18-D6_1', '2_DEMO-FITTING-R18-D6_2'])
    expect(plan.parts[0].color).toBe('#ff0000')
    expect(plan.sources).toEqual(['sha-DEMO-VALVE-52-01', 'sha-DEMO-FITTING-R18-D6'])
    expect(plan.skipped).toEqual([
      { name: 'DEMO-SILENCER-R18', reason: 'IGES 檔無法寫入 STEP 組立檔' },
      { name: 'DEMO-CYL-16-50', reason: '沒有 3D 檔' },
    ])
    expect(plan.tubes).toEqual([])
  })

  it('PU 管依零件表項次命名，沿兩端快插口的曲線掃出', () => {
    let doc = moduleWithFittings()
    const [f1, f2] = doc.instances.filter((i) => i.productId === 'DEMO-FITTING-R18-D6').map((i) => i.id)
    const socket = PRODUCTS['DEMO-FITTING-R18-D6'].ports.find((p) => p.name === '2')!.id
    const r = addTube(doc, PRODUCTS, { instance: f1, port: socket }, { instance: f2, port: socket })
    if ('error' in r) throw new Error(r.error)
    doc = r.doc
    const { transforms } = computeTransforms(doc, PRODUCTS)
    const plan = collectStepParts(doc, PRODUCTS, MESHES, transforms)
    expect(plan.tubes).toHaveLength(1)
    const [tube] = plan.tubes
    // 產品 4 列之後：第 5 項
    expect(tube).toMatchObject({ name: '5_PU 管 Ø6_1', od: 6, id: 4, color: '#38bdf8' })
    // 起點在接頭的快插口，第 2 個控制點沿埠的軸向（朝上）拉出
    expect(tube.points[0][2]).toBeGreaterThan(34)
    expect(tube.points[1][0]).toBeCloseTo(tube.points[0][0], 6)
    expect(tube.points[1][2]).toBeGreaterThan(tube.points[0][2])
    expect(tube.points[3][2]).toBeCloseTo(tube.points[0][2], 6)
  })
})
