/// <reference types="node" />
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { distance, dot } from '../../geometry/vec3'
import { parseSpec, specKey } from '../../threads'
import { autoPorts } from '../autoPorts'
import { buildGeneric } from '../generic/buildGeneric'
import { genericFromCode, genericKey, genericMeta, type GenericSpec } from '../generic/genericParts'
import { decodeModelCode } from '../makerCodes'
import { createRaycaster } from '../openTester'
import { nodeParser } from './nodeHelpers'
import { Matrix4, Vector3 } from 'three'
import { autoAssemble } from '../../assembly/autoAssemble'
import { deriveModuleCircuit, SUPPLY_NODE } from '../../assembly/moduleCircuit'
import { computeTransforms } from '../../assembly/moduleOps'
import { moduleReport } from '../../assembly/moduleReport'
import { pneumaticFromDef, portsFromDefs } from '../samples'
import type { Product } from '../types'

const require = createRequire(import.meta.url)
let exportSTEP: typeof import('replicad').exportSTEP

beforeAll(async () => {
  const wasm = require.resolve('replicad-opencascadejs/wasm')
  const factory = require('replicad-opencascadejs') as (o: object) => Promise<unknown>
  const oc = await ((factory as unknown as { default?: typeof factory }).default ?? factory)({ locateFile: () => wasm, print: () => undefined, printErr: () => undefined })
  const replicad = await import('replicad')
  replicad.setOC(oc as Parameters<typeof replicad.setOC>[0])
  exportSTEP = replicad.exportSTEP
}, 120_000)

const SPECS: GenericSpec[] = [
  { kind: 'fitting', form: 'straight', thread: '1/8', tube: 6 },
  { kind: 'fitting', form: 'elbow', thread: '1/4', tube: 8 },
  { kind: 'fitting', form: 'tee', thread: 'M5', tube: 4 },
  { kind: 'fitting', form: 'straight', tube: 6 },
  { kind: 'fitting', form: 'tee', tube: 8 },
  { kind: 'silencer', thread: '1/4' },
  { kind: 'plug', thread: '1/8' },
  { kind: 'bushing', thread: '1/4', inner: '1/8' },
  { kind: 'speedController', thread: '1/8', tube: 6 },
  { kind: 'valve', fn: '52Single', thread: '1/4', exhaust: '1/8' },
  { kind: 'valve', fn: '52Double', thread: '1/8' },
  { kind: 'valve', fn: '32NC', thread: 'M5' },
  { kind: 'valve', fn: '53Closed', thread: '3/8', exhaust: '1/4' },
  { kind: 'manifold', stations: 3, series: 200 },
  { kind: 'manifold', stations: 2, series: 100 },
  { kind: 'cylinder', bore: 32, stroke: 100 },
  { kind: 'frl', unit: 'filterRegulator', thread: '1/4' },
  { kind: 'frl', unit: 'combo', thread: '3/8' },
]

async function roundTrip(spec: GenericSpec) {
  const built = buildGeneric(spec)
  const blob = exportSTEP(built.shapes.map(({ shape, name, color }) => ({ shape, name, color })))
  const tess = await nodeParser(new Uint8Array(await blob.arrayBuffer()), 'step')
  return { built, tess }
}

const keyOf = (text: string, shape: 'hole' | 'boss') => {
  const r = parseSpec(text, { gender: shape === 'hole' ? 'female' : 'male' })
  if (!r.ok) throw new Error(text)
  return specKey(r.spec)
}

describe('通用 3D 零件', () => {
  for (const spec of SPECS) {
    it(`${genericMeta(spec).name}：模型的孔與定義的埠一致（自動找埠核對）`, async () => {
      const { built, tess } = await roundTrip(spec)
      const meta = genericMeta(spec)
      const found = autoPorts(tess, createRaycaster(tess), { category: meta.category })
      const declared = built.ports.filter((p) => !/安裝面/.test(p.spec))
      for (const p of declared) {
        const hit = found.ports.find((f) => distance(f.frame.origin, p.origin) < 0.3 && dot(f.frame.axis, p.axis) > 0.99)
        expect(hit, `${meta.name} ${p.name} ${p.spec}`).toBeDefined()
        // 公母與尺寸一樣（PT 的 R／Rc；管徑）
        expect(specKey(hit!.spec!), `${meta.name} ${p.name}`).toBe(keyOf(p.spec, p.shape))
      }
      expect(found.ports.length, `${meta.name} 多找到的埠：${found.ports.map((f) => f.name).join()}`).toBe(declared.length)
      // 包圍盒合理（不是空的）
      expect(tess.triangleCount).toBeGreaterThan(20)
    }, 60_000)
  }

  it('電磁閥：A／B 在上面、P 與排氣口在底面；底面是裝集裝座的安裝面', () => {
    const v = buildGeneric({ kind: 'valve', fn: '52Single', thread: '1/4', exhaust: '1/8' })
    const at = (name: string) => v.ports.find((p) => p.name === name)!
    expect(at('A').axis).toEqual([0, 0, 1])
    expect(at('B').axis).toEqual([0, 0, 1])
    for (const n of ['P', 'EA', 'EB']) {
      expect(at(n).axis, n).toEqual([0, 0, -1])
      expect(at(n).sealedBy, n).toBe('安裝面')
    }
    expect(at('EA').origin[0]).toBeLessThan(at('A').origin[0])
    expect(at('安裝面')).toMatchObject({ spec: '安裝面：200 系列閥座', role: 'plug', axis: [0, 0, -1] })
    const m = buildGeneric({ kind: 'manifold', stations: 2, series: 200 })
    expect(m.ports.map((p) => p.name)).toEqual(['EA', 'P', 'EB', '站1', '站2'])
    expect(m.ports.find((p) => p.name === '站1')!.spec).toBe(at('安裝面').spec)
    // 集裝座的 P 與排氣口都在同一個端面，兩側沒有出氣口
    expect(new Set(m.ports.filter((p) => !p.name.startsWith('站')).map((p) => p.axis.join()))).toEqual(new Set(['-1,0,0']))
  })

  it('閥島：閥橫跨在集裝座上、底面的埠對準站位開口；接頭接在閥上、P 與消音器在集裝座端面；氣路經集裝座', () => {
    const make = (spec: GenericSpec, id: string): Product => {
      const built = buildGeneric(spec)
      const meta = genericMeta(spec)
      const ports = portsFromDefs(built.ports)
      return {
        id,
        modelCode: id,
        name: meta.name,
        category: meta.category,
        source: { fileName: '', sha256: id, format: 'step', bytes: 1 },
        ports,
        pneumatic: pneumaticFromDef(meta.pneumatic, ports),
        generic: spec,
        createdAt: 0,
        updatedAt: 0,
      }
    }
    const products = {
      M: make({ kind: 'manifold', stations: 3, series: 200 }, 'M'),
      V: make({ kind: 'valve', fn: '52Single', thread: '1/4', exhaust: '1/8' }, 'V'),
      F8: make({ kind: 'fitting', form: 'straight', thread: '1/4', tube: 8 }, 'F8'),
      F6: make({ kind: 'fitting', form: 'straight', thread: '1/4', tube: 6 }, 'F6'),
      S: make({ kind: 'silencer', thread: '1/4' }, 'S'),
    }
    const r = autoAssemble(
      [
        { product: products.M, qty: 1 },
        { product: products.V, qty: 3, hint: { target: products.M, ports: [] } },
        { product: products.F6, qty: 6, hint: { target: products.V, ports: ['A', 'B'] } },
        { product: products.F8, qty: 1, hint: { target: products.M, ports: ['P'] } },
        { product: products.S, qty: 2, hint: { target: products.M, ports: ['EA', 'EB'] } },
      ],
      products,
    )
    expect(r.leftovers).toEqual([])
    expect(r.doc.instances).toHaveLength(13)
    const code = (id: string) => r.doc.instances.find((i) => i.id === id)!.productId
    const name = (ref: { instance: string; port: string }) => products[code(ref.instance) as keyof typeof products].ports.find((p) => p.id === ref.port)!.name
    const mates = r.doc.mates.map((m) => `${code(m.parent.instance)}.${name(m.parent)}←${code(m.child.instance)}`).sort()
    expect(mates.filter((m) => m.startsWith('M.站'))).toHaveLength(3)
    expect(mates.filter((m) => /^V\.[AB]←F6$/.test(m))).toHaveLength(6)
    expect(mates).toEqual(expect.arrayContaining(['M.P←F8', 'M.EA←S', 'M.EB←S']))
    // 沒有搭配問題：閥底面的 P／排氣口由集裝座封住，不算沒接
    expect(moduleReport(r.doc, products).filter((x) => x.level !== 'info')).toEqual([])

    // 位置：閥的長邊與集裝座垂直；閥底面的 P 口在站位開口的正上方（集裝座頂面）
    const { transforms } = computeTransforms(r.doc, products)
    const mId = r.doc.instances.find((i) => i.productId === 'M')!.id
    const mWorld = new Matrix4().fromArray(transforms[mId])
    const mInv = mWorld.clone().invert()
    const manifoldSpec = buildGeneric({ kind: 'manifold', stations: 3, series: 200 })
    const H = manifoldSpec.ports.find((p) => p.name === 'P')!.origin[2] * 2
    const stationX = manifoldSpec.ports.filter((p) => p.name.startsWith('站')).map((p) => p.origin[0] - 8)
    for (const v of r.doc.instances.filter((i) => i.productId === 'V')) {
      const world = new Matrix4().fromArray(transforms[v.id])
      const local = (pt: number[]) => new Vector3(...pt).applyMatrix4(world).applyMatrix4(mInv)
      const longAxis = new Vector3(1, 0, 0).transformDirection(world).transformDirection(mInv)
      expect(Math.abs(longAxis.x)).toBeLessThan(1e-6)
      const pPort = products.V.ports.find((p) => p.name === 'P')!
      const p = local(pPort.frame.origin)
      expect(p.z).toBeCloseTo(H, 3)
      expect(Math.abs(p.y)).toBeLessThan(1e-6)
      expect(stationX.some((x) => Math.abs(x - p.x) < 1e-6)).toBe(true)
    }

    // 氣路：集裝座 P 供氣 → 每顆閥的 P；閥的 EA 接到集裝座的 EA（接消音器）
    const supply = { instance: mId, port: products.M.ports.find((p) => p.name === 'P')!.id }
    const mc = deriveModuleCircuit({ ...r.doc, supply }, products)
    const net = (inst: string, portName: string, product: Product) => mc.netOfPort[`${inst}:${product.ports.find((p) => p.name === portName)!.id}`]
    const supplyNet = mc.nets.findIndex((n) => n.some((e) => e.node === SUPPLY_NODE))
    for (const v of r.doc.instances.filter((i) => i.productId === 'V')) {
      expect(mc.nets[supplyNet].some((e) => e.node === v.id && e.port === 'P')).toBe(true)
      expect(net(v.id, 'EA', products.V)).toBe(net(mId, 'EA', products.M))
      expect(net(v.id, 'A', products.V)).not.toBe(net(v.id, 'P', products.V))
    }
    // 閥底面的埠不會被當成沒接
    const valves = new Set(r.doc.instances.filter((i) => i.productId === 'V').map((i) => i.id))
    expect(mc.warnings.filter((w) => w.instance && valves.has(w.instance))).toEqual([])
  })

  it('匯入亞德客 4V 閥（自動找埠）：底面加上安裝面，可以直接裝到通用集裝座上', async () => {
    const generic = buildGeneric({ kind: 'valve', fn: '52Single', thread: '1/4', exhaust: '1/8' })
    // 拿掉通用閥自己定義的埠，只用幾何：模擬匯入原廠 3D 檔
    const { tess } = await roundTrip({ kind: 'valve', fn: '52Single', thread: '1/4', exhaust: '1/8' })
    const r = autoPorts(tess, createRaycaster(tess), { code: decodeModelCode('4V210-08')! })
    const mount = r.ports.find((p) => p.spec?.kind === 'interface')!
    expect(mount.spec).toEqual({ kind: 'interface', key: '200 系列閥座', role: 'plug' })
    const expected = generic.ports.find((p) => p.name === '安裝面')!
    expect(distance(mount.frame.origin, expected.origin)).toBeLessThan(0.05)
    expect(dot(mount.frame.ref, [1, 0, 0])).toBeGreaterThan(0.999)
    expect(r.ports.filter((p) => p.sealedBy === mount.id).map((p) => p.name).sort()).toEqual(['EA', 'EB', 'P'])
  }, 60_000)

  it('型號規則 → 通用零件', () => {
    const cases: [string, Partial<GenericSpec>][] = [
      ['PC6-01', { kind: 'fitting', form: 'straight', thread: '1/8', tube: 6 }],
      ['PL8-02', { kind: 'fitting', form: 'elbow', thread: '1/4', tube: 8 }],
      ['PE6', { kind: 'fitting', form: 'tee', tube: 6 }],
      ['BSL-01', { kind: 'silencer', thread: '1/8' }],
      ['JSC6-01', { kind: 'speedController', thread: '1/8', tube: 6 }],
      ['4V210-08', { kind: 'valve', fn: '52Single', thread: '1/4', exhaust: '1/8', series: 200 }],
      ['4V110-06', { kind: 'valve', fn: '52Single', thread: '1/8', series: 100 }],
      ['4V230C-08', { kind: 'valve', fn: '53Closed', thread: '1/4' }],
      ['3V110-M5', { kind: 'valve', fn: '32NC', thread: 'M5' }],
      ['SC32X100', { kind: 'cylinder', bore: 32, stroke: 100 }],
      ['GFR200-08', { kind: 'frl', unit: 'filterRegulator', thread: '1/4' }],
      ['200M-4F', { kind: 'manifold', stations: 4, series: 200 }],
    ]
    for (const [code, expected] of cases) expect(genericFromCode(decodeModelCode(code)!), code).toMatchObject(expected)
  })

  it('名稱與規格鍵', () => {
    expect(genericMeta({ kind: 'fitting', form: 'straight', thread: '1/8', tube: 6 })).toMatchObject({ modelCode: '通用 直通接頭 PT1/8-Ø6', category: 'fitting' })
    expect(genericMeta({ kind: 'cylinder', bore: 32, stroke: 100 }).pneumatic).toEqual({ type: 'cylinderDouble', params: { bore: 32, stroke: 100 } })
    expect(genericKey({ kind: 'silencer', thread: '1/8' })).toBe(genericKey({ thread: '1/8', kind: 'silencer' } as GenericSpec))
  })
})
