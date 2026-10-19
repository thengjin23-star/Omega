import { Matrix4, Vector3 } from 'three'
import type { PortFrame } from '../catalog/types'
import type { Vec3 } from '../geometry/vec3'
import type { Mat4 } from './types'

/** 埠座標系 → 零件座標系的矩陣：x = ref、z = axis（朝外）、y = z × x */
export function frameMatrix(frame: PortFrame): Matrix4 {
  const z = new Vector3(...frame.axis).normalize()
  const x = new Vector3(...frame.ref).normalize()
  const y = new Vector3().crossVectors(z, x)
  return new Matrix4().makeBasis(x, y, z).setPosition(...frame.origin)
}

const FLIP = new Matrix4().makeRotationX(Math.PI)

/**
 * 鎖合後子零件的世界矩陣：
 *   W子 = W父 · F父埠 · Rz(θ) · Rx(π) · F子埠⁻¹
 * 結果：兩埠原點重合、軸線相反；θ = 0 時兩個 ref 方向一致。
 * 反過來以子零件為父（re-root）時，公式形式相同、角度不變。
 */
export function mateTransform(parentWorld: Matrix4, parentFrame: PortFrame, childFrame: PortFrame, angleDeg: number, offset = 0): Matrix4 {
  // offset：沿父零件埠的軸往外拉開（爆炸圖）
  const m = parentWorld.clone().multiply(frameMatrix(parentFrame))
  if (offset) m.multiply(new Matrix4().makeTranslation(0, 0, offset))
  return m
    .multiply(new Matrix4().makeRotationZ((angleDeg * Math.PI) / 180))
    .multiply(FLIP)
    .multiply(frameMatrix(childFrame).invert())
}

export const toMatrix = (m: Mat4 | undefined): Matrix4 => (m ? new Matrix4().fromArray(m) : new Matrix4())
export const fromMatrix = (m: Matrix4): Mat4 => m.toArray()

/** 埠在世界座標中的原點與方向 */
export function worldFrame(world: Mat4, frame: PortFrame): { origin: Vec3; axis: Vec3; ref: Vec3 } {
  const m = toMatrix(world)
  const origin = new Vector3(...frame.origin).applyMatrix4(m)
  const axis = new Vector3(...frame.axis).transformDirection(m)
  const ref = new Vector3(...frame.ref).transformDirection(m)
  return { origin: origin.toArray(), axis: axis.toArray(), ref: ref.toArray() }
}
