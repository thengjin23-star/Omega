/**
 * 自動找埠：匯入 3D 檔後，從模型上的孔與凸柱找出埠的位置、方向與規格，並自動命名。
 *
 * 1. 分析每個 B-rep 面，留下圓柱面；STEP 常把一個孔拆成兩個半圓柱面，同軸、同徑、範圍相接的合併。
 * 2. 用射線判斷兩端是否開放：孔只有一端開放（孔口）才是埠；兩端開放是貫穿孔（固定螺絲孔），不算。
 *    凸柱的尖端開放、根部有肩面（六角或本體）才是公牙。
 * 3. 同一條軸線上的孔，取最外側、夠深的那一個（略過沉頭、釋放套筒；內部的通道不算）。
 * 4. 直徑 → 規格（suggestByDiameter），依分類過濾（閥體沒有快插口、消音器沒有母牙…）；
 *    有型號規則（makerCodes）時以型號的規格為準。
 * 5. 依分類與位置命名：閥 P／A／B／EA／EB、氣缸 A／B、三點組合 IN／OUT、集裝座 A1…／B1…、接頭 1／2。
 */
import { add, cross, distance, dot, length, normalize, perpendicular, scale, sub, type Vec3 } from '../geometry/vec3'
import { formatSpecShort, parseSpec, suggestByDiameter, type PortSpec, type Suggestion, type ThreadSpec } from '../threads'
import { seriesFromCode, seriesInterfaceKey, seriesOf, type ThreadSize } from './generic/genericParts'
import { analyzeFace } from './faceAnalysis'
import type { CodeInfo, ExpectedPort } from './makerCodes'
import type { Raycaster } from './openTester'
import { makePort } from './ports'
import type { Tessellation } from './tessellation'
import type { ProductCategory, ProductPort } from './types'

interface Cylinder {
  shape: 'hole' | 'boss'
  axis: Vec3
  center: Vec3
  radius: number
  tMin: number
  tMax: number
}

/** 找到的孔或凸柱（可能是埠） */
export interface PortCandidate {
  shape: 'hole' | 'boss'
  diameter: number
  /** 孔深或凸柱長 */
  depth: number
  /** 孔口中心（孔）或根部中心（凸柱） */
  origin: Vec3
  /** 朝外：孔朝孔外、凸柱朝尖端 */
  axis: Vec3
  /** 孔底接著更小的通道（氣路），是埠的有力證據 */
  passage: boolean
  /** 凸柱根部有肩面 */
  shoulder: boolean
  /** 貫穿孔的一端（接管座、管路型元件才有；固定螺絲孔多半也是貫穿） */
  through?: boolean
  suggestions: Suggestion[]
}

export interface DetectedPort {
  candidate: PortCandidate
  spec?: PortSpec
  name: string
  /** sure = 自動加入；maybe = 可能是埠（例如固定螺絲孔），列出來讓使用者勾選 */
  confidence: 'sure' | 'maybe'
}

export interface AutoPortsResult {
  ports: DetectedPort[]
  category: ProductCategory
  /** 依找到的埠產生的名稱（產品沒有名稱時使用） */
  name: string
}

// ---------------------------------------------------------------- 圓柱面

/** 方向統一正負號：第一個明顯不為 0 的分量（|x| > 0.3）為正；不受 1e-5 這類誤差影響 */
const needsFlip = (a: Vec3) => (a.find((x) => Math.abs(x) > 0.3) ?? 0) < 0
const canonicalDir = (v: Vec3): Vec3 => (needsFlip(v) ? scale(v, -1) : v)

/** 軸向統一正負號（t 範圍跟著反轉） */
function canonical(c: Cylinder): Cylinder {
  return needsFlip(c.axis) ? { ...c, axis: scale(c.axis, -1), tMin: -c.tMax, tMax: -c.tMin } : c
}

/** 去掉沿 axis 的分量（不正規化） */
const reject = (v: Vec3, axis: Vec3): Vec3 => sub(v, scale(axis, dot(v, axis)))

const sameLine = (a: { axis: Vec3; center: Vec3 }, b: { axis: Vec3; center: Vec3 }, tol = 0.08) =>
  Math.abs(dot(a.axis, b.axis)) > 0.9995 && length(reject(sub(a.center, b.center), a.axis)) < tol

/** 模型中所有的圓柱面（合併拆開的半圓柱） */
export function collectCylinders(tess: Tessellation): Cylinder[] {
  const raw: Cylinder[] = []
  for (const part of tess.parts) {
    const faces = part.faceRanges.length / 2
    for (let f = 0; f < faces; f++) {
      const a = analyzeFace(part, f)
      if (a.kind !== 'cylinder' || a.radius < 0.9 || a.radius > 40) continue
      raw.push(canonical({ shape: a.shape, axis: a.axis, center: a.center, radius: a.radius, tMin: a.tMin, tMax: a.tMax }))
    }
  }
  // 依軸向位置排序後合併：被切成好幾段的孔能一路接起來
  raw.sort((a, b) => a.tMin - b.tMin)
  const merged: Cylinder[] = []
  for (const c of raw) {
    const m = merged.find(
      (x) =>
        x.shape === c.shape &&
        Math.abs(x.radius - c.radius) < Math.max(0.03, x.radius * 0.004) &&
        dot(x.axis, c.axis) > 0.9995 &&
        sameLine(x, c) &&
        c.tMin <= x.tMax + 0.05 &&
        x.tMin <= c.tMax + 0.05,
    )
    if (m) {
      m.tMin = Math.min(m.tMin, c.tMin)
      m.tMax = Math.max(m.tMax, c.tMax)
    } else merged.push({ ...c })
  }
  return merged
}

function basis(axis: Vec3): [Vec3, Vec3] {
  const u = perpendicular(Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], axis)
  return [u, cross(axis, u)]
}

/**
 * 端面是否開放：在 0.85r 處、端面稍外側沿軸向往外發 4 條射線。
 * 起點在實體內部（射線往外穿出）＝封閉；起點在空氣中、附近沒有擋住＝開放
 * （遠處的東西，例如另一側的電磁線圈，不影響接管）。
 */
function endOpen(c: Cylinder, end: 0 | 1, raycast: Raycaster): boolean {
  const out = end === 0 ? scale(c.axis, -1) : c.axis
  const point = add(c.center, scale(c.axis, end === 0 ? c.tMin : c.tMax))
  const [u, w] = basis(c.axis)
  const reach = Math.max(3, c.radius)
  let free = 0
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2
    const offset = add(scale(u, Math.cos(a) * c.radius * 0.85), scale(w, Math.sin(a) * c.radius * 0.85))
    const hit = raycast(add(add(point, scale(out, 0.05)), offset), out)
    if (!hit || (!hit.exiting && hit.distance > reach)) free++
  }
  return free >= 3
}

/** 凸柱根部的肩面：在 1.25r 處、稍微離開根部的地方往根部打射線，很快就碰到 */
function hasShoulder(origin: Vec3, axis: Vec3, radius: number, raycast: Raycaster): boolean {
  const [u, w] = basis(axis)
  let hits = 0
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4
    const radial = add(scale(u, Math.cos(a) * radius * 1.25), scale(w, Math.sin(a) * radius * 1.25))
    const hit = raycast(add(add(origin, scale(axis, 0.3)), radial), scale(axis, -1))
    if (hit && !hit.exiting && hit.distance < 0.7) hits++
  }
  return hits >= 2
}

// ---------------------------------------------------------------- 規格

/** 氣動埠常見的規格（排除 M3、M4、M8 以上的公制，那些多半是固定螺絲） */
function portLikeSpec(spec: PortSpec): boolean {
  if (spec.kind === 'tube') return spec.od >= 3 && (spec.role === 'socket' || spec.system === 'metric')
  if (spec.kind !== 'thread') return false
  if (spec.standard === 'M') return spec.size === '5' || spec.size === '6'
  if (spec.standard === 'UNF' || spec.standard === 'UNC') return spec.size === '10-32'
  return true
}

const PREFERENCE: Record<CodeInfo['thread'], ThreadSpec['standard'][]> = {
  PT: ['R', 'Rc', 'G', 'Rp', 'NPT', 'M', 'UNF'],
  G: ['G', 'R', 'Rc', 'Rp', 'NPT', 'M', 'UNF'],
  NPT: ['NPT', 'R', 'Rc', 'G', 'Rp', 'M', 'UNF'],
}

/** 依偏好的螺紋標準挑規格（PT 與 G 的孔徑一樣，量不出差別） */
function pickThread(suggestions: readonly Suggestion[], thread: CodeInfo['thread']): Suggestion | undefined {
  const threads = suggestions.filter((s) => s.spec.kind === 'thread')
  for (const standard of PREFERENCE[thread]) {
    const s = threads.find((x) => x.spec.kind === 'thread' && x.spec.standard === standard)
    if (s) return s
  }
  return threads[0]
}

// ---------------------------------------------------------------- 候選

/** 找出模型上可能是埠的孔與凸柱 */
/**
 * 找埠的候選（孔、凸柱）。out.fixing：太小、不會是氣路埠的孔（Ø1.5～3.9，多半是固定螺絲孔、定位孔），
 * 不當成埠，只在畫面上標出來幫忙判斷安裝方向。
 */
export function portCandidates(tess: Tessellation, raycast: Raycaster, out?: { fixing: PortCandidate[] }): PortCandidate[] {
  const cylinders = collectCylinders(tess)
  const holes: (PortCandidate & { line: Cylinder; mouthT: number })[] = []
  const bosses: PortCandidate[] = []
  // 小的貫穿孔：不是埠，多半是固定螺絲孔（畫面上標出）
  const smallThrough: PortCandidate[] = []
  const openings = cylinders.map((c): [boolean, boolean] => [endOpen(c, 0, raycast), endOpen(c, 1, raycast)])
  // 凸柱尖端（公牙）的位置：從那裡進去的孔是公牙的通氣孔
  const tips = cylinders.flatMap((c, i) => {
    const [o0, o1] = openings[i]
    if (c.shape !== 'boss' || o0 === o1) return []
    return [{ c, point: add(c.center, scale(c.axis, o0 ? c.tMin : c.tMax)) }]
  })
  const atTip = (c: Cylinder, end: 0 | 1) => {
    const point = add(c.center, scale(c.axis, end === 0 ? c.tMin : c.tMax))
    return tips.some((t) => sameLine(t.c, c) && distance(t.point, point) < 0.5)
  }
  cylinders.forEach((c, i) => {
    const open = [...openings[i]] as [boolean, boolean]
    if (!open[0] && !open[1]) return // 內部的空腔
    // 貫穿孔的一端在公牙尖端（接頭的通氣孔與快插口同徑時會連成一個孔）：另一端才是埠
    if (open[0] && open[1] && c.shape === 'hole' && (atTip(c, 0) || atTip(c, 1))) open[atTip(c, 0) ? 0 : 1] = false
    if (open[0] && open[1]) {
      // 貫穿孔：大孔（1/8 以上）兩端都可能是埠（接管座、管路型元件），小孔多半是固定螺絲孔
      if (c.shape === 'hole' && c.radius * 2 >= 1.5 && c.radius * 2 < 7.5) {
        for (const end of [0, 1] as const)
          smallThrough.push({
            shape: 'hole',
            diameter: c.radius * 2,
            depth: c.tMax - c.tMin,
            origin: add(c.center, scale(c.axis, end === 0 ? c.tMin : c.tMax)),
            axis: end === 0 ? scale(c.axis, -1) : c.axis,
            passage: false,
            shoulder: false,
            through: true,
            suggestions: [],
          })
      }
      if (c.shape !== 'hole' || c.radius * 2 < 7.5) return
      for (const end of [0, 1] as const) {
        const out = end === 0 ? scale(c.axis, -1) : c.axis
        const mouth = add(c.center, scale(c.axis, end === 0 ? c.tMin : c.tMax))
        holes.push({
          shape: 'hole',
          diameter: c.radius * 2,
          depth: c.tMax - c.tMin,
          origin: mouth,
          axis: out,
          passage: false,
          shoulder: false,
          through: true,
          suggestions: suggestByDiameter(c.radius * 2, 'hole', 20).filter((s) => portLikeSpec(s.spec)),
          line: c,
          mouthT: dot(mouth, out),
        })
      }
      return
    }
    const outEnd = open[0] ? 0 : 1
    const out = outEnd === 0 ? scale(c.axis, -1) : c.axis
    const tip = add(c.center, scale(c.axis, outEnd === 0 ? c.tMin : c.tMax))
    const base = add(c.center, scale(c.axis, outEnd === 0 ? c.tMax : c.tMin))
    const diameter = c.radius * 2
    const depth = c.tMax - c.tMin
    if (c.shape === 'hole') {
      holes.push({
        shape: 'hole',
        diameter,
        depth,
        origin: tip,
        axis: out,
        passage: false,
        shoulder: false,
        suggestions: suggestByDiameter(diameter, 'hole', 20).filter((s) => portLikeSpec(s.spec)),
        line: c,
        mouthT: dot(tip, out),
      })
    } else {
      bosses.push({
        shape: 'boss',
        diameter,
        depth,
        origin: base,
        axis: out,
        passage: false,
        shoulder: hasShoulder(base, out, c.radius, raycast),
        suggestions: suggestByDiameter(diameter, 'boss', 20).filter((s) => portLikeSpec(s.spec) && s.spec.kind === 'thread'),
      })
    }
  })

  // 同一條軸線、同方向的孔：取最外側、夠深的孔（沉頭、套筒太淺；內部的通道在更裡面）
  const deepEnough = (h: PortCandidate) => h.depth >= 0.6 * h.diameter && h.diameter >= 3.9
  if (out) {
    const small = (h: PortCandidate) => h.diameter >= 1.5 && h.diameter < 3.9 && (h.depth >= 0.6 * h.diameter || h.through)
    out.fixing = [
      ...smallThrough,
      ...holes
        .filter((h) => small(h) && !holes.some((o) => o !== h && small(o) && dot(o.axis, h.axis) > 0.999 && sameLine(o.line, h.line) && o.mouthT > h.mouthT + 0.05))
        .map(({ line: _line, mouthT: _t, ...h }) => h),
    ]
  }
  const kept = holes.filter((h) => {
    if (!deepEnough(h)) return false
    return !holes.some((o) => o !== h && deepEnough(o) && dot(o.axis, h.axis) > 0.999 && sameLine(o.line, h.line) && o.mouthT > h.mouthT + 0.05)
  })
  for (const h of kept) {
    const bottom = h.mouthT - h.depth
    // 孔底接著更小的同軸孔（任何開放狀態）
    h.passage = cylinders.some((c) => {
      if (c.shape !== 'hole' || c.radius >= h.diameter / 2 - 0.2 || !sameLine(c, h.line)) return false
      const ts = [c.tMin, c.tMax].map((t) => t * dot(c.axis, h.axis))
      return Math.min(...ts) < bottom - 0.3 && Math.max(...ts) > bottom - 0.3
    })
  }
  // 公牙裡面的通孔（孔口在凸柱尖端、同軸）不算
  const result = kept.filter(
    (h) =>
      !bosses.some(
        (b) =>
          b.shoulder &&
          h.diameter < b.diameter * 0.8 &&
          sameLine({ axis: b.axis, center: projectLine(b) }, { axis: h.axis, center: projectLine(h) }) &&
          distance(add(b.origin, scale(b.axis, b.depth)), h.origin) < 1,
      ),
  )
  return [...result.map(({ line: _line, mouthT: _t, ...h }) => h), ...bosses]
}

/** 埠的軸線上、與原點同一平面（垂直於軸）的點：用來比較是否同軸 */
function projectLine(c: { origin: Vec3; axis: Vec3 }): Vec3 {
  const a = normalize(c.axis)
  return sub(c.origin, scale(a, dot(c.origin, a)))
}

// ---------------------------------------------------------------- 判斷與命名

interface Options {
  /** 型號規則（認得型號時） */
  code?: CodeInfo
  /** 使用者已選的分類 */
  category?: ProductCategory
  /** 檔名或型號（猜分類用） */
  text?: string
}

const NO_TUBES: readonly ProductCategory[] = ['valve', 'manifold', 'cylinder', 'frl', 'silencer']
const NO_BOSSES: readonly ProductCategory[] = ['valve', 'manifold', 'cylinder', 'frl']

/** 依找到的孔與凸柱自動判斷埠 */
export function detectPorts(candidates: readonly PortCandidate[], tess: Tessellation, options: Options = {}): AutoPortsResult {
  const thread = options.code?.thread ?? 'PT'
  const hinted = options.code?.category ?? options.category ?? categoryFromText(options.text ?? '')

  // 有活塞桿（細長的凸柱）就是氣缸
  const rod = longestBoss(tess, candidates)
  const early = hinted ?? (rod ? 'cylinder' : undefined)

  // 1. 每個候選的規格
  const typed = candidates.flatMap((c) => {
    const tube = c.suggestions.find((s) => s.spec.kind === 'tube' && s.delta <= 0.3)
    const threadSpec = pickThread(c.suggestions, thread)
    // 快插口：直徑接近管外徑，而且夠深（插管深度約 2 倍管徑；母牙、M5 孔通常不到 1.5 倍）
    const asTube = c.shape === 'hole' && !c.through && tube && c.depth >= 1.7 * c.diameter && !(early && NO_TUBES.includes(early))
    const pick = asTube ? tube : threadSpec
    if (!pick) return []
    return [{ c, spec: pick.spec, kind: asTube ? ('tube' as const) : ('thread' as const) }]
  })

  // 2. 分類
  const category = early ?? guessCategory(typed, rod)
  const allowed = typed.filter((t) => {
    if (t.c.shape === 'boss') {
      if (NO_BOSSES.includes(category)) return false
      const ratio = t.c.depth / t.c.diameter
      return t.c.shoulder && ratio >= 0.45 && ratio <= 2.2
    }
    if (category === 'silencer') return false
    return true
  })

  // 3. 可信度：大埠旁邊的 M5／M6 小孔多半是固定螺絲（接頭類除外）
  const bigThread = allowed.some((t) => t.c.shape === 'hole' && t.kind === 'thread' && t.c.diameter >= 7.5)
  const small = (t: (typeof allowed)[number]) => t.kind === 'thread' && t.c.diameter < 6.5
  // 閥至少要 2 個埠、集裝座至少 3 個：太少的多半是固定孔或安裝面上的定位孔
  const minimum = category === 'valve' ? 2 : category === 'manifold' ? 3 : 1
  const enough = allowed.filter((t) => !t.c.through).length >= minimum
  const confidenceOf = (t: (typeof allowed)[number]): DetectedPort['confidence'] =>
    t.c.through || !enough || (bigThread && small(t) && t.c.shape === 'hole' && !['fitting', 'speedController'].includes(category) && !t.c.passage) ? 'maybe' : 'sure'

  // 4. 型號有預期的規格：以型號為準（尺寸相近時）
  let ports: DetectedPort[] = allowed.map((t) => ({ candidate: t.c, spec: t.spec, name: '', confidence: confidenceOf(t) }))
  if (options.code?.ports.length) ports = applyExpected(ports, options.code.ports)

  // 5. 命名
  nameByLayout(ports, category, rod)
  return { ports, category, name: options.code?.name ?? describe(category, ports) }
}

/** 匯入時一次做完：找候選、判斷、轉成產品的埠（只加入可信的；回傳「可能」的讓使用者決定） */
export function autoPorts(
  tess: Tessellation,
  raycast: Raycaster,
  options: Options & { existing?: readonly ProductPort[] } = {},
): { ports: ProductPort[]; maybe: DetectedPort[]; fixing: PortCandidate[]; category: ProductCategory; name: string } {
  const out = { fixing: [] as PortCandidate[] }
  const result = detectPorts(portCandidates(tess, raycast, out), tess, options)
  // 已有的埠（使用者定義過）附近不重複加入
  const fresh = result.ports.filter((p) => !(options.existing ?? []).some((e) => distance(e.frame.origin, p.candidate.origin) < 1))
  let ports = fresh.filter((p) => p.confidence === 'sure').map(toProductPort)
  // 電磁閥：底面加上裝集裝座的安裝面，底面的 P／排氣口由它封住。
  // 型號認得系列（例如 4V210-08）就用它；否則 A／B 與 P 在相反兩面時，依接管口推測系列（標示為推測）
  if (result.category === 'valve' && !(options.existing ?? []).some((p) => p.spec?.kind === 'interface')) {
    const series = seriesFromCode(options.code?.series)
    if (series) ports = withValveMount(ports, series, `依型號 ${options.code!.series} 判斷為 ${series} 系列`)
    else {
      const p = ports.find((x) => x.name === 'P')
      const work = ports.filter((x) => x.name === 'A' || x.name === 'B')
      if (p?.spec?.kind === 'thread' && work.length && work.every((w) => dot(w.frame.axis, p.frame.axis) < -0.99)) {
        const size = (p.spec.standard === 'M' ? `M${p.spec.size}` : p.spec.size) as ThreadSize
        const guess = seriesOf(size)
        ports = withValveMount(
          ports,
          guess,
          `型號沒有系列資料：依接管口 ${formatSpecShort(p.spec)} 推測為 ${guess} 系列，請確認（與集裝座的系列相同才裝得上，可按「編輯」改）`,
        )
      }
    }
  }
  return {
    ports,
    maybe: fresh.filter((p) => p.confidence === 'maybe'),
    fixing: out.fixing,
    category: result.category,
    name: result.name,
  }
}

/** 閥底面的 P、EA、EB（或 P、R）在同一面：加上安裝面（與通用集裝座的站位相同：原點偏離底面中央 W/2-3） */
function withValveMount(ports: ProductPort[], series: 100 | 200 | 300 | 400, basis: string): ProductPort[] {
  const p = ports.find((x) => x.name === 'P')
  const exhausts = ports.filter((x) => ['EA', 'EB', 'R'].includes(x.name) && dot(x.frame.axis, p?.frame.axis ?? [0, 0, 0]) > 0.99)
  if (!p || !exhausts.length) return ports
  const axis = p.frame.axis
  // 閥的長邊：EA → EB（3 口閥：P → R）
  const from = exhausts.find((x) => x.name === 'EA')?.frame.origin ?? p.frame.origin
  const to = exhausts.find((x) => x.name !== 'EA')?.frame.origin ?? p.frame.origin
  const along = normalize(sub(to, from))
  if (length(along) < 0.5) return ports
  const up = scale(axis, -1)
  const side = cross(up, along)
  const offset = { 100: 6, 200: 8, 300: 11, 400: 15 }[series]
  const spec = parseSpec(`安裝面：${seriesInterfaceKey(series)}`, { interfaceRole: 'plug' })
  if (!spec.ok) return ports
  // 以底面兩端的口（EA～EB，3 口閥 P～R）的中點為基準：5 口閥就是 P 口
  const middle = scale(add(from, to), 0.5)
  const mount = makePort({ name: '安裝面', spec: spec.spec, origin: add(middle, scale(side, -offset)), axis, ref: along, detected: { shape: 'plane', auto: true, basis } })
  const sealed = new Set([p, ...exhausts])
  return [...ports.map((x) => (sealed.has(x) ? { ...x, sealedBy: mount.id } : x)), mount]
}

export function toProductPort(p: DetectedPort): ProductPort {
  const d = Math.round(p.candidate.diameter * 100) / 100
  const what = p.candidate.shape === 'hole' ? '孔' : '凸柱'
  const basis = `${what} Ø${d}${p.spec ? ` → ${formatSpecShort(p.spec)}` : ''}（依直徑；牙型以型號為準）；名稱「${p.name}」依位置推測`
  return makePort({
    name: p.name,
    spec: p.spec,
    origin: p.candidate.origin,
    axis: p.candidate.axis,
    detected: { shape: p.candidate.shape, diameter: d, auto: true, basis },
  })
}

/** 最長的凸柱（氣缸的活塞桿）：決定氣缸 A／B 的方向 */
function longestBoss(tess: Tessellation, candidates: readonly PortCandidate[]): PortCandidate | undefined {
  const size = sub(tess.bbox.max, tess.bbox.min)
  const longest = Math.max(...size)
  const rods = candidates.filter((c) => c.shape === 'boss' && c.depth > 2.5 * c.diameter && c.depth > longest * 0.12)
  return rods.sort((a, b) => b.depth - a.depth)[0]
}

function categoryFromText(text: string): ProductCategory | undefined {
  const t = text.toUpperCase()
  if (/消音|SILENCER|MUFFLER/.test(t)) return 'silencer'
  if (/集裝|MANIFOLD/.test(t)) return 'manifold'
  if (/速度控制|速控|SPEED/.test(t)) return 'speedController'
  if (/氣缸|CYLINDER/.test(t)) return 'cylinder'
  if (/電磁閥|VALVE|閥/.test(t)) return 'valve'
  if (/接頭|FITTING|CONNECTOR/.test(t)) return 'fitting'
  if (/調壓|過濾|給油|REGULATOR|FILTER|LUBRICATOR|FRL/.test(t)) return 'frl'
  return undefined
}

function guessCategory(typed: readonly { c: PortCandidate; kind: 'tube' | 'thread' }[], rod: PortCandidate | undefined): ProductCategory {
  const male = typed.filter((t) => t.c.shape === 'boss' && t.c.shoulder && t.c.depth / t.c.diameter <= 2.2 && t.c !== rod).length
  const tubes = typed.filter((t) => t.kind === 'tube').length
  const female = typed.filter((t) => t.c.shape === 'hole' && t.kind === 'thread').length
  if (rod && female >= 1 && female <= 4) return 'cylinder'
  if (male === 1 && female === 0 && tubes === 0) return 'silencer'
  if (male <= 1 && tubes >= 1 && female === 0) return 'fitting'
  if (male === 1 && female === 1 && tubes === 0) return 'fitting'
  if (male === 0 && tubes === 0 && female === 5) return 'valve'
  if (male === 0 && tubes === 0 && female >= 7) return 'manifold'
  return 'other'
}

/** 型號的預期規格：尺寸相近（同一個管螺紋尺寸、或 1.5 mm 內的管徑）就採用型號的規格 */
function applyExpected(ports: DetectedPort[], expected: readonly ExpectedPort[]): DetectedPort[] {
  const specs = expected.flatMap((e) => {
    const shape = /快插/.test(e.spec) ? 'hole' : /^(R|NPT.*公|G.*公|M\d)/.test(e.spec) && !/^RC/i.test(e.spec) ? 'boss' : 'hole'
    const r = parseSpec(e.spec, { gender: shape === 'boss' ? 'male' : 'female' })
    return r.ok ? [{ e, spec: r.spec }] : []
  })
  const used = new Set<(typeof specs)[number]>()
  for (const p of ports) {
    const match = specs.find((s) => !used.has(s) && closeEnough(p, s.spec))
    if (!match) continue
    used.add(match)
    p.spec = match.spec
    p.confidence = 'sure'
  }
  return ports
}

function closeEnough(p: DetectedPort, spec: PortSpec): boolean {
  const male = p.candidate.shape === 'boss'
  if (spec.kind === 'tube') return !male && Math.abs(p.candidate.diameter - spec.od) <= 1.5
  if (spec.kind !== 'thread' || (spec.gender === 'male') !== male) return false
  if (spec.standard === 'M' && spec.size === '5' && male) return Math.abs(p.candidate.diameter - 5) < 0.6
  // 尺寸相同就算（不分 PT／G）：看建議清單裡有沒有同樣尺寸的管螺紋或公制
  return p.candidate.suggestions.some((s) => s.spec.kind === 'thread' && s.spec.size === spec.size && (s.spec.standard === 'M') === (spec.standard === 'M'))
}

// ---------------------------------------------------------------- 命名

const dirKey = (v: Vec3) => v.map((x) => Math.round(x * 4) / 4).join(',')

/** 埠依朝向分組（同一個面） */
function groupByFace(ports: DetectedPort[]): DetectedPort[][] {
  const groups = new Map<string, DetectedPort[]>()
  for (const p of ports) {
    const k = dirKey(p.candidate.axis)
    groups.set(k, [...(groups.get(k) ?? []), p])
  }
  return [...groups.values()]
}

/** 一組點的主要排列方向（最遠兩點的連線） */
function spreadAxis(ports: readonly DetectedPort[]): Vec3 {
  let best: Vec3 = [1, 0, 0]
  let d = -1
  for (const a of ports)
    for (const b of ports) {
      const l = distance(a.candidate.origin, b.candidate.origin)
      if (l > d) {
        d = l
        best = sub(b.candidate.origin, a.candidate.origin)
      }
    }
  return d > 0 ? canonicalDir(normalize(best)) : best
}

const along = (p: DetectedPort, axis: Vec3) => dot(p.candidate.origin, axis)
const sortAlong = (ports: DetectedPort[], axis: Vec3) => [...ports].sort((a, b) => along(a, axis) - along(b, axis))
const bySize = (ports: DetectedPort[]) => [...ports].sort((a, b) => b.candidate.diameter - a.candidate.diameter)

function nameByLayout(ports: DetectedPort[], category: ProductCategory, rod: PortCandidate | undefined): void {
  const sure = ports.filter((p) => p.confidence === 'sure')
  const named = new Set<DetectedPort>()
  const set = (p: DetectedPort | undefined, name: string) => {
    if (!p) return
    p.name = name
    named.add(p)
  }

  if (category === 'fitting' || category === 'speedController' || category === 'silencer') {
    const male = sure.filter((p) => p.candidate.shape === 'boss')
    const female = sure.filter((p) => p.candidate.shape === 'hole')
    let n = 0
    for (const p of [...male, ...female]) set(p, String(++n))
  } else if (category === 'cylinder' && sure.length >= 2) {
    const main = bySize(sure).slice(0, 2)
    const dir = rod?.axis ?? spreadAxis(main)
    const [a, b] = sortAlong(main, dir)
    set(a, 'A')
    set(b, 'B')
  } else if (category === 'valve') nameValve(sure, set)
  else if (category === 'manifold') nameManifold(sure, set)
  else if (category === 'frl') nameFrl(sure, set)

  let k = 0
  for (const p of ports) if (!named.has(p)) p.name = `埠${++k}`
}

type Setter = (p: DetectedPort | undefined, name: string) => void

/** 5 口閥：同一面 3 個（中間 P、兩側 EA／EB）＋另一面 2 個（A／B）；3 口閥：P、A、R */
function nameValve(ports: DetectedPort[], set: Setter): void {
  if (ports.length === 5) {
    const faces = groupByFace(ports)
    const three = faces.find((g) => g.length === 3)
    const two = faces.find((g) => g.length === 2)
    if (three && two) {
      const axis = spreadAxis(three)
      const [e1, p, e2] = sortAlong(three, axis)
      const [a, b] = sortAlong(two, axis)
      set(p, 'P')
      set(a, 'A')
      set(b, 'B')
      // EA 在 A 這一側、EB 在 B 這一側
      set(e1, 'EA')
      set(e2, 'EB')
      return
    }
    // 全部在同一面一排：EA A P B EB
    if (faces.length === 1) {
      const [ea, a, p, b, eb] = sortAlong(ports, spreadAxis(ports))
      set(ea, 'EA')
      set(a, 'A')
      set(p, 'P')
      set(b, 'B')
      set(eb, 'EB')
      return
    }
  }
  if (ports.length === 3) {
    // 3 口閥（仿 3V）：A 單獨在一面，P、R 在相對的另一面（一樣大時依位置，名稱為推測）
    const faces = groupByFace(ports)
    const lone = faces.find((g) => g.length === 1)
    const pair = faces.find((g) => g.length === 2)
    if (lone && pair) {
      set(lone[0], 'A')
      const [first, second] = pair[0].candidate.diameter - pair[1].candidate.diameter > 0.5 ? pair : sortAlong(pair, spreadAxis(pair))
      set(first, 'P')
      set(second, 'R')
      return
    }
    const [x, y, z] = bySize(ports)
    // 最小的是排氣（一樣大時無法分辨，依位置）
    const sorted = x.candidate.diameter - z.candidate.diameter > 0.5 ? [x, y, z] : sortAlong(ports, spreadAxis(ports))
    set(sorted[0], 'P')
    set(sorted[1], 'A')
    set(sorted[2], 'R')
    return
  }
  if (ports.length === 2) {
    const [a, b] = sortAlong(ports, spreadAxis(ports))
    set(a, 'P')
    set(b, 'A')
  }
}

/** 集裝座：兩側各一排同樣大小的孔為 A1…／B1…，兩端最大的是 P，其餘為 EA／EB */
function nameManifold(ports: DetectedPort[], set: Setter): void {
  const faces = groupByFace(ports).sort((a, b) => b.length - a.length)
  const [rowA, rowB] = faces
  if (!rowA || !rowB || rowA.length !== rowB.length || rowA.length < 2) {
    // A／B 在閥上的集裝座（例如亞德客 200M）：端面只有 P 與排氣口
    const end = faces[0]
    if (!end || end.length < 2) return
    const sized = bySize(end)
    const sameSize = sized[0].candidate.diameter - sized[sized.length - 1].candidate.diameter < 0.5
    const row = sortAlong(end, spreadAxis(end))
    const p = sameSize && row.length === 3 ? row[1] : sized[0]
    set(p, 'P')
    row.filter((x) => x !== p).forEach((e, i) => set(e, i === 0 ? 'EA' : i === 1 ? 'EB' : `R${i - 1}`))
    return
  }
  const axis = spreadAxis(rowA)
  sortAlong(rowA, axis).forEach((p, i) => set(p, `A${i + 1}`))
  sortAlong(rowB, axis).forEach((p, i) => set(p, `B${i + 1}`))
  const rest = faces.slice(2).flat()
  const [p, ...exhausts] = bySize(rest)
  if (!p) return
  set(p, 'P')
  sortAlong(exhausts, spreadAxis(exhausts.length > 1 ? exhausts : rest)).forEach((e, i) => set(e, i === 0 ? 'EA' : i === 1 ? 'EB' : `R${i - 1}`))
}

/** 三點組合：對向兩個最大的孔是 IN／OUT（座標小的一側為 IN），垂直方向的小孔是壓力錶 */
function nameFrl(ports: DetectedPort[], set: Setter): void {
  const [x, y, ...rest] = bySize(ports)
  if (!x || !y) return
  if (dot(x.candidate.axis, y.candidate.axis) < -0.99) {
    const axis = canonicalDir(x.candidate.axis)
    const [inPort, outPort] = sortAlong([x, y], axis)
    set(inPort, 'IN')
    set(outPort, 'OUT')
    const gauge = rest.find((p) => Math.abs(dot(p.candidate.axis, axis)) < 0.1)
    set(gauge, '壓力錶')
  }
}

/** 沒有名稱時依分類與規格產生，例如「快插接頭 R1/8 × Ø6」「5 口閥 Rc1/4」 */
function describe(category: ProductCategory, ports: readonly DetectedPort[]): string {
  const specs = (shape?: 'hole' | 'boss') =>
    [...new Set(ports.filter((p) => p.confidence === 'sure' && p.spec && (!shape || p.candidate.shape === shape)).map((p) => formatSpecShort(p.spec!)))]
  const main = specs()
  switch (category) {
    case 'fitting':
      return `接頭 ${[...specs('boss'), ...specs('hole')].join(' × ')}`.trim()
    case 'speedController':
      return `速度控制閥 ${main.join(' × ')}`.trim()
    case 'silencer':
      return `消音器 ${main[0] ?? ''}`.trim()
    case 'valve':
      return `${ports.filter((p) => p.confidence === 'sure').length} 口閥 ${main[0] ?? ''}`.trim()
    case 'cylinder':
      return `氣缸 ${main[0] ?? ''}`.trim()
    case 'manifold':
      return `集裝座 ${main.join('／')}`.trim()
    case 'frl':
      return `三點組合 ${main[0] ?? ''}`.trim()
    default:
      return ''
  }
}
