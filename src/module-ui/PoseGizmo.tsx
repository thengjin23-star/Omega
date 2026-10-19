import { TransformControls } from '@react-three/drei'
import { useLayoutEffect, useRef } from 'react'
import { Matrix4, Object3D, Vector3 } from 'three'
import { markGizmoUsed } from './gizmoClock'
import { useModuleStore, useTransforms } from './moduleStore'

/**
 * 選取的零件上的操作把手（箭頭＝移動、圓環＝旋轉，模組座標軸）。放在零件外框中心；
 * 拖曳時即時預覽，放開時記一步復原。鎖合在別的零件上的零件：整組一起動。
 */
export function PoseGizmo() {
  const selected = useModuleStore((s) => s.selected)
  const gizmo = useModuleStore((s) => s.gizmo)
  const mode = useModuleStore((s) => s.mode)
  const products = useModuleStore((s) => s.products)
  const meshes = useModuleStore((s) => s.meshes)
  const doc = useModuleStore((s) => s.doc)
  const { transforms } = useTransforms()
  const proxy = useRef<Object3D>(new Object3D())
  const start = useRef<Matrix4 | undefined>(undefined)

  const inst = doc.instances.find((i) => i.id === selected)
  const mesh = inst && meshes[products[inst.productId]?.source.sha256 ?? '']
  const world = selected ? transforms[selected] : undefined
  const center = mesh && world ? new Vector3(...mesh.bbox.min).add(new Vector3(...mesh.bbox.max)).multiplyScalar(0.5).applyMatrix4(new Matrix4().fromArray(world)) : undefined
  const key = center?.toArray().map((v) => v.toFixed(4)).join(',')

  // 拖曳中不要把把手拉回零件中心（零件正跟著把手動）
  useLayoutEffect(() => {
    if (start.current || !center) return
    proxy.current.position.copy(center)
    proxy.current.quaternion.identity()
    proxy.current.updateMatrixWorld()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!gizmo || !center || mode !== 'select') return null
  const store = useModuleStore.getState()
  return (
    <>
      <primitive object={proxy.current} />
      <TransformControls
        object={proxy.current}
        mode={gizmo === 'move' ? 'translate' : 'rotate'}
        space="world"
        size={0.9}
        translationSnap={1}
        rotationSnap={Math.PI / 12}
        onMouseDown={() => {
          markGizmoUsed()
          proxy.current.updateMatrixWorld()
          start.current = proxy.current.matrixWorld.clone()
          store.beginTransform()
        }}
        onObjectChange={() => {
          if (!start.current) return
          proxy.current.updateMatrixWorld()
          const delta = proxy.current.matrixWorld.clone().multiply(start.current.clone().invert())
          store.previewTransform(delta.toArray())
        }}
        onMouseUp={() => {
          markGizmoUsed()
          start.current = undefined
          store.endTransform()
        }}
      />
    </>
  )
}
