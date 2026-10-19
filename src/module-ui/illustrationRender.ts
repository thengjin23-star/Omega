import {
  AmbientLight,
  BufferGeometry,
  Color,
  CubicBezierCurve3,
  DirectionalLight,
  EdgesGeometry,
  HemisphereLight,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  OrthographicCamera,
  Scene,
  TubeGeometry,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  type Material,
  type Object3D,
} from 'three'
import { tubeFrames, type ProductMap } from '../assembly/moduleOps'
import { tubeControlPoints, tubeLabelOf } from '../assembly/tubes'
import type { Mat4, ModuleDoc } from '../assembly/types'
import type { Tessellation } from '../catalog/tessellation'
import { outlineMask, visibleAnchors } from '../drawing/illustration'
import type { Pt } from '../drawing/types'
import type { Vec3 } from '../geometry/vec3'
import { geometriesFor } from './geometryCache'

/** 示意圖裡的一個零件（或一條 PU 管）：同一個 group 的零件共用一個標註 */
export interface IllustrationItem {
  group: string
  geometries: BufferGeometry[]
  /** 各網格的顏色（3D 檔沒有顏色時為 undefined） */
  colors: (readonly [number, number, number] | null | undefined)[]
  matrix: Mat4
  tube?: boolean
}

export interface IllustrationRenderOptions {
  /** 相機看的方向 */
  dir: Vec3
  /** 畫面的上方 */
  up: Vec3
  color: 'model' | 'gray'
  edges: boolean
  /** 零件圖最大的寬、高（示意圖像素） */
  maxW: number
  maxH: number
  /** 實際像素 ÷ 示意圖像素（輸出 PNG 用 2 倍，比較清楚） */
  scale: number
  /** 爆炸圖的裝配線（模組座標的線段兩端），畫成虛線 */
  guides?: readonly (readonly [Vec3, Vec3])[]
}

export interface RenderedIllustration {
  /** 著色圖（含輪廓線），大小為 width × height × scale */
  canvas: HTMLCanvasElement
  /** 零件圖大小（示意圖像素） */
  width: number
  height: number
  /** 每個零件看得到的位置（示意圖像素，相對零件圖左上角）；完全被擋住為 undefined */
  anchors: (Pt | undefined)[]
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const TUBE_COLOR = '#38bdf8'
const GRAY = '#c4c9cf'
const DEFAULT_COLOR = '#b9c1c9'
const OUTLINE: readonly [number, number, number] = [43, 48, 54]

/** 由模組整理出要畫的零件（含 PU 管）；沒有 3D 模型的產品略過 */
export function illustrationItems(
  doc: ModuleDoc,
  products: ProductMap,
  meshes: Readonly<Record<string, Tessellation>>,
  transforms: Readonly<Record<string, Mat4>>,
): { items: IllustrationItem[]; instanceOf: (string | undefined)[] } {
  const items: IllustrationItem[] = []
  const instanceOf: (string | undefined)[] = []
  for (const inst of doc.instances) {
    const product = products[inst.productId]
    const mesh = product && meshes[product.source.sha256]
    const matrix = transforms[inst.id]
    if (!product || !mesh || !matrix) continue
    items.push({ group: product.id, geometries: geometriesFor(product.source.sha256, mesh), colors: mesh.parts.map((p) => p.color), matrix })
    instanceOf.push(inst.id)
  }
  for (const tube of doc.tubes ?? []) {
    const frames = tubeFrames(doc, products, tube, transforms)
    if (!frames) continue
    const pts = tubeControlPoints(frames[0], frames[1]).map((p) => new Vector3(...p))
    const geometry = new TubeGeometry(new CubicBezierCurve3(pts[0], pts[1], pts[2], pts[3]), 64, tube.od / 2, 16, false)
    items.push({ group: `tube:${tubeLabelOf(tube)}`, geometries: [geometry], colors: [undefined], matrix: IDENTITY, tube: true })
    instanceOf.push(undefined)
  }
  return { items, instanceOf }
}

let renderer: WebGLRenderer | undefined

function getRenderer(): WebGLRenderer {
  if (!renderer) {
    const canvas = document.createElement('canvas')
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true })
    renderer.setPixelRatio(1)
  }
  return renderer
}

/** 關閉示意圖時釋放 WebGL 資源 */
export function disposeIllustrationRenderer() {
  renderer?.dispose()
  renderer?.forceContextLoss()
  renderer = undefined
}

const edgeCache = new WeakMap<BufferGeometry, EdgesGeometry>()
const edgesOf = (g: BufferGeometry) => {
  let e = edgeCache.get(g)
  if (!e) {
    e = new EdgesGeometry(g, 35)
    edgeCache.set(g, e)
  }
  return e
}

const norm = (v: Vector3) => (v.lengthSq() > 1e-12 ? v.normalize() : v)

/** 相機的座標軸：right、up（與視線垂直）、forward（看的方向） */
export function viewBasis(dir: Vec3, up: Vec3) {
  const forward = norm(new Vector3(...dir))
  let upV = new Vector3(...up)
  if (Math.abs(upV.clone().normalize().dot(forward)) > 0.999) upV = Math.abs(forward.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0)
  const right = norm(new Vector3().crossVectors(forward, upV))
  const realUp = norm(new Vector3().crossVectors(right, forward))
  return { right, up: realUp, forward }
}

/** 所有網格頂點在相機座標（right、up、forward）上的範圍 */
function projectedBounds(items: readonly IllustrationItem[], basis: ReturnType<typeof viewBasis>) {
  const { right: r, up: u, forward: f } = basis
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const item of items) {
    const m = item.matrix
    for (const g of item.geometries) {
      const pos = g.getAttribute('position')
      const arr = pos.array as ArrayLike<number>
      for (let i = 0; i < pos.count; i++) {
        const x = arr[i * 3]
        const y = arr[i * 3 + 1]
        const z = arr[i * 3 + 2]
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12]
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13]
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14]
        const a = wx * r.x + wy * r.y + wz * r.z
        const b = wx * u.x + wy * u.y + wz * u.z
        const c = wx * f.x + wy * f.y + wz * f.z
        if (a < min[0]) min[0] = a
        if (a > max[0]) max[0] = a
        if (b < min[1]) min[1] = b
        if (b > max[1]) max[1] = b
        if (c < min[2]) min[2] = c
        if (c > max[2]) max[2] = c
      }
    }
  }
  return { min, max }
}

function place(obj: Object3D, matrix: Mat4) {
  obj.matrixAutoUpdate = false
  obj.matrix.fromArray(matrix)
  obj.matrixWorldNeedsUpdate = true
}

/**
 * 以正交相機畫出模組的著色圖（白底、灰階或 3D 檔顏色、零件輪廓線），
 * 另外畫一張「零件編號圖」找出每個零件看得到的位置（箭頭落點）。
 */
export function renderIllustration(items: readonly IllustrationItem[], options: IllustrationRenderOptions): RenderedIllustration | undefined {
  if (!items.length) return undefined
  const basis = viewBasis(options.dir, options.up)
  const { min, max } = projectedBounds(items, basis)
  if (!Number.isFinite(min[0])) return undefined
  const spanX = Math.max(max[0] - min[0], 1)
  const spanY = Math.max(max[1] - min[1], 1)
  const pad = Math.max(spanX, spanY) * 0.02
  const halfW = spanX / 2 + pad
  const halfH = spanY / 2 + pad
  const aspect = halfW / halfH
  const width = Math.min(options.maxW, options.maxH * aspect)
  const height = width / aspect

  const r = getRenderer()
  const maxSize = Math.min(4096, r.capabilities.maxTextureSize || 4096)
  const scale = Math.min(options.scale, maxSize / width, maxSize / height)
  const rw = Math.max(1, Math.round(width * scale))
  const rh = Math.max(1, Math.round(height * scale))

  // 相機：在模組前方，看向 forward
  const depth = max[2] - min[2]
  const { right, up, forward } = basis
  const center = new Vector3()
    .addScaledVector(right, (min[0] + max[0]) / 2)
    .addScaledVector(up, (min[1] + max[1]) / 2)
    .addScaledVector(forward, min[2] - 10)
  const camera = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 1, depth + 20)
  camera.position.copy(center)
  camera.up.copy(up)
  camera.lookAt(center.clone().add(forward))
  camera.updateMatrixWorld()

  const disposables: { dispose(): void }[] = []
  const track = <T extends { dispose(): void }>(x: T) => {
    disposables.push(x)
    return x
  }
  try {
    // ---- 著色圖 ----
    const scene = new Scene()
    scene.background = new Color('#ffffff')
    const span = Math.max(spanX, spanY, depth) * 4
    scene.add(new AmbientLight(0xffffff, 0.35))
    const hemi = new HemisphereLight(0xffffff, 0x8f98a3, 1.15)
    hemi.position.copy(up)
    scene.add(hemi)
    const key = new DirectionalLight(0xffffff, 1.9)
    key.position.copy(center).addScaledVector(right, -0.55 * span).addScaledVector(up, 0.85 * span).addScaledVector(forward, -span)
    key.target.position.copy(center).addScaledVector(forward, depth / 2 + 10)
    const fill = new DirectionalLight(0xffffff, 0.55)
    fill.position.copy(center).addScaledVector(right, 0.9 * span).addScaledVector(up, -0.2 * span).addScaledVector(forward, -0.6 * span)
    fill.target.position.copy(key.target.position)
    scene.add(key, key.target, fill, fill.target)
    const lineMaterial = track(new LineBasicMaterial({ color: '#2f353b', transparent: true, opacity: 0.6 }))
    const materials = new Map<string, Material>()
    const materialFor = (c: string) => {
      let m = materials.get(c)
      if (!m) {
        m = track(new MeshStandardMaterial({ color: c, metalness: 0.2, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }))
        materials.set(c, m)
      }
      return m
    }
    for (const item of items) {
      item.geometries.forEach((g, i) => {
        const rgb = item.colors[i]
        const color = item.tube ? TUBE_COLOR : options.color === 'gray' ? GRAY : rgb ? `#${new Color(rgb[0], rgb[1], rgb[2]).getHexString()}` : DEFAULT_COLOR
        const mesh = new Mesh(g, materialFor(color))
        place(mesh, item.matrix)
        scene.add(mesh)
        if (options.edges && !item.tube) {
          const lines = new LineSegments(edgesOf(g), lineMaterial)
          place(lines, item.matrix)
          scene.add(lines)
        }
      })
    }
    if (options.guides?.length) {
      // 裝配線：虛線，畫在零件上面（不被零件擋住，看得出哪個零件裝到哪裡）
      const dash = Math.max(spanX, spanY) / 90
      const guide = track(new BufferGeometry().setFromPoints(options.guides.flatMap(([a, b]) => [new Vector3(...a), new Vector3(...b)])))
      const lines = new LineSegments(guide, track(new LineDashedMaterial({ color: '#1e40af', dashSize: dash, gapSize: dash * 0.6, depthTest: false })))
      lines.computeLineDistances()
      lines.renderOrder = 10
      scene.add(lines)
    }
    r.setSize(rw, rh, false)
    r.setRenderTarget(null)
    r.render(scene, camera)
    const out = document.createElement('canvas')
    out.width = rw
    out.height = rh
    const ctx = out.getContext('2d')
    if (!ctx) return undefined
    ctx.drawImage(r.domElement, 0, 0)

    // ---- 零件編號圖（不反鋸齒，每個零件一個顏色） ----
    const idScene = new Scene()
    idScene.background = new Color(0, 0, 0)
    items.forEach((item, k) => {
      const id = k + 1
      const material = track(new MeshBasicMaterial({ toneMapped: false }))
      material.color.setRGB(((id >> 16) & 255) / 255, ((id >> 8) & 255) / 255, (id & 255) / 255, LinearSRGBColorSpace)
      for (const g of item.geometries) {
        const mesh = new Mesh(g, material)
        place(mesh, item.matrix)
        idScene.add(mesh)
      }
    })
    const target = track(new WebGLRenderTarget(rw, rh, { minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true }))
    r.setRenderTarget(target)
    r.render(idScene, camera)
    const raw = new Uint8Array(rw * rh * 4)
    r.readRenderTargetPixels(target, 0, 0, rw, rh, raw)
    r.setRenderTarget(null)
    const ids = new Uint32Array(rw * rh)
    for (let y = 0; y < rh; y++) {
      const src = (rh - 1 - y) * rw * 4 // WebGL 由下往上
      for (let x = 0; x < rw; x++) {
        const i = src + x * 4
        ids[y * rw + x] = (raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2]
      }
    }

    // 零件輪廓線：相鄰像素屬於不同零件（或背景）的地方畫深色
    if (options.edges) {
      const mask = outlineMask(ids, rw, rh)
      const image = ctx.getImageData(0, 0, rw, rh)
      const px = image.data
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue
        const o = i * 4
        px[o] = px[o] * 0.15 + OUTLINE[0] * 0.85
        px[o + 1] = px[o + 1] * 0.15 + OUTLINE[1] * 0.85
        px[o + 2] = px[o + 2] * 0.15 + OUTLINE[2] * 0.85
      }
      ctx.putImageData(image, 0, 0)
    }

    const found = visibleAnchors(ids, rw, rh, items.length)
    const sx = width / rw
    const sy = height / rh
    return {
      canvas: out,
      width,
      height,
      anchors: found.anchors.map((a) => (a ? ([a[0] * sx, a[1] * sy] as Pt) : undefined)),
    }
  } finally {
    for (const x of disposables) x.dispose()
  }
}
