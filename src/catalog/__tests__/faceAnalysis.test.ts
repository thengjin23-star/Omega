import { describe, expect, it } from 'vitest'
import { dot, distance, type Vec3 } from '../../geometry/vec3'
import { parseSpec, specKey, suggestByDiameter } from '../../threads'
import { readCad } from '../cad'
import { analyzeFace, proposePort } from '../faceAnalysis'
import { createOpenTester } from '../openTester'
import type { MeshPart } from '../tessellation'
import { nodeOcct, readSample, sampleManifest } from './nodeHelpers'

/** 產生沿 Z 軸、半徑 r、高度 z0~z1 的圓柱面（inward = 孔） */
function cylinderPart(r: number, z0: number, z1: number, inward: boolean): MeshPart {
  const segments = 24
  const positions: number[] = []
  const normals: number[] = []
  for (let k = 0; k < segments; k++) {
    const a = (k / segments) * Math.PI * 2
    const [x, y] = [Math.cos(a), Math.sin(a)]
    for (const z of [z0, z1]) {
      positions.push(r * x, r * y, z)
      normals.push(inward ? -x : x, inward ? -y : y, 0)
    }
  }
  const indices: number[] = []
  for (let k = 0; k < segments; k++) {
    const a = k * 2
    const b = ((k + 1) % segments) * 2
    indices.push(a, b, a + 1, b, b + 1, a + 1)
  }
  return {
    name: 'test',
    color: null,
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    faceRanges: Uint32Array.from([0, indices.length / 3 - 1]),
  }
}

function planePart(): MeshPart {
  return {
    name: 'plane',
    color: null,
    positions: Float32Array.from([0, 0, 5, 10, 0, 5, 10, 10, 5, 0, 10, 5]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    faceRanges: Uint32Array.from([0, 1]),
  }
}

describe('analyzeFace（合成網格）', () => {
  it('孔：軸向、直徑、範圍', () => {
    const f = analyzeFace(cylinderPart(4.3, 0, 10, true), 0)
    if (f.kind !== 'cylinder') throw new Error(f.kind)
    expect(f.shape).toBe('hole')
    expect(Math.abs(f.axis[2])).toBeCloseTo(1, 6)
    expect(f.radius * 2).toBeCloseTo(8.6, 3)
    expect(f.tMax - f.tMin).toBeCloseTo(10, 6)
  })

  it('凸柱', () => {
    const f = analyzeFace(cylinderPart(4.865, -7, 0, false), 0)
    expect(f).toMatchObject({ kind: 'cylinder', shape: 'boss' })
  })

  it('平面：法向量與重心', () => {
    const f = analyzeFace(planePart(), 0)
    if (f.kind !== 'plane') throw new Error(f.kind)
    expect(f.normal).toEqual([0, 0, 1])
    expect(f.centroid[0]).toBeCloseTo(5, 6)
    expect(f.centroid[2]).toBeCloseTo(5, 6)
    expect(f.area).toBeCloseTo(100, 6)
  })
})

describe('proposePort（合成）', () => {
  const hole = analyzeFace(cylinderPart(3, 0, 10, true), 0)

  it('只有頂端開放的盲孔：原點在孔口、方向朝外', () => {
    const open = (o: Vec3) => o[2] > 10 // 孔口在 z = 10
    const p = proposePort(hole, open)
    expect(p.shape).toBe('hole')
    expect(p.origin[2]).toBeCloseTo(10, 6)
    expect(p.axis[2]).toBeCloseTo(1, 6)
    expect(p.diameter).toBeCloseTo(6, 3)
    expect(p.length).toBeCloseTo(10, 6)
  })

  it('貫穿孔：取靠近點選位置的一端', () => {
    const open = () => true
    expect(proposePort(hole, open, [3, 0, 1]).origin[2]).toBeCloseTo(0, 6)
    expect(proposePort(hole, open, [3, 0, 9]).origin[2]).toBeCloseTo(10, 6)
  })

  it('凸柱：原點在根部、方向朝尖端', () => {
    const boss = analyzeFace(cylinderPart(4.865, -7, 0, false), 0)
    const open = (o: Vec3) => o[2] < -7 // 尖端在 z = -7
    const p = proposePort(boss, open)
    expect(p.shape).toBe('boss')
    expect(p.origin[2]).toBeCloseTo(0, 6)
    expect(p.axis[2]).toBeCloseTo(-1, 6)
  })
})

describe('範例零件：點選每個預設埠所在的面，自動偵測結果與建模參數一致', () => {
  it('所有範例埠的位置、方向、孔／凸柱都正確，且建議規格包含正確答案', async () => {
    const occt = await nodeOcct()
    let checked = 0
    for (const part of sampleManifest().parts) {
      const t = readCad(occt, await readSample(part.file), 'step')
      const isOpen = createOpenTester(t)
      const faces = t.parts.flatMap((mesh) =>
        Array.from({ length: mesh.faceRanges.length / 2 }, (_, i) => ({ mesh, index: i, face: analyzeFace(mesh, i) })),
      )
      for (const port of part.ports) {
        // 閥座安裝面是平面（原點由 P 口偏移算出），沒有對應的圓柱面
        if (/系列閥座/.test(port.spec)) continue
        const label = `${part.modelCode} ${port.name}`
        // 找出埠所在的圓柱面：埠原點在軸線上且位於某一端
        const hit = faces.find(({ face }) => {
          if (face.kind !== 'cylinder' || face.shape !== port.shape) return false
          const t0 = dot(port.origin, face.axis)
          const onAxis = distance(port.origin, [0, 1, 2].map((k) => face.center[k] + face.axis[k] * t0) as Vec3)
          return onAxis < 0.05 && Math.min(Math.abs(t0 - face.tMin), Math.abs(t0 - face.tMax)) < 0.05
        })
        expect(hit, `${label}：找不到對應的圓柱面`).toBeDefined()
        // 模擬使用者點選：取這個面上最靠近埠口的頂點（貫穿孔時由點選位置決定哪一端）
        const s = hit!.mesh
        let click: Vec3 = port.origin
        let best = Infinity
        for (let tri = s.faceRanges[hit!.index * 2]; tri <= s.faceRanges[hit!.index * 2 + 1]; tri++) {
          for (let k = 0; k < 3; k++) {
            const vi = s.indices[tri * 3 + k]
            const v: Vec3 = [s.positions[vi * 3], s.positions[vi * 3 + 1], s.positions[vi * 3 + 2]]
            if (distance(v, port.origin) < best) [best, click] = [distance(v, port.origin), v]
          }
        }
        const proposal = proposePort(hit!.face, isOpen, click)
        expect(distance(proposal.origin, port.origin), `${label} 原點`).toBeLessThan(0.05)
        expect(dot(proposal.axis, port.axis), `${label} 方向`).toBeGreaterThan(0.999)
        expect(proposal.shape, label).toBe(port.shape)

        if (!port.spec.startsWith('安裝面')) {
          const expected = parseSpec(port.spec, { gender: port.shape === 'hole' ? 'female' : 'male' })
          if (!expected.ok) throw new Error(expected.error)
          const suggestions = suggestByDiameter(proposal.diameter!, proposal.shape === 'hole' ? 'hole' : 'boss')
          expect(suggestions.map((x) => specKey(x.spec)), `${label} 建議規格`).toContain(specKey(expected.spec))
        }
        checked++
      }
    }
    expect(checked).toBe(sampleManifest().parts.reduce((n, p) => n + p.ports.filter((q) => !/系列閥座/.test(q.spec)).length, 0))
  }, 60_000)
})
