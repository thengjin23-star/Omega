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
  { kind: 'manifold', stations: 3, thread: '1/8' },
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

  it('底板式閥與集裝座的安裝面名稱相同', async () => {
    const valve = buildGeneric({ kind: 'valve', fn: '52Single', thread: '1/8', mount: 'base' })
    const m = buildGeneric({ kind: 'manifold', stations: 2, thread: '1/8' })
    expect(valve.ports[0].spec).toBe(m.ports.find((p) => p.name === '站1')!.spec)
    expect(valve.ports[0].role).toBe('plug')
  })

  it('型號規則 → 通用零件', () => {
    const cases: [string, Partial<GenericSpec>][] = [
      ['PC6-01', { kind: 'fitting', form: 'straight', thread: '1/8', tube: 6 }],
      ['PL8-02', { kind: 'fitting', form: 'elbow', thread: '1/4', tube: 8 }],
      ['PE6', { kind: 'fitting', form: 'tee', tube: 6 }],
      ['BSL-01', { kind: 'silencer', thread: '1/8' }],
      ['JSC6-01', { kind: 'speedController', thread: '1/8', tube: 6 }],
      ['4V210-08', { kind: 'valve', fn: '52Single', thread: '1/4', exhaust: '1/8' }],
      ['4V230C-08', { kind: 'valve', fn: '53Closed', thread: '1/4' }],
      ['3V110-M5', { kind: 'valve', fn: '32NC', thread: 'M5' }],
      ['SC32X100', { kind: 'cylinder', bore: 32, stroke: 100 }],
      ['GFR200-08', { kind: 'frl', unit: 'filterRegulator', thread: '1/4' }],
      ['200M-4F', { kind: 'manifold', stations: 4 }],
    ]
    for (const [code, expected] of cases) expect(genericFromCode(decodeModelCode(code)!), code).toMatchObject(expected)
  })

  it('名稱與規格鍵', () => {
    expect(genericMeta({ kind: 'fitting', form: 'straight', thread: '1/8', tube: 6 })).toMatchObject({ modelCode: '通用 直通接頭 PT1/8-Ø6', category: 'fitting' })
    expect(genericMeta({ kind: 'cylinder', bore: 32, stroke: 100 }).pneumatic).toEqual({ type: 'cylinderDouble', params: { bore: 32, stroke: 100 } })
    expect(genericKey({ kind: 'silencer', thread: '1/8' })).toBe(genericKey({ thread: '1/8', kind: 'silencer' } as GenericSpec))
  })
})
