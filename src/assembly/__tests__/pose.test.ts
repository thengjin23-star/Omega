import { Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '../../geometry/vec3'
import { toMatrix } from '../frames'
import { computeTransforms, placementFromPose, rootOf, rootPose, rotationAbout, transformGroup } from '../moduleOps'
import { PRODUCTS, valveCylinder } from './sampleModules'

const close = (a: number[], b: number[], digits = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits))
const centerOf = (m: number[], local: Vec3) => new Vector3(...local).applyMatrix4(toMatrix(m)).toArray()

describe('零件的移動與旋轉', () => {
  it('旋轉根零件：接在它上面的零件跟著轉（鎖合不變），其他群組不動', () => {
    const b = valveCylinder()
    const before = computeTransforms(b.doc, PRODUCTS).transforms
    const pivot: Vec3 = [0, 0, 13]
    const doc = transformGroup(b.doc, PRODUCTS, b.ids.v, rotationAbout('x', 90, pivot))
    const after = computeTransforms(doc, PRODUCTS).transforms
    expect(doc.mates).toEqual(b.doc.mates)
    // 閥與接在閥上的接頭：一起繞 X 轉 90°
    const R = toMatrix(rotationAbout('x', 90, pivot))
    for (const id of [b.ids.v, b.ids.fa, b.ids.fp, b.ids.ea]) close(after[id], R.clone().multiply(toMatrix(before[id])).toArray())
    // 氣缸那一組沒有連在閥上：不動
    for (const id of [b.ids.c, b.ids.sa, b.ids.sb]) expect(after[id]).toEqual(before[id])
  })

  it('鎖合在別的零件上的零件：整組（根零件）一起動', () => {
    const b = valveCylinder()
    expect(rootOf(b.doc, b.ids.fa)).toBe(b.ids.v)
    const before = computeTransforms(b.doc, PRODUCTS).transforms
    const move = new Matrix4().makeTranslation(10, -5, 3).toArray()
    const doc = transformGroup(b.doc, PRODUCTS, b.ids.fa, move)
    const after = computeTransforms(doc, PRODUCTS).transforms
    close(after[b.ids.v].slice(12, 15), [before[b.ids.v][12] + 10, before[b.ids.v][13] - 5, before[b.ids.v][14] + 3])
    close(after[b.ids.fa].slice(12, 15), [before[b.ids.fa][12] + 10, before[b.ids.fa][13] - 5, before[b.ids.fa][14] + 3])
    expect(doc.placements[b.ids.fa]).toEqual(b.doc.placements[b.ids.fa])
  })

  it('繞中心轉 90° 四次回到原位，沒有累積誤差；中心不動', () => {
    const b = valveCylinder()
    const local: Vec3 = [12.75, 0, 19.1]
    const start = computeTransforms(b.doc, PRODUCTS).transforms[b.ids.v]
    const pivot = centerOf(start, local) as Vec3
    let doc = b.doc
    for (let i = 0; i < 4; i++) {
      doc = transformGroup(doc, PRODUCTS, b.ids.v, rotationAbout('z', 90, pivot))
      close(centerOf(computeTransforms(doc, PRODUCTS).transforms[b.ids.v], local), pivot)
    }
    expect(computeTransforms(doc, PRODUCTS).transforms[b.ids.v]).toEqual(start)
  })

  it('位置與方向的數值：讀出後原樣寫回不變；輸入 90°／180° 得到整數矩陣', () => {
    const local: Vec3 = [5, -2, 13]
    const placement = new Matrix4().makeRotationZ(Math.PI / 2).setPosition(40, 10, 0).toArray()
    const pose = rootPose(placement, local)
    expect(pose.rotation).toEqual([0, 0, 90])
    close(placementFromPose(pose, local), placement)
    const flipped = placementFromPose({ center: pose.center, rotation: [180, 0, 90] }, local)
    expect(flipped.slice(0, 11).every((v) => Number.isInteger(v))).toBe(true)
    close(centerOf(flipped, local), pose.center)
    expect(rootPose(flipped, local).rotation).toEqual([180, 0, 90])
  })
})
