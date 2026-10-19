import { Euler, Matrix4, Vector3 } from 'three'
import type { Product, ProductPort } from '../catalog/types'
import { checkMate, specKey, type MateResult } from '../threads'
import { newId } from '../utils/id'
import type { Vec3 } from '../geometry/vec3'
import { fromMatrix, mateTransform, toMatrix, worldFrame } from './frames'
import { bezierLength, estimateTubeLength, tubeCheck, tubeControlPoints, TUBE_ERROR_TEXT, type TubeError } from './tubes'
import type { Mat4, Mate, ModuleDoc, ModuleSupply, ModuleTube, PortRef } from './types'

export type ProductMap = Readonly<Record<string, Product>>

export function createModule(name = '未命名模組'): ModuleDoc {
  const now = Date.now()
  return { id: newId('mod'), name, instances: [], mates: [], placements: {}, createdAt: now, updatedAt: now }
}

const touch = (doc: ModuleDoc, patch: Partial<ModuleDoc>): ModuleDoc => ({ ...doc, ...patch, updatedAt: Date.now() })

export function getPort(doc: ModuleDoc, products: ProductMap, ref: PortRef): ProductPort | undefined {
  const inst = doc.instances.find((i) => i.id === ref.instance)
  return inst && products[inst.productId]?.ports.find((p) => p.id === ref.port)
}

export const parentMateOf = (doc: ModuleDoc, instance: string): Mate | undefined =>
  doc.mates.find((m) => m.child.instance === instance)

/** 與某零件相連（直接或間接）的所有零件 */
export function groupOf(doc: ModuleDoc, instance: string): Set<string> {
  const group = new Set([instance])
  const queue = [instance]
  while (queue.length) {
    const cur = queue.pop()!
    for (const m of doc.mates) {
      const other = m.parent.instance === cur ? m.child.instance : m.child.instance === cur ? m.parent.instance : null
      if (other && !group.has(other)) {
        group.add(other)
        queue.push(other)
      }
    }
  }
  return group
}

/** 已經被鎖合或 PU 管使用的埠（instance:port） */
export function usedPorts(doc: ModuleDoc, products?: ProductMap): Set<string> {
  const used = new Set([
    ...doc.mates.flatMap((m) => [`${m.parent.instance}:${m.parent.port}`, `${m.child.instance}:${m.child.port}`]),
    ...(doc.tubes ?? []).flatMap((t) => [`${t.a.instance}:${t.a.port}`, `${t.b.instance}:${t.b.port}`]),
  ])
  // 安裝面已經裝上時，被它封住的埠（例如閥底面的 P／排氣口）也算接了
  if (products)
    for (const inst of doc.instances)
      for (const port of products[inst.productId]?.ports ?? [])
        if (port.sealedBy && used.has(`${inst.id}:${port.sealedBy}`)) used.add(`${inst.id}:${port.id}`)
  return used
}

/** PU 管兩端埠在模組座標中的位置與朝外的軸向；零件或埠已不存在時回傳 undefined */
export function tubeFrames(
  doc: ModuleDoc,
  products: ProductMap,
  tube: Pick<ModuleTube, 'a' | 'b'>,
  transforms: Readonly<Record<string, Mat4>>,
): [{ origin: Vec3; axis: Vec3 }, { origin: Vec3; axis: Vec3 }] | undefined {
  const [a, b] = [tube.a, tube.b].map((ref) => {
    const port = getPort(doc, products, ref)
    const world = transforms[ref.instance]
    return port && world ? worldFrame(world, port.frame) : undefined
  })
  return a && b ? [a, b] : undefined
}

/** 依兩端目前的位置估算 PU 管的裁切長度（mm）；零件或埠已不存在時 undefined */
export function estimateTubeLengthOf(
  doc: ModuleDoc,
  products: ProductMap,
  tube: Pick<ModuleTube, 'a' | 'b' | 'od'>,
  transforms: Readonly<Record<string, Mat4>> = computeTransforms(doc, products).transforms,
): number | undefined {
  const frames = tubeFrames(doc, products, tube, transforms)
  return frames ? estimateTubeLength(bezierLength(tubeControlPoints(frames[0], frames[1])), tube.od) : undefined
}

/** PU 管的長度（mm）：有指定就用指定值，否則依兩端位置估算 */
export function tubeLength(
  doc: ModuleDoc,
  products: ProductMap,
  tube: ModuleTube,
  transforms?: Readonly<Record<string, Mat4>>,
): number | undefined {
  return tube.length ?? estimateTubeLengthOf(doc, products, tube, transforms)
}

export interface TransformResult {
  transforms: Record<string, Mat4>
  /** 引用的埠已不存在（例如產品的埠被刪除）的鎖合 */
  broken: string[]
}

/**
 * 由根零件的位置與鎖合關係推導每個零件的世界矩陣。
 * explode（mm）：爆炸圖，每個鎖合的子零件沿父零件埠的方向往外拉開這個距離（示意圖用，不影響模組）。
 */
export function computeTransforms(doc: ModuleDoc, products: ProductMap, options: { explode?: number } = {}): TransformResult {
  const explode = options.explode ?? 0
  const transforms: Record<string, Mat4> = {}
  const broken: string[] = []
  const children = new Map<string, Mate[]>()
  for (const m of doc.mates) children.set(m.parent.instance, [...(children.get(m.parent.instance) ?? []), m])
  const hasParent = new Set(doc.mates.map((m) => m.child.instance))

  const visit = (instance: string, world: Matrix4) => {
    transforms[instance] = fromMatrix(world)
    for (const m of children.get(instance) ?? []) {
      if (transforms[m.child.instance]) continue
      const pp = getPort(doc, products, m.parent)
      const cp = getPort(doc, products, m.child)
      if (!pp || !cp) {
        // 埠已被刪除：先放在父零件的位置，讓使用者看得到並重新連接
        broken.push(m.id)
        visit(m.child.instance, world.clone())
        continue
      }
      visit(m.child.instance, mateTransform(world, pp.frame, cp.frame, m.angle, explode))
    }
  }
  for (const inst of doc.instances) {
    if (!hasParent.has(inst.id)) visit(inst.id, toMatrix(doc.placements[inst.id]))
  }
  // 保險：若資料不一致（例如出現迴圈），仍給每個零件一個位置
  for (const inst of doc.instances) transforms[inst.id] ??= fromMatrix(toMatrix(doc.placements[inst.id]))
  return { transforms, broken }
}

/** 爆炸圖的裝配線：每個鎖合從父零件的埠口連到子零件的埠口（模組座標） */
export function mateGuides(doc: ModuleDoc, products: ProductMap, transforms: Readonly<Record<string, Mat4>>): [Vec3, Vec3][] {
  return doc.mates.flatMap((m) => {
    const pp = getPort(doc, products, m.parent)
    const cp = getPort(doc, products, m.child)
    const pw = transforms[m.parent.instance]
    const cw = transforms[m.child.instance]
    if (!pp || !cp || !pw || !cw) return []
    return [[worldFrame(pw, pp.frame).origin, worldFrame(cw, cp.frame).origin] as [Vec3, Vec3]]
  })
}

export function addInstance(doc: ModuleDoc, productId: string, placement?: Mat4): { doc: ModuleDoc; instanceId: string } {
  const instanceId = newId('i')
  return {
    instanceId,
    doc: touch(doc, {
      instances: [...doc.instances, { id: instanceId, productId }],
      placements: { ...doc.placements, [instanceId]: placement ?? fromMatrix(new Matrix4()) },
    }),
  }
}

/** 移除零件：與它相連的子零件會變成獨立的根零件，並保持原本的位置 */
export function removeInstance(doc: ModuleDoc, products: ProductMap, instance: string): ModuleDoc {
  const { transforms } = computeTransforms(doc, products)
  const placements = { ...doc.placements }
  delete placements[instance]
  const orphans = doc.mates.filter((m) => m.parent.instance === instance).map((m) => m.child.instance)
  for (const o of orphans) placements[o] = transforms[o]
  return touch(doc, {
    instances: doc.instances.filter((i) => i.id !== instance),
    mates: doc.mates.filter((m) => m.parent.instance !== instance && m.child.instance !== instance),
    placements,
    tubes: doc.tubes?.filter((t) => t.a.instance !== instance && t.b.instance !== instance),
    supply: doc.supply?.instance === instance ? undefined : doc.supply,
  })
}

// ---------------------------------------------------------------------------------------------
// PU 管

export type AddTubeError = TubeError | 'port-in-use' | 'missing-port'

export const ADD_TUBE_ERROR_TEXT: Record<AddTubeError, string> = {
  ...TUBE_ERROR_TEXT,
  'port-in-use': '這個埠已經接了零件或管子',
  'missing-port': '找不到這個埠',
}

/** 在兩個快插接頭之間接一條 PU 管 */
export function addTube(
  doc: ModuleDoc,
  products: ProductMap,
  a: PortRef,
  b: PortRef,
  length?: number,
): { doc: ModuleDoc; tubeId: string } | { error: AddTubeError } {
  if (a.instance === b.instance && a.port === b.port) return { error: 'same-port' }
  const pa = getPort(doc, products, a)
  const pb = getPort(doc, products, b)
  if (!pa || !pb) return { error: 'missing-port' }
  const used = usedPorts(doc, products)
  if (used.has(`${a.instance}:${a.port}`) || used.has(`${b.instance}:${b.port}`)) return { error: 'port-in-use' }
  const check = tubeCheck(pa, pb)
  if (!check.ok) return { error: check.error }
  const tube: ModuleTube = { id: newId('t'), a, b, od: check.od, label: check.label, ...(length !== undefined && { length }) }
  return { tubeId: tube.id, doc: touch(doc, { tubes: [...(doc.tubes ?? []), tube] }) }
}

export function removeTube(doc: ModuleDoc, tubeId: string): ModuleDoc {
  return touch(doc, { tubes: (doc.tubes ?? []).filter((t) => t.id !== tubeId) })
}

export function updateTube(doc: ModuleDoc, tubeId: string, patch: Partial<Pick<ModuleTube, 'length'>>): ModuleDoc {
  return touch(doc, { tubes: (doc.tubes ?? []).map((t) => (t.id === tubeId ? { ...t, ...patch } : t)) })
}

/** 設定（或取消）模擬用的供氣口 */
export function setSupply(doc: ModuleDoc, supply: ModuleSupply | undefined): ModuleDoc {
  return touch(doc, { supply })
}

/**
 * 讓某個零件成為它所在群組的根：沿著它到原本根零件的路徑，把鎖合的父子對調。
 * 對調後各零件的世界位置不變（公式形式相同、角度不變）。
 */
export function reroot(doc: ModuleDoc, products: ProductMap, instance: string): ModuleDoc {
  if (!parentMateOf(doc, instance)) return doc
  const { transforms } = computeTransforms(doc, products)
  const flip = new Set<string>()
  let oldRoot = instance
  for (let cur = parentMateOf(doc, instance); cur; cur = parentMateOf(doc, cur.parent.instance)) {
    flip.add(cur.id)
    oldRoot = cur.parent.instance
  }
  const placements = { ...doc.placements, [instance]: transforms[instance] }
  delete placements[oldRoot]
  return touch(doc, {
    mates: doc.mates.map((m) => (flip.has(m.id) ? { ...m, parent: m.child, child: m.parent } : m)),
    placements,
  })
}

export type ConnectError = 'same-part' | 'already-connected' | 'port-in-use' | 'missing-port'

export const CONNECT_ERROR_TEXT: Record<ConnectError, string> = {
  'same-part': '不能把零件接到自己身上',
  'already-connected': '這兩個零件已經連在一起了（不支援形成迴圈的連接）',
  'port-in-use': '這個埠已經接了其他零件，請先拆開',
  'missing-port': '找不到這個埠',
}

/**
 * 鎖合：parent 所在的群組不動，child 所在的整個群組移過來。
 * （使用者先點的埠當 parent、後點的當 child）
 */
export function connect(
  doc: ModuleDoc,
  products: ProductMap,
  parent: PortRef,
  child: PortRef,
  angle = 0,
): { doc: ModuleDoc; mateId: string } | { error: ConnectError } {
  if (parent.instance === child.instance) return { error: 'same-part' }
  if (!getPort(doc, products, parent) || !getPort(doc, products, child)) return { error: 'missing-port' }
  if (groupOf(doc, parent.instance).has(child.instance)) return { error: 'already-connected' }
  const used = usedPorts(doc, products)
  if (used.has(`${parent.instance}:${parent.port}`) || used.has(`${child.instance}:${child.port}`)) return { error: 'port-in-use' }

  const rerooted = reroot(doc, products, child.instance)
  const placements = { ...rerooted.placements }
  delete placements[child.instance]
  const mateId = newId('m')
  return {
    mateId,
    doc: touch(rerooted, { mates: [...rerooted.mates, { id: mateId, parent, child, angle: normalizeAngle(angle) }], placements }),
  }
}

/** 拆開：子零件群組保持目前的位置，成為獨立的群組 */
export function disconnect(doc: ModuleDoc, products: ProductMap, mateId: string): ModuleDoc {
  const mate = doc.mates.find((m) => m.id === mateId)
  if (!mate) return doc
  const { transforms } = computeTransforms(doc, products)
  return touch(doc, {
    mates: doc.mates.filter((m) => m.id !== mateId),
    placements: { ...doc.placements, [mate.child.instance]: transforms[mate.child.instance] },
  })
}

export const normalizeAngle = (deg: number): number => ((Math.round(deg * 1000) / 1000) % 360 + 360) % 360

export function setMateAngle(doc: ModuleDoc, mateId: string, angle: number): ModuleDoc {
  return touch(doc, { mates: doc.mates.map((m) => (m.id === mateId ? { ...m, angle: normalizeAngle(angle) } : m)) })
}

/** 移動根零件（未鎖合的群組）的位置 */
export function setPlacement(doc: ModuleDoc, instance: string, placement: Mat4): ModuleDoc {
  return touch(doc, { placements: { ...doc.placements, [instance]: placement } })
}

/** 零件所在群組的根零件（沒有父零件的那一個） */
export function rootOf(doc: ModuleDoc, instance: string): string {
  let cur = instance
  for (let guard = 0; guard <= doc.instances.length; guard++) {
    const parent = parentMateOf(doc, cur)
    if (!parent) return cur
    cur = parent.parent.instance
  }
  return cur
}

/**
 * 在模組座標中移動／旋轉零件（delta 套在目前的世界矩陣左邊）。位置由根零件決定：
 * 根零件直接改它的位置；鎖合在別的零件上的零件，等於整組（根零件）一起動。鎖合關係不變。
 */
export function transformGroup(doc: ModuleDoc, products: ProductMap, instance: string, delta: Mat4): ModuleDoc {
  const root = rootOf(doc, instance)
  const { transforms } = computeTransforms(doc, products)
  return setPlacement(doc, root, fromMatrix(toMatrix(delta).multiply(toMatrix(transforms[root]))))
}

/** 繞通過 pivot 的 X／Y／Z 軸旋轉 deg 度的矩陣 */
export function rotationAbout(axis: 'x' | 'y' | 'z', deg: number, pivot: Vec3): Mat4 {
  const rad = (deg * Math.PI) / 180
  const r = axis === 'x' ? new Matrix4().makeRotationX(rad) : axis === 'y' ? new Matrix4().makeRotationY(rad) : new Matrix4().makeRotationZ(rad)
  // 90° 的倍數取整，避免反覆旋轉累積誤差
  if (Math.abs(deg % 90) < 1e-9) r.elements.forEach((v, i) => (r.elements[i] = Math.round(v)))
  return fromMatrix(new Matrix4().makeTranslation(...pivot).multiply(r).multiply(new Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2])))
}

/**
 * 根零件的位置與方向：center = 零件外框中心在模組中的位置（mm），rotation = 依 X→Y→Z 順序的轉角（度）。
 * localCenter 是零件自己座標中的外框中心（旋轉時以它為中心，零件不會飛走）。
 */
export function rootPose(placement: Mat4 | undefined, localCenter: Vec3): { center: Vec3; rotation: Vec3 } {
  const m = toMatrix(placement)
  const center = new Vector3(...localCenter).applyMatrix4(m).toArray() as Vec3
  const e = new Euler().setFromRotationMatrix(m, 'XYZ')
  // 角度取 (-180, 180]，小數 3 位
  const deg = (v: number) => {
    const d = Math.round(((v * 180) / Math.PI) * 1000) / 1000
    if (Math.abs(d) < 1e-6) return 0
    return d <= -180 ? d + 360 : d
  }
  return { center, rotation: [deg(e.x), deg(e.y), deg(e.z)] }
}

/** 由位置與方向（rootPose 的格式）算出根零件的矩陣 */
export function placementFromPose(pose: { center: Vec3; rotation: Vec3 }, localCenter: Vec3): Mat4 {
  const [x, y, z] = pose.rotation.map((d) => (d * Math.PI) / 180)
  const r = new Matrix4().makeRotationFromEuler(new Euler(x, y, z, 'XYZ'))
  r.elements.forEach((v, i) => {
    if (Math.abs(v - Math.round(v)) < 1e-12) r.elements[i] = Math.round(v)
  })
  return fromMatrix(
    new Matrix4()
      .makeTranslation(...pose.center)
      .multiply(r)
      .multiply(new Matrix4().makeTranslation(-localCenter[0], -localCenter[1], -localCenter[2])),
  )
}

/** 兩個埠鎖合後能否繞軸旋轉：任一端固定即固定；有等分限制時取步數較少者 */
export function mateRotation(a: ProductPort | undefined, b: ProductPort | undefined): 'free' | 'fixed' | { steps: number } {
  const rotations = [a?.rotation, b?.rotation]
  if (rotations.includes('fixed')) return 'fixed'
  const steps = rotations.flatMap((r) => (r && typeof r === 'object' ? [r.steps] : []))
  return steps.length ? { steps: Math.min(...steps) } : 'free'
}

export interface MateCheck {
  mate: Mate
  result: MateResult
}

/** 模組中每個鎖合的搭配檢查（產品規格修改後會自動重新檢查） */
export function mateChecks(doc: ModuleDoc, products: ProductMap): MateCheck[] {
  return doc.mates.map((mate) => ({
    mate,
    result: checkMate(getPort(doc, products, mate.parent)?.spec, getPort(doc, products, mate.child)?.spec),
  }))
}

export interface ReplaceResult {
  doc: ModuleDoc
  /** 保留下來的鎖合數 */
  kept: number
  /** 新產品上找不到對應埠而拆開的鎖合（原本的埠名稱） */
  dropped: string[]
}

/**
 * 更換零件的產品（例如 Ø6 接頭換成 Ø8）：原本的鎖合依序以
 * 「同名的埠」→「規格相同的埠」→「與對方規格相容的埠」對應到新產品；都找不到就拆開。
 */
export function replaceProduct(doc: ModuleDoc, products: ProductMap, instanceId: string, newProductId: string): ReplaceResult {
  const inst = doc.instances.find((i) => i.id === instanceId)
  const oldProduct = inst && products[inst.productId]
  const newProduct = products[newProductId]
  if (!inst || !oldProduct || !newProduct) return { doc, kept: 0, dropped: [] }

  const taken = new Set<string>()
  const mapPort = (oldPortId: string, partner: PortRef): string | undefined => {
    const old = oldProduct.ports.find((p) => p.id === oldPortId)
    if (!old) return undefined
    const free = newProduct.ports.filter((p) => !taken.has(p.id))
    const partnerSpec = getPort(doc, products, partner)?.spec
    const hit =
      free.find((p) => p.name === old.name) ??
      (old.spec ? free.find((p) => p.spec && specKey(p.spec) === specKey(old.spec!)) : undefined) ??
      free.find((p) => ['ok', 'warn'].includes(checkMate(partnerSpec, p.spec).level))
    if (hit) taken.add(hit.id)
    return hit?.id
  }

  // 先把鎖合都放到新產品上；對應不到的拆開（子零件群組保持目前位置）
  const { transforms } = computeTransforms(doc, products)
  const placements = { ...doc.placements }
  const mates: Mate[] = []
  const dropped: string[] = []
  for (const m of doc.mates) {
    const side = m.parent.instance === instanceId ? 'parent' : m.child.instance === instanceId ? 'child' : undefined
    if (!side) {
      mates.push(m)
      continue
    }
    const self = m[side]
    const partner = side === 'parent' ? m.child : m.parent
    const port = mapPort(self.port, partner)
    if (port) {
      mates.push({ ...m, [side]: { instance: instanceId, port } })
      continue
    }
    dropped.push(oldProduct.ports.find((p) => p.id === self.port)?.name ?? self.port)
    placements[m.child.instance] = transforms[m.child.instance]
  }
  // PU 管與供氣口：依名稱、規格對應到新產品的埠，找不到就拿掉
  const remapFree = (portId: string): string | undefined => {
    const old = oldProduct.ports.find((p) => p.id === portId)
    if (!old) return undefined
    const free = newProduct.ports.filter((p) => !taken.has(p.id))
    const hit = free.find((p) => p.name === old.name) ?? (old.spec ? free.find((p) => p.spec && specKey(p.spec) === specKey(old.spec!)) : undefined)
    if (hit) taken.add(hit.id)
    return hit?.id
  }
  const tubes = (doc.tubes ?? []).flatMap((t) => {
    const ends = [t.a, t.b].map((end) => (end.instance === instanceId ? { ...end, port: remapFree(end.port) } : end))
    if (ends.some((e) => !e.port)) {
      dropped.push(`PU 管 ${t.label ?? ''}`.trim())
      return []
    }
    return [{ ...t, a: ends[0] as PortRef, b: ends[1] as PortRef }]
  })
  let supply = doc.supply
  if (supply?.instance === instanceId) {
    const port = remapFree(supply.port)
    supply = port ? { ...supply, port } : undefined
  }
  return {
    doc: touch(doc, {
      instances: doc.instances.map((i) => (i.id === instanceId ? { ...i, productId: newProductId } : i)),
      mates,
      placements,
      ...(doc.tubes && { tubes }),
      supply,
    }),
    kept: mates.length - doc.mates.filter((m) => m.parent.instance !== instanceId && m.child.instance !== instanceId).length,
    dropped,
  }
}
