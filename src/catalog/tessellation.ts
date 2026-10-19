import type { Vec3 } from '../geometry/vec3'

/** 一個零件（STEP 內的一個實體）的三角網格 */
export interface MeshPart {
  name: string
  /** RGB 0~1；沒有指定顏色時為 null */
  color: Vec3 | null
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  /** 每個 B-rep 面對應的三角形範圍：[first0, last0, first1, last1, …]（含頭含尾） */
  faceRanges: Uint32Array
}

export interface Tessellation {
  parts: MeshPart[]
  bbox: { min: Vec3; max: Vec3 }
  triangleCount: number
  /**
   * STEP 檔頂層的零件（名稱與所屬的網格編號）。組立檔每個零件一組；一般的單一零件
   * 常常也有好幾個實體（本體、線圈…），所以有多組不代表一定是組立檔。舊資料沒有這個欄位。
   */
  groups?: { name: string; parts: number[] }[]
}

/** occt-import-js 的節點樹 */
export interface OcctNode {
  name?: string
  meshes?: number[]
  children?: OcctNode[]
}

/** occt-import-js 的輸出格式（只列出用得到的欄位） */
export interface OcctMesh {
  name?: string
  color?: number[]
  brep_faces?: { first: number; last: number }[]
  attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } }
  index: { array: ArrayLike<number> }
}

export interface OcctResult {
  success: boolean
  meshes: OcctMesh[]
  root?: OcctNode
}

/** 頂層零件：從根節點往下走過「只有一個子節點」的包裝層，再取各個子節點（含其下所有網格） */
export function topLevelGroups(root: OcctNode | undefined, meshCount: number): { name: string; parts: number[] }[] {
  if (!root) return [{ name: '', parts: Array.from({ length: meshCount }, (_, i) => i) }]
  let node = root
  while (!node.meshes?.length && node.children?.length === 1) node = node.children[0]
  const all = (n: OcctNode): number[] => [...(n.meshes ?? []), ...(n.children ?? []).flatMap(all)]
  const groups = (node.children ?? []).map((c) => ({ name: c.name ?? '', parts: all(c) })).filter((g) => g.parts.length)
  if (node.meshes?.length) groups.unshift({ name: node.name ?? '', parts: [...node.meshes] })
  return groups.length ? groups : [{ name: node.name ?? '', parts: all(node) }]
}

/** 把 occt-import-js 的結果轉成緊湊的 typed array 結構（可直接存進 IndexedDB、傳給 three.js） */
export function fromOcctResult(result: OcctResult): Tessellation {
  if (!result.success || result.meshes.length === 0) {
    throw new Error('無法讀取這個檔案：可能不是有效的 STEP／IGES，或檔案裡沒有實體')
  }
  const parts = result.meshes.map((m, i): MeshPart => {
    const positions = Float32Array.from(m.attributes.position.array)
    const indices = Uint32Array.from(m.index.array)
    const normals = m.attributes.normal ? Float32Array.from(m.attributes.normal.array) : computeNormals(positions, indices)
    const triangles = indices.length / 3
    const faces = m.brep_faces?.length ? m.brep_faces : [{ first: 0, last: triangles - 1 }]
    const faceRanges = new Uint32Array(faces.length * 2)
    faces.forEach((f, k) => {
      faceRanges[k * 2] = f.first
      faceRanges[k * 2 + 1] = f.last
    })
    const color = m.color && m.color.length >= 3 ? ([m.color[0], m.color[1], m.color[2]] as Vec3) : null
    return { name: m.name || `實體 ${i + 1}`, color, positions, normals, indices, faceRanges }
  })
  const groups = topLevelGroups(result.root, parts.length)
  return { parts, bbox: boundingBox(parts), triangleCount: parts.reduce((n, p) => n + p.indices.length / 3, 0), groups }
}

export function boundingBox(parts: readonly MeshPart[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) {
    for (let i = 0; i < p.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p.positions[i + k]
        if (v < min[k]) min[k] = v
        if (v > max[k]) max[k] = v
      }
    }
  }
  return { min, max }
}

/** 找出某個三角形屬於哪一個 B-rep 面（二分搜尋）；找不到回傳 -1 */
export function faceOfTriangle(part: MeshPart, triangle: number): number {
  let lo = 0
  let hi = part.faceRanges.length / 2 - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const first = part.faceRanges[mid * 2]
    const last = part.faceRanges[mid * 2 + 1]
    if (triangle < first) hi = mid - 1
    else if (triangle > last) lo = mid + 1
    else return mid
  }
  return -1
}

/** 沒有法向量時，以相鄰三角形面積加權計算頂點法向量 */
function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length)
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3]
    const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]]
    const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]]
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normals[v + k] += n[k]
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1
    for (let k = 0; k < 3; k++) normals[i + k] /= l
  }
  return normals
}

// ---------------- 二進位序列化（用於匯出檔） ----------------

const MAGIC = 0x31535450 // 'PTS1'（little-endian）

interface Header {
  parts: { name: string; color: Vec3 | null; positions: number; normals: number; indices: number; faceRanges: number }[]
  bbox: Tessellation['bbox']
  triangleCount: number
  groups?: Tessellation['groups']
}

/** 格式：'PTS1' + u32 表頭長度 + 表頭 JSON（補空白到 4 的倍數）+ 各零件的 positions／normals／indices／faceRanges */
export function serializeTessellation(t: Tessellation): Uint8Array {
  const header: Header = {
    parts: t.parts.map((p) => ({
      name: p.name,
      color: p.color,
      positions: p.positions.length,
      normals: p.normals.length,
      indices: p.indices.length,
      faceRanges: p.faceRanges.length,
    })),
    bbox: t.bbox,
    triangleCount: t.triangleCount,
    ...(t.groups && { groups: t.groups }),
  }
  let json = new TextEncoder().encode(JSON.stringify(header))
  const padded = new Uint8Array(Math.ceil(json.length / 4) * 4).fill(0x20)
  padded.set(json)
  json = padded
  const arrays = t.parts.flatMap((p) => [p.positions, p.normals, p.indices, p.faceRanges])
  const body = arrays.reduce((n, a) => n + a.byteLength, 0)
  const out = new Uint8Array(8 + json.length + body)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, json.length, true)
  out.set(json, 8)
  let offset = 8 + json.length
  for (const a of arrays) {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offset)
    offset += a.byteLength
  }
  return out
}

export function deserializeTessellation(bytes: Uint8Array): Tessellation {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 8 || view.getUint32(0, true) !== MAGIC) throw new Error('網格資料格式錯誤')
  const headerLength = view.getUint32(4, true)
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength))) as Header
  // 複製到新的對齊緩衝區，避免 byteOffset 不是 4 的倍數
  const body = bytes.slice(8 + headerLength)
  let offset = 0
  const take = <T extends Float32Array | Uint32Array>(Ctor: new (b: ArrayBuffer, o: number, l: number) => T, n: number) => {
    const arr = new Ctor(body.buffer, offset, n)
    offset += n * 4
    return arr
  }
  const parts = header.parts.map(
    (p): MeshPart => ({
      name: p.name,
      color: p.color,
      positions: take(Float32Array, p.positions),
      normals: take(Float32Array, p.normals),
      indices: take(Uint32Array, p.indices),
      faceRanges: take(Uint32Array, p.faceRanges),
    }),
  )
  return { parts, bbox: header.bbox, triangleCount: header.triangleCount, ...(header.groups && { groups: header.groups }) }
}
