import { GizmoHelper, GizmoViewport, OrbitControls } from '@react-three/drei'
import { OverlayHtml } from './OverlayHtml'
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Box3, Color, Matrix4, Vector3, type Group, type PerspectiveCamera } from 'three'
import { computeTransforms } from '../assembly/moduleOps'
import type { ModuleInstance } from '../assembly/types'
import { faceOfTriangle, type Tessellation } from '../catalog/tessellation'
import type { Product } from '../catalog/types'
import type { Vec3 } from '../geometry/vec3'
import { faceGeometry, geometriesFor } from './geometryCache'
import { useModuleStore, useTransforms } from './moduleStore'
import { DimensionLines, MeasureOverlay } from './Measure'
import { PortMarker } from './PortMarker'
import { TubeView } from './TubeView'
import { cylinderMotion, interactionOf, meshCenter, useSimPiston, useSimSignalChip, useSimValveActive } from './simulation'
import { ViewportCameraBridge } from './viewportCamera'

const DEFAULT_COLOR = new Color('#b9c1c9')

/**
 * 模擬中的訊號標籤（零件中央）：氣缸代號與 a0／a1 燈號、電磁閥線圈的輸出、壓力開關；
 * 沒有可動件的氣缸另外顯示伸出百分比。
 */
function SignalChip({ nodeId, mesh, stroke }: { nodeId: string; mesh: Tessellation; stroke?: number }) {
  const chip = useSimSignalChip(nodeId)
  const center = useMemo(() => meshCenter(mesh), [mesh])
  if (!chip && stroke === undefined) return null
  const [title, ...lamps] = chip ?? ['']
  return (
    <OverlayHtml position={center} center zIndexRange={[20, 0]}>
      <span className="pointer-events-none flex items-center gap-1 rounded bg-slate-800/85 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-white" data-signal-chip={title || lamps.map((l) => l.split(':')[0]).join(' ')}>
        {title && <strong className="font-mono">{title}</strong>}
        {lamps.map((l) => {
          const [name, on] = l.split(':')
          const output = /^Y/.test(name)
          return (
            <span key={name} className="flex items-center gap-0.5 font-mono" data-lamp={name} data-on={on === '1' || undefined}>
              <span
                className={`inline-block h-2 w-2 rounded-full border ${on === '1' ? (output ? 'border-amber-300 bg-amber-400' : 'border-green-300 bg-green-400') : 'border-slate-400 bg-transparent'}`}
              />
              {name}
            </span>
          )
        })}
        {stroke !== undefined && <span>伸出 {Math.round(stroke * 100)}%</span>}
      </span>
    </OverlayHtml>
  )
}

function InstanceView({ instance, product, mesh, matrix }: { instance: ModuleInstance; product: Product; mesh: Tessellation; matrix: number[] }) {
  const group = useRef<Group>(null)
  const geometries = geometriesFor(product.source.sha256, mesh)
  const selected = useModuleStore((s) => s.selected === instance.id)
  const connecting = useModuleStore((s) => !!s.connectFrom)
  const defining = useModuleStore((s) => s.mode === 'define-port')
  const simulating = useModuleStore((s) => s.mode === 'simulate')
  const nodeType = useModuleStore((s) => s.sim?.mc.circuit.nodes.find((n) => n.id === instance.id)?.type)
  const interaction = simulating ? interactionOf(nodeType) : undefined
  const valveActive = useSimValveActive(instance.id)
  const piston = useSimPiston(instance.id)
  const motion = useMemo(() => cylinderMotion(product, mesh), [product, mesh])
  const offset = motion && piston !== undefined ? (motion.axis.map((v) => v * piston * motion.stroke) as Vec3) : undefined
  const [hover, setHover] = useState<{ part: number; face: number } | null>(null)
  const colors = useMemo(() => mesh.parts.map((p) => (p.color ? new Color(...p.color) : DEFAULT_COLOR)), [mesh])

  useLayoutEffect(() => {
    const g = group.current
    if (!g) return
    g.matrix.fromArray(matrix)
    g.matrixWorldNeedsUpdate = true
  }, [matrix])

  const onClick = (e: ThreeEvent<MouseEvent>, partIndex: number) => {
    if (e.delta > 4) return // 拖曳旋轉視角，不是點選
    e.stopPropagation()
    const s = useModuleStore.getState()
    if (s.mode === 'simulate') {
      if (interaction === 'toggle') s.simulationInteract(instance.id)
      return
    }
    if (s.mode === 'measure') {
      s.addMeasurePoint(e.point.toArray() as Vec3)
      return
    }
    if (s.mode === 'define-port' && e.faceIndex != null) {
      const local = e.object.worldToLocal(e.point.clone())
      s.pickFace(instance.id, partIndex, e.faceIndex, local.toArray() as Vec3)
    } else {
      s.select(instance.id)
    }
  }

  const onMove = (e: ThreeEvent<PointerEvent>, partIndex: number) => {
    if (!defining || e.faceIndex == null) return
    e.stopPropagation()
    const face = faceOfTriangle(mesh.parts[partIndex], e.faceIndex)
    if (!hover || hover.part !== partIndex || hover.face !== face) setHover({ part: partIndex, face })
  }

  // 按鈕閥：按住作動、放開（或移出零件）復歸。掛在整個零件上，游標在零件的各個網格之間移動時不會放開
  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (interaction !== 'momentary') return
    e.stopPropagation()
    useModuleStore.getState().simulationInteract(instance.id, 'press')
  }
  const release = () => {
    if (interaction === 'momentary') useModuleStore.getState().simulationInteract(instance.id, 'release')
  }

  // 結束模擬時游標可能還停在閥上：恢復游標
  useEffect(() => {
    if (!interaction) return
    return () => {
      document.body.style.cursor = ''
    }
  }, [interaction])

  const emissive = selected ? '#2563eb' : valveActive ? '#f59e0b' : '#000000'
  const emissiveIntensity = selected ? 0.22 : valveActive ? 0.35 : 0
  return (
    <group
      ref={group}
      name={instance.id}
      matrixAutoUpdate={false}
      onPointerDown={interaction ? onPointerDown : undefined}
      onPointerUp={interaction ? release : undefined}
      onPointerEnter={interaction ? () => (document.body.style.cursor = 'pointer') : undefined}
      onPointerLeave={
        interaction
          ? () => {
              document.body.style.cursor = ''
              release()
            }
          : undefined
      }
    >
      {geometries.map((g, i) => {
        const part = (
          <mesh
            key={i}
            geometry={g}
            onClick={(e) => onClick(e, i)}
            onPointerMove={(e) => onMove(e, i)}
            onPointerOut={() => setHover(null)}
          >
            <meshStandardMaterial
              color={colors[i]}
              metalness={0.15}
              roughness={0.55}
              emissive={emissive}
              emissiveIntensity={emissiveIntensity}
              transparent={connecting}
              opacity={connecting ? 0.75 : 1}
            />
          </mesh>
        )
        // 氣缸的可動件：沿伸出方向移動「活塞位置 × 行程」
        return offset && motion?.parts.has(i) ? (
          <group key={i} position={offset}>
            {part}
          </group>
        ) : (
          part
        )
      })}
      {simulating && <SignalChip nodeId={instance.id} mesh={mesh} stroke={piston !== undefined && !motion ? piston : undefined} />}
      {defining && hover && (
        <mesh geometry={faceGeometry(product.source.sha256, hover.part, mesh.parts[hover.part], hover.face)} renderOrder={3}>
          <meshBasicMaterial color="#2563eb" transparent opacity={0.45} depthTest={false} />
        </mesh>
      )}
      {product.ports.map((p) => (
        <PortMarker key={p.id} instanceId={instance.id} port={p} showLabel={selected} />
      ))}
    </group>
  )
}

/** 收到縮放要求時，把相機對準所有零件 */
function FitController({ root }: { root: React.RefObject<Group | null> }) {
  const fitRequest = useModuleStore((s) => s.fitRequest)
  const get = useThree((s) => s.get)
  useEffect(() => {
    const g = root.current
    if (!g) return
    const state = get()
    const camera = state.camera as PerspectiveCamera
    const controls = state.controls as unknown as { target: Vector3; update(): void } | null
    const target = useModuleStore.getState().fitTarget
    const box = new Box3().setFromObject((target && g.getObjectByName(target)) || g)
    if (box.isEmpty()) return
    const center = box.getCenter(new Vector3())
    const radius = Math.max(box.getSize(new Vector3()).length() / 2, 20)
    const distance = radius / Math.sin(((camera.fov / 2) * Math.PI) / 180)
    const dir = new Vector3(0.8, -1, 0.7).normalize()
    camera.position.copy(center).addScaledVector(dir, distance * 1.1)
    camera.near = Math.max(0.1, distance / 200)
    camera.far = distance * 50
    camera.updateProjectionMatrix()
    controls?.target.copy(center)
    controls?.update()
  }, [fitRequest, get, root])
  return null
}

/** 開發模式專用：讓自動化測試能把零件上的 3D 點換算成螢幕座標 */
function TestHook() {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as unknown as Record<string, unknown>
    w.__pneumatic3d = {
      project(instanceId: string, local: Vec3) {
        const { doc, products } = useModuleStore.getState()
        const { transforms } = computeTransforms(doc, products)
        const p = new Vector3(...local).applyMatrix4(new Matrix4().fromArray(transforms[instanceId])).project(camera)
        const rect = gl.domElement.getBoundingClientRect()
        return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
      },
      state: () => useModuleStore.getState(),
      transforms: () => {
        const { doc, products } = useModuleStore.getState()
        return computeTransforms(doc, products).transforms
      },
      /** 每個零件的外框（模組座標）：[min, max] */
      boxes: () => {
        const { doc, products, meshes } = useModuleStore.getState()
        const { transforms } = computeTransforms(doc, products)
        return Object.fromEntries(
          doc.instances.flatMap((i) => {
            const mesh = meshes[products[i.productId]?.source.sha256 ?? '']
            if (!mesh || !transforms[i.id]) return []
            const box = new Box3(new Vector3(...mesh.bbox.min), new Vector3(...mesh.bbox.max)).applyMatrix4(new Matrix4().fromArray(transforms[i.id]))
            return [[i.id, [box.min.toArray(), box.max.toArray()]]]
          }),
        )
      },
    }
    return () => {
      delete w.__pneumatic3d
    }
  }, [camera, gl])
  return null
}

export function Viewport() {
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const meshes = useModuleStore((s) => s.meshes)
  const { transforms } = useTransforms()
  const root = useRef<Group>(null)

  return (
    <Canvas
      className="touch-none"
      camera={{ position: [260, -320, 220], up: [0, 0, 1], fov: 40, near: 0.5, far: 50000 }}
      onPointerMissed={(e) => {
        if (e.type !== 'click') return
        const s = useModuleStore.getState()
        if (s.connectFrom) s.cancelConnect()
        else if (s.mode === 'tube') s.setMode('tube')
        else if (s.mode === 'select') {
          s.select(undefined)
          s.selectTube(undefined)
        } else if (s.mode === 'measure') s.clearMeasure()
      }}
    >
      <color attach="background" args={['#eef2f6']} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[300, -200, 500]} intensity={1.7} />
      <directionalLight position={[-300, 300, 200]} intensity={0.7} />
      <gridHelper args={[1200, 60, '#c3ccd6', '#dde3ea']} rotation={[Math.PI / 2, 0, 0]} />
      <group ref={root}>
        {doc.instances.map((inst) => {
          const product = products[inst.productId]
          const mesh = product && meshes[product.source.sha256]
          if (!product || !mesh || !transforms[inst.id]) return null
          return <InstanceView key={inst.id} instance={inst} product={product} mesh={mesh} matrix={transforms[inst.id]} />
        })}
        {(doc.tubes ?? []).map((t) => (
          <TubeView key={t.id} tube={t} />
        ))}
      </group>
      <OrbitControls makeDefault enableDamping={false} />
      <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
        <GizmoViewport axisColors={['#dc2626', '#16a34a', '#2563eb']} labelColor="white" />
      </GizmoHelper>
      <MeasureOverlay />
      <DimensionLines />
      <FitController root={root} />
      <ViewportCameraBridge />
      <TestHook />
    </Canvas>
  )
}
