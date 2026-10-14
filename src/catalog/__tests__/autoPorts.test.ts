import { describe, expect, it } from 'vitest'
import { dot, distance } from '../../geometry/vec3'
import { formatSpecShort, parseSpec, specKey } from '../../threads'
import { autoPorts } from '../autoPorts'
import { decodeModelCode } from '../makerCodes'
import { createRaycaster } from '../openTester'
import type { ProductPort } from '../types'
import { SUBBASE } from '../../assembly/__tests__/sampleModules'
import { nodeParser, readFixture, readSample, sampleManifest } from './nodeHelpers'

const manifest = sampleManifest()

async function detect(file: string, text = file, read = readSample) {
  const tess = await nodeParser(await read(file), 'step')
  return autoPorts(tess, createRaycaster(tess), { text })
}

/** 範例檔裡螺紋與快插的埠（安裝面靠孔位找不到，不比） */
const pipingPorts = (file: string) => {
  const def = [...manifest.parts, ...SUBBASE].find((p) => p.file === file)!
  return def.ports.flatMap((p) => {
    if (/安裝面/.test(p.spec)) return []
    const r = parseSpec(p.spec, { gender: p.shape === 'hole' ? 'female' : 'male' })
    return r.ok ? [{ ...p, key: specKey(r.spec) }] : []
  })
}

const found = (ports: ProductPort[], expected: { origin: number[]; axis: number[]; key: string }) =>
  ports.find(
    (p) =>
      distance(p.frame.origin, expected.origin as [number, number, number]) < 0.15 &&
      dot(p.frame.axis, expected.axis as [number, number, number]) > 0.99 &&
      p.spec &&
      specKey(p.spec) === expected.key,
  )

describe('autoPorts：從 3D 模型自動找埠（範例零件）', () => {
  const cases: [string, string[]][] = [
    ['DEMO-VALVE-52-01.step', ['A', 'B', 'EA', 'P', 'EB']],
    ['DEMO-FITTING-R18-D6.step', ['1', '2']],
    ['DEMO-FITTING-R18-D4.step', ['1', '2']],
    ['DEMO-FITTING-NPT18-D6.step', ['1', '2']],
    ['DEMO-SILENCER-R18.step', ['1']],
    ['DEMO-CYL-16-50.step', ['A', 'B']],
    ['DEMO-SC-M5-D4.step', ['1', '2']],
    ['DEMO-BUSH-R14-RC18.step', ['1', '2']],
  ]
  for (const [file, names] of cases) {
    it(`${file}：位置、方向、規格與名稱`, async () => {
      const r = await detect(file)
      const expected = pipingPorts(file)
      expect(r.ports.map((p) => `${p.name}:${p.spec && formatSpecShort(p.spec)}`)).toHaveLength(expected.length)
      for (const e of expected) {
        const p = found(r.ports, e)
        expect(p, `${file} ${e.name} ${e.spec}`).toBeDefined()
        expect(p!.name).toBe(e.name)
        expect(p!.detected?.auto).toBe(true)
      }
      expect(r.ports.map((p) => p.name).sort()).toEqual([...names].sort())
    })
  }

  it('集裝座（亞德客式）：端面的 P、EA、EB；站位的長孔與螺絲孔不當成埠', async () => {
    const r = await detect('DEMO-MANIFOLD-4.step')
    expect(r.category).toBe('manifold')
    const expected = pipingPorts('DEMO-MANIFOLD-4.step')
    expect(r.ports).toHaveLength(expected.length)
    for (const e of expected) expect(found(r.ports, e)?.name, e.name).toBe(e.name)
  })

  it('底板式集裝座：A1～A4／B1～B4、P、EA／EB；站位的定位孔不當成埠', async () => {
    const r = await detect('SUBBASE-MANIFOLD-4.step', 'SUBBASE-MANIFOLD-4.step', readFixture)
    expect(r.category).toBe('manifold')
    const expected = pipingPorts('SUBBASE-MANIFOLD-4.step')
    expect(r.ports).toHaveLength(expected.length)
    for (const e of expected) expect(found(r.ports, e), e.name).toBeDefined()
    const names = r.ports.map((p) => p.name).sort()
    expect(names).toEqual(['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4', 'EA', 'EB', 'P'])
    // A 排與 B 排各在一側
    const side = (prefix: string) => new Set(r.ports.filter((p) => p.name.startsWith(prefix)).map((p) => p.frame.axis.map(Math.round).join()))
    expect(side('A').size).toBe(1)
    expect(side('B').size).toBe(1)
    // 站位中間的 Ø5 孔：列為「可能」，不自動加入
    expect(r.maybe.length).toBeGreaterThan(0)
  })

  it('調壓閥：IN／OUT 與壓力錶', async () => {
    const r = await detect('DEMO-FRL-R40.step')
    expect(r.category).toBe('frl')
    expect(r.ports.map((p) => `${p.name}:${formatSpecShort(p.spec!)}`).sort()).toEqual(['IN:Rc1/4', 'OUT:Rc1/4', '壓力錶:Rc1/8'])
  })

  it('沒有關鍵字也能依形狀判斷分類', async () => {
    expect((await detect('DEMO-CYL-16-50.step', 'part-001')).category).toBe('cylinder')
    expect((await detect('DEMO-FITTING-R18-D6.step', 'part-002')).category).toBe('fitting')
    expect((await detect('DEMO-BUSH-R14-RC18.step', 'part-003')).category).toBe('fitting')
  })

  it('型號規則：G 牙的型號把孔判成 G（孔徑與 PT 一樣）', async () => {
    const tess = await nodeParser(await readSample('DEMO-VALVE-52-01.step'), 'step')
    const code = decodeModelCode('4V110-06G')!
    const r = autoPorts(tess, createRaycaster(tess), { code })
    expect(r.category).toBe('valve')
    expect(r.name).toBe('5/2 單電控電磁閥 G1/8')
    expect(new Set(r.ports.filter((p) => p.spec?.kind === 'thread').map((p) => formatSpecShort(p.spec!)))).toEqual(new Set(['G1/8']))
    // 4V 系列：P 與排氣口所在的面加上裝集裝座的安裝面（100 系列），P／EA／EB 由它封住
    const mount = r.ports.find((p) => p.spec?.kind === 'interface')!
    expect(mount).toMatchObject({ name: '安裝面', spec: { kind: 'interface', key: '100 系列閥座', role: 'plug' } })
    expect(r.ports.filter((p) => p.sealedBy === mount.id).map((p) => p.name).sort()).toEqual(['EA', 'EB', 'P'])
  })

  it('已經有的埠不重複加入', async () => {
    const tess = await nodeParser(await readSample('DEMO-FITTING-R18-D6.step'), 'step')
    const first = autoPorts(tess, createRaycaster(tess), { text: 'fitting' })
    const again = autoPorts(tess, createRaycaster(tess), { text: 'fitting', existing: first.ports.slice(0, 1) })
    expect(again.ports).toHaveLength(1)
  })
})

describe('decodeModelCode：亞德客型號', () => {
  const cases: [string, Partial<NonNullable<ReturnType<typeof decodeModelCode>>>][] = [
    ['4V210-08', { category: 'valve', name: '5/2 單電控電磁閥 PT1/4' }],
    ['4V21008B', { category: 'valve', name: '5/2 單電控電磁閥 PT1/4' }],
    ['4V230C-08', { category: 'valve', name: '5/3 中位封閉電磁閥 PT1/4' }],
    ['3V110-M5', { category: 'valve', name: '3/2 單電控電磁閥（常閉） M5' }],
    ['4V110-06G', { category: 'valve', name: '5/2 單電控電磁閥 G1/8', thread: 'G' }],
    ['PC6-01', { category: 'fitting', name: '直通快插接頭 PT1/8 × Ø6' }],
    ['ＰＬ８－０２', { category: 'fitting', name: '彎頭快插接頭 PT1/4 × Ø8' }],
    ['PC4-M5', { category: 'fitting', name: '直通快插接頭 M5 × Ø4' }],
    ['PU6', { category: 'fitting', name: '直通快插接頭（管對管） Ø6' }],
    ['PE8', { category: 'fitting', name: '三通快插接頭（管對管） Ø8' }],
    ['JSC6-01', { category: 'speedController', name: '速度控制接頭 PT1/8 × Ø6' }],
    ['BSL-01', { category: 'silencer', name: '消音器 PT1/8' }],
    ['BSLM5', { category: 'silencer', name: '消音器 M5' }],
    ['SC32X100', { category: 'cylinder', bore: 32, stroke: 100 }],
    ['MAL20×50', { category: 'cylinder', bore: 20, stroke: 50 }],
    ['GFR200-08', { category: 'frl', name: '過濾調壓閥 PT1/4' }],
    ['GC300-10', { category: 'frl' }],
    ['200M-4F', { category: 'manifold', stations: 4 }],
  ]
  for (const [code, expected] of cases) {
    it(code, () => expect(decodeModelCode(code)).toMatchObject(expected))
  }

  it('預期的埠', () => {
    expect(decodeModelCode('4V210-08')!.ports.map((p) => `${p.name}:${p.spec}`)).toEqual(['P:Rc1/4', 'A:Rc1/4', 'B:Rc1/4', 'EA:Rc1/8', 'EB:Rc1/8'])
    expect(decodeModelCode('PC6-01')!.ports.map((p) => `${p.name}:${p.spec}`)).toEqual(['1:R1/8', '2:Ø6 快插'])
    expect(decodeModelCode('PB6-01')!.ports).toHaveLength(3)
  })

  it('認不出來的型號', () => {
    for (const code of ['KQ2H06-01S', 'SY3120-5LZD-M5', 'DEMO-VALVE-52-01', 'PC5-01', 'PU6-01']) expect(decodeModelCode(code), code).toBeUndefined()
  })
})
