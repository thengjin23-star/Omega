import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import type { Camera } from 'three'
import type { Vec3 } from '../geometry/vec3'

let camera: Camera | undefined

/** 放在 3D 畫面的 Canvas 裡：讓示意圖可以沿用目前的視角 */
export function ViewportCameraBridge() {
  const c = useThree((s) => s.camera)
  useEffect(() => {
    camera = c
    return () => {
      if (camera === c) camera = undefined
    }
  }, [c])
  return null
}

/** 目前 3D 畫面的視線方向與畫面上方（3D 畫面沒有顯示時為 undefined） */
export function viewportDirection(): { dir: Vec3; up: Vec3 } | undefined {
  if (!camera) return undefined
  camera.updateMatrixWorld()
  const e = camera.matrixWorld.elements
  // 相機座標：第 2 欄為上方、第 3 欄為後方（看的方向的反向）
  const up: Vec3 = [e[4], e[5], e[6]]
  const dir: Vec3 = [-e[8], -e[9], -e[10]]
  return { dir, up }
}
