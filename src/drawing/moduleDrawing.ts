import { buildBom } from '../assembly/bom'
import { tubeFrames, usedPorts, type ProductMap } from '../assembly/moduleOps'
import { formatMeters, tubeBom, tubeControlPoints, tubeLabelOf, tubeMesh } from '../assembly/tubes'
import type { DrawingInfo, FrontSide, Mat4, ModuleDoc } from '../assembly/types'
import type { Tessellation } from '../catalog/tessellation'
import { productLabel } from '../catalog/types'
import type { Vec3 } from '../geometry/vec3'
import type { AppSettings } from '../settings/settings'
import { formatSpec } from '../threads'
import { today } from '../utils/date'
import type { AssemblySheetInput, BomLine, ExternalPort, OrthoView } from './assemblyLayout'
import type { MeshGeometry } from './drawing.worker'
import { standardViews, type ProjectedView, type StandardView } from './projection'

export const FRONT_SIDES: Record<FrontSide, { label: string; front: Vec3; up: Vec3 }> = {
  '-y': { label: '前方（−Y）', front: [0, -1, 0], up: [0, 0, 1] },
  '+y': { label: '後方（+Y）', front: [0, 1, 0], up: [0, 0, 1] },
  '+x': { label: '右方（+X）', front: [1, 0, 0], up: [0, 0, 1] },
  '-x': { label: '左方（−X）', front: [-1, 0, 0], up: [0, 0, 1] },
  '+z': { label: '上方（+Z）', front: [0, 0, 1], up: [0, 1, 0] },
  '-z': { label: '下方（−Z）', front: [0, 0, -1], up: [0, 1, 0] },
}

/** 圖面選項（未設定的用預設值） */
export type DrawingOptions = Required<Omit<DrawingInfo, 'number' | 'revision' | 'notes'>> & Pick<DrawingInfo, 'number' | 'revision' | 'notes'>

export function drawingOptions(info: DrawingInfo | undefined, settings: Pick<AppSettings, 'paper' | 'projection'>): DrawingOptions {
  return {
    front: '-y',
    paper: settings.paper,
    projection: settings.projection,
    hidden: true,
    dimensions: true,
    balloons: true,
    portTags: true,
    iso: true,
    sizingSheet: false,
    ...info,
  }
}

export interface PortSource {
  item: number
  modelCode: string
  port: string
  spec: string
  origin: Vec3
  axis: Vec3
}

export interface ModuleDrawingSource {
  /** 每個零件的每個實體一筆（key 相同的網格共用） */
  instances: { key: string; matrix: number[]; item: number }[]
  geometry(key: string): MeshGeometry | undefined
  bom: BomLine[]
  ports: PortSource[]
  /** 沒有 3D 模型（或網格尚未載入）的產品型號：只列在零件表 */
  withoutModel: string[]
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

const transformPoint = (m: Mat4, p: Vec3): Vec3 => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
]

const transformDir = (m: Mat4, v: Vec3): Vec3 => {
  const d: Vec3 = [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]]
  const l = Math.hypot(d[0], d[1], d[2]) || 1
  return [d[0] / l, d[1] / l, d[2] / l]
}

/** 從模組整理出圖面需要的資料：投影用的網格、零件表、沒有接上的埠（對外接口） */
export function collectModuleDrawing(
  doc: ModuleDoc,
  products: ProductMap,
  meshes: Readonly<Record<string, Tessellation>>,
  transforms: Readonly<Record<string, Mat4>>,
): ModuleDrawingSource {
  const rows = buildBom(doc, products)
  const itemOf = new Map(rows.map((r) => [r.product.id, r.index]))
  const instances: ModuleDrawingSource['instances'] = []
  const geometries = new Map<string, MeshGeometry>()
  const withoutModel = new Set<string>()
  const used = usedPorts(doc, products)
  const ports: PortSource[] = []
  for (const inst of doc.instances) {
    const product = products[inst.productId]
    const matrix = transforms[inst.id]
    if (!product || !matrix) continue
    const item = itemOf.get(product.id) ?? 0
    const mesh = meshes[product.source.sha256]
    if (mesh) {
      mesh.parts.forEach((part, i) => {
        const key = `${product.source.sha256}:${i}`
        geometries.set(key, { positions: part.positions, indices: part.indices, faceRanges: part.faceRanges })
        instances.push({ key, matrix, item })
      })
    } else {
      withoutModel.add(product.modelCode || productLabel(product))
    }
    for (const port of product.ports) {
      if (used.has(`${inst.id}:${port.id}`)) continue
      // 閥底面的安裝面沒有裝集裝座：不是對外接口（底面的 P／排氣口各自列出）
      if (port.spec?.kind === 'interface' && product.ports.some((q) => q.sealedBy === port.id)) continue
      ports.push({
        item,
        modelCode: product.modelCode || productLabel(product),
        port: port.name,
        spec: port.spec ? formatSpec(port.spec) : '（未設定規格）',
        origin: transformPoint(matrix, port.frame.origin),
        axis: transformDir(matrix, port.frame.axis),
      })
    }
  }
  // PU 管：依兩端埠的位置產生圓管網格，一起投影（零件表項次接在產品之後）
  const tubeItems = new Map(tubeBom(doc).map((t, i) => [t.label, rows.length + i + 1]))
  for (const tube of doc.tubes ?? []) {
    const ends = tubeFrames(doc, products, tube, transforms)
    if (!ends) continue
    const key = `tube:${tube.id}:${JSON.stringify(ends)}:${tube.od}`
    geometries.set(key, tubeMesh(tubeControlPoints(ends[0], ends[1]), tube.od / 2))
    instances.push({ key, matrix: IDENTITY_MATRIX, item: tubeItems.get(tubeLabelOf(tube)) ?? 0 })
  }
  return {
    instances,
    geometry: (key) => geometries.get(key),
    bom: [
      ...rows.map((r) => ({ item: r.index, modelCode: r.product.modelCode, name: r.product.name, maker: r.product.maker, quantity: r.quantity })),
      ...tubeBom(doc).map((t, i) => ({ item: rows.length + i + 1, modelCode: `PU 管 ${t.label}`, name: `PU 管（${t.count} 條）`, quantity: formatMeters(t.length) })),
    ],
    ports,
    withoutModel: [...withoutModel],
  }
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** 把投影好的視圖與模組資料組成組立圖的輸入 */
export function assemblyInput(
  doc: ModuleDoc,
  source: ModuleDrawingSource,
  views: Record<StandardView, ProjectedView>,
  options: DrawingOptions,
  settings: Pick<AppSettings, 'company' | 'drawer'>,
  date = today(),
): AssemblySheetInput {
  const side: StandardView = options.projection === 'third' ? 'right' : 'left'
  const bases = standardViews(FRONT_SIDES[options.front].front, FRONT_SIDES[options.front].up)
  const pick = (name: StandardView): ProjectedView => (options.hidden ? views[name] : { ...views[name], hidden: new Float32Array() })
  const ortho: Record<OrthoView, StandardView> = { front: 'front', top: 'top', side }
  const ports: ExternalPort[] = source.ports.map((p, i) => ({
    tag: i + 1,
    item: p.item,
    modelCode: p.modelCode,
    port: p.port,
    spec: p.spec,
    views: Object.fromEntries(
      (Object.keys(ortho) as OrthoView[]).map((name) => {
        const basis = bases[ortho[name]]
        const pt = views[ortho[name]].points[i]
        return [name, { x: pt.x, y: pt.y, visible: pt.visible, dx: dot(p.axis, basis.right), dy: dot(p.axis, basis.up), facing: dot(p.axis, basis.forward) }]
      }),
    ),
  }))
  return {
    paper: options.paper,
    projection: options.projection,
    views: { front: pick('front'), top: pick('top'), side: pick(side), iso: options.iso ? views.iso : undefined },
    bom: source.bom,
    ports,
    title: {
      company: settings.company,
      title: doc.name,
      drawingNo: options.number,
      customer: doc.customer,
      revision: options.revision,
      date,
      drawer: settings.drawer,
    },
    notes: options.notes,
    balloons: options.balloons,
    dimensions: options.dimensions,
    portTags: options.portTags,
  }
}
