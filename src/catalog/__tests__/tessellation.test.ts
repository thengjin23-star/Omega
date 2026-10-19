import { describe, expect, it } from 'vitest'
import { detectCadFormat, readCad } from '../cad'
import { deserializeTessellation, faceOfTriangle, serializeTessellation, topLevelGroups } from '../tessellation'
import { nodeOcct, readSample, sampleManifest } from './nodeHelpers'

const load = async (file: string) => readCad(await nodeOcct(), await readSample(file), 'step')

describe('讀取 STEP（occt-import-js）', () => {
  it('每個範例零件都能讀取，且 B-rep 面範圍完整涵蓋所有三角形', async () => {
    for (const part of sampleManifest().parts) {
      const t = await load(part.file)
      expect(t.parts.length, part.file).toBeGreaterThan(0)
      for (const p of t.parts) {
        const triangles = p.indices.length / 3
        expect(p.positions.length).toBe(p.normals.length)
        expect(p.faceRanges[0]).toBe(0)
        for (let k = 2; k < p.faceRanges.length; k += 2) expect(p.faceRanges[k]).toBe(p.faceRanges[k - 1] + 1)
        expect(p.faceRanges[p.faceRanges.length - 1]).toBe(triangles - 1)
      }
    }
  })

  it('保留零件名稱與顏色、單位為 mm（外形尺寸與建模參數一致）', async () => {
    const t = await load('DEMO-VALVE-52-01.step')
    expect(t.parts.map((p) => p.name)).toEqual(['BODY', 'SOLENOID', 'SOLENOID-CONNECTOR', 'MANUAL'])
    expect(t.parts[1].color).not.toBeNull()
    // 本體長 50（-25～25），-X 端的手動按鈕凸出 2，+X 端的線圈長 27.5
    expect(t.bbox.min[0]).toBeCloseTo(-27, 1)
    expect(t.bbox.max[0]).toBeCloseTo(52.5, 1)
    expect(t.bbox.min[2]).toBeCloseTo(0, 1)
    // 本體頂面 z = 26，線圈上的接線盒到 z = 26 × 1.47
    expect(t.bbox.max[2]).toBeCloseTo(38.22, 1)
  })

  it('記下 STEP 的頂層零件（名稱與網格）：單一零件也可能有好幾個實體', async () => {
    const t = await load('DEMO-VALVE-52-01.step')
    expect(t.groups).toEqual([
      { name: 'BODY', parts: [0] },
      { name: 'SOLENOID', parts: [1] },
      { name: 'SOLENOID-CONNECTOR', parts: [2] },
      { name: 'MANUAL', parts: [3] },
    ])
    expect(deserializeTessellation(serializeTessellation(t)).groups).toEqual(t.groups)
  })

  it('topLevelGroups：往下走過只有一個子節點的包裝層；子節點底下的網格都算進去', () => {
    const tree = { name: '', children: [{ name: 'ASM', children: [{ name: 'A', meshes: [0, 1] }, { name: 'B', children: [{ name: 'B1', meshes: [2] }] }] }] }
    expect(topLevelGroups(tree, 3)).toEqual([
      { name: 'A', parts: [0, 1] },
      { name: 'B', parts: [2] },
    ])
    expect(topLevelGroups(undefined, 2)).toEqual([{ name: '', parts: [0, 1] }])
    expect(topLevelGroups({ name: 'ONE', meshes: [0] }, 1)).toEqual([{ name: 'ONE', parts: [0] }])
  })

  it('faceOfTriangle 以二分搜尋找到三角形所屬的面', async () => {
    const [body] = (await load('DEMO-BUSH-R14-RC18.step')).parts
    const faces = body.faceRanges.length / 2
    for (let f = 0; f < faces; f++) {
      expect(faceOfTriangle(body, body.faceRanges[f * 2])).toBe(f)
      expect(faceOfTriangle(body, body.faceRanges[f * 2 + 1])).toBe(f)
    }
    expect(faceOfTriangle(body, body.indices.length)).toBe(-1)
  })

  it('二進位序列化來回一致', async () => {
    const t = await load('DEMO-CYL-16-50.step')
    const back = deserializeTessellation(serializeTessellation(t))
    expect(back.bbox).toEqual(t.bbox)
    expect(back.triangleCount).toBe(t.triangleCount)
    back.parts.forEach((p, i) => {
      const o = t.parts[i]
      expect(p.name).toBe(o.name)
      expect(p.color).toEqual(o.color)
      expect(Array.from(p.positions)).toEqual(Array.from(o.positions))
      expect(Array.from(p.normals)).toEqual(Array.from(o.normals))
      expect(Array.from(p.indices)).toEqual(Array.from(o.indices))
      expect(Array.from(p.faceRanges)).toEqual(Array.from(o.faceRanges))
    })
  })

  it('序列化資料損毀時丟出錯誤', () => {
    expect(() => deserializeTessellation(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow('格式錯誤')
  })

  it('無效的 STEP 內容丟出中文錯誤', async () => {
    const occt = await nodeOcct()
    expect(() => readCad(occt, new TextEncoder().encode('not a step file'), 'step')).toThrow('無法讀取')
  })

  it('依副檔名判斷格式', () => {
    expect(detectCadFormat('PC6-01.STP')).toBe('step')
    expect(detectCadFormat('a.step')).toBe('step')
    expect(detectCadFormat('a.IGS')).toBe('iges')
    expect(detectCadFormat('a.stl')).toBeNull()
  })
})
