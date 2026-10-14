/**
 * 用 AI（Gemini）把敘述或不認得的型號轉成零件清單：
 * - 產品庫有合適的產品就用（有原廠 3D 檔）；
 * - 沒有的依種類與尺寸產生通用 3D（generic/）。
 * AI 只負責「判斷是什麼零件、幾個、接在哪」；尺寸一律再經過這裡的檢查與修正。
 */
import { normalizeCode } from '../assembly/partsList'
import {
  FRL_LABEL,
  THREAD_SIZES,
  TUBE_SIZES,
  VALVE_FUNCTION_LABEL,
  type FrlUnit,
  type GenericSpec,
  type ThreadSize,
  type ThreadStd,
  type ValveFunction,
} from '../catalog/generic/genericParts'
import { CATEGORY_LABEL, hasModel, type Product } from '../catalog/types'
import { STANDARD_BORES } from '../engine/components/cylinderDouble'
import { formatSpecShort } from '../threads'
import type { GeminiSchema } from './gemini'

export const AI_KINDS = ['fitting', 'silencer', 'plug', 'bushing', 'speedController', 'valve', 'manifold', 'cylinder', 'frl', 'gauge', 'other'] as const
export type AiKind = (typeof AI_KINDS)[number]

/** AI 回答的一個零件（欄位都可能缺，用前要檢查） */
export interface AiPart {
  ref: string
  libraryCode?: string | null
  code?: string | null
  maker?: string | null
  label: string
  qty: number
  kind: AiKind
  form?: 'straight' | 'elbow' | 'tee' | null
  thread?: ThreadSize | null
  std?: ThreadStd | null
  tube?: number | null
  inner?: ThreadSize | null
  valveFunction?: ValveFunction | null
  exhaust?: ThreadSize | null
  mount?: 'body' | 'base' | null
  stations?: number | null
  bore?: number | null
  stroke?: number | null
  singleActing?: boolean | null
  frlUnit?: FrlUnit | null
  connectTo?: string | null
  ports?: string[] | null
  confidence: 'high' | 'medium' | 'low'
}

export interface AiResult {
  moduleName?: string | null
  parts: AiPart[]
  notes: string[]
}

const nullable = <T extends GeminiSchema>(s: T): T => ({ ...s, nullable: true })
const THREAD_ENUM: GeminiSchema = { type: 'STRING', enum: [...THREAD_SIZES] }

const PART_SCHEMA: GeminiSchema = {
  type: 'OBJECT',
  properties: {
    ref: { type: 'STRING', description: '這個零件在清單中的代號，例如 p1、p2（給 connectTo 引用）' },
    libraryCode: nullable({ type: 'STRING', description: '使用產品庫的哪一個產品：只能填產品庫清單裡的型號，原樣照抄；沒有合適的就留空' }),
    code: nullable({ type: 'STRING', description: '原廠型號（使用者有寫、或你很確定時才填）' }),
    maker: nullable({ type: 'STRING', description: '廠牌，例如 AirTAC、SMC' }),
    label: { type: 'STRING', description: '中文名稱，例如「直通快插接頭 PT1/8 × Ø6」' },
    qty: { type: 'INTEGER', description: '數量' },
    kind: { type: 'STRING', enum: [...AI_KINDS] },
    form: nullable({ type: 'STRING', enum: ['straight', 'elbow', 'tee'], description: '接頭形狀：直通、彎頭、三通' }),
    thread: nullable({ ...THREAD_ENUM, description: '螺紋尺寸（接頭的外牙、閥與氣缸的接管口、消音器的牙）' }),
    std: nullable({ type: 'STRING', enum: ['PT', 'G', 'NPT'], description: '牙型；沒說就是 PT' }),
    tube: nullable({ type: 'INTEGER', description: '快插管外徑 mm（4、6、8、10、12、16）' }),
    inner: nullable({ ...THREAD_ENUM, description: '轉接頭的內牙尺寸' }),
    valveFunction: nullable({ type: 'STRING', enum: Object.keys(VALVE_FUNCTION_LABEL), description: '閥的功能' }),
    exhaust: nullable({ ...THREAD_ENUM, description: '閥的排氣口尺寸（與接管口不同時）' }),
    mount: nullable({ type: 'STRING', enum: ['body', 'base'], description: 'body = 管接式；base = 底板式（裝在集裝座上）' }),
    stations: nullable({ type: 'INTEGER', description: '集裝座站數' }),
    bore: nullable({ type: 'INTEGER', description: '氣缸缸徑 mm' }),
    stroke: nullable({ type: 'INTEGER', description: '氣缸行程 mm' }),
    singleActing: nullable({ type: 'BOOLEAN', description: '單動氣缸' }),
    frlUnit: nullable({ type: 'STRING', enum: Object.keys(FRL_LABEL), description: '三點組合的種類' }),
    connectTo: nullable({ type: 'STRING', description: '接在哪個零件上：填那個零件的 ref' }),
    ports: nullable({ type: 'ARRAY', items: { type: 'STRING' }, description: '接在對方的哪些埠，例如 ["A","B"]、["EA","EB"]、["P"]' }),
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'], description: '你對這一項判斷的把握' },
  },
  required: ['ref', 'label', 'qty', 'kind', 'confidence'],
}

export const RESULT_SCHEMA: GeminiSchema = {
  type: 'OBJECT',
  properties: {
    moduleName: nullable({ type: 'STRING', description: '模組名稱（簡短）' }),
    parts: { type: 'ARRAY', items: PART_SCHEMA },
    notes: { type: 'ARRAY', items: { type: 'STRING' }, description: '你做的假設、需要使用者確認的事（繁體中文，每項一句）' },
  },
  required: ['parts', 'notes'],
}

export const SYSTEM_PROMPT = `你是台灣氣動元件業的應用工程師，幫業務把客戶的需求整理成零件清單，用來在 3D 組裝模組並產生示意圖。
輸出 JSON（依指定格式），所有文字用繁體中文。

規則：
1. 依敘述列出要用的零件與數量。不要加敘述沒提到、也不是必要的零件；有提到「排氣加消音器」才加消音器。
2. 產品庫裡有合適的產品時優先使用：libraryCode 填產品庫清單裡的型號（原樣照抄，不能自己編）。沒有合適的就留空，改填 kind 與尺寸，系統會產生通用 3D。
3. 台灣慣用語：1分 = 1/8"、2分 = 1/4"、3分 = 3/8"、4分 = 1/2"、6分 = 3/4"；「6mm 快插」「6 的管」= 管徑 Ø6；PT = R／Rc 錐管牙（沒說牙型就是 PT），PF = G。
4. 接頭的螺紋要與它接的埠一樣大；集裝座的 A／B 口、閥的接管口要對應正確尺寸。
5. 「N 位（N 聯、N 站）集裝座／閥島」：一個 manifold（stations = N），加上 N 顆底板式電磁閥（kind valve、mount base、qty N、connectTo 集裝座）；
   A、B 口的快插接頭接在集裝座（connectTo 集裝座，ports ["A"] 或 ["B"]，qty 各 N）；集裝座的 P 口比 A／B 大一號。
6. 管接式電磁閥：接頭接在閥的 P、A、B，消音器接 EA、EB。氣缸的速度控制接頭接在氣缸的 A、B。
7. 使用者給了型號就填在 code（原樣），並依你對該型號的了解填 kind 與尺寸；不確定時 confidence 填 low，並在 notes 說明。
8. ref 依序用 p1、p2…；connectTo 填對方的 ref。
9. notes 列出你做的假設（例如「沒說牙型，假設 PT」）與需要確認的地方，最多 6 項。`

/** 產品庫給 AI 看的清單（型號、名稱、分類、埠） */
export function libraryDigest(products: readonly Product[], limit = 200): string {
  return products
    .filter((p) => hasModel(p) && p.ports.length)
    .slice(0, limit)
    .map((p) => {
      const ports = p.ports
        .filter((x) => x.spec)
        .slice(0, 12)
        .map((x) => `${x.name} ${formatSpecShort(x.spec!)}`)
        .join('、')
      return `- ${p.modelCode}｜${p.name || '—'}｜${CATEGORY_LABEL[p.category]}｜埠：${ports}`
    })
    .join('\n')
}

export function describePrompt(description: string, products: readonly Product[]): string {
  const digest = libraryDigest(products)
  return `產品庫（可以直接用的產品）：\n${digest || '（產品庫是空的：全部用 kind 與尺寸描述）'}\n\n使用者的敘述：\n${description.trim()}`
}

export function codesPrompt(codes: readonly string[]): string {
  return `請判斷下列每個型號是什麼零件、尺寸多少（每個型號輸出一個零件：code 原樣照抄、qty 填 1、ref 依序 p1、p2…，不要 connectTo）：\n${codes.map((c) => `- ${c}`).join('\n')}`
}

// ---------------------------------------------------------------- 檢查與修正

const nearest = (value: number, list: readonly number[]) => list.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a))
const isThread = (v: unknown): v is ThreadSize => typeof v === 'string' && (THREAD_SIZES as readonly string[]).includes(v)

/**
 * AI 的零件 → 通用零件規格。缺的尺寸用常見值補上，補了哪些寫在 defaults 讓使用者知道。
 * 'other' 或資料不足時回傳 undefined。
 */
export function toGenericSpec(p: AiPart): { spec: GenericSpec; defaults: string[] } | undefined {
  const defaults: string[] = []
  const std: ThreadStd = p.std === 'G' || p.std === 'NPT' ? p.std : 'PT'
  const thread = (fallback: ThreadSize, what = '螺紋'): ThreadSize => {
    if (isThread(p.thread)) return p.thread
    defaults.push(`${what}未指定，暫用 ${fallback.startsWith('M') ? fallback : `PT${fallback}`}`)
    return fallback
  }
  const tube = (fallback = 6) => {
    if (typeof p.tube === 'number' && p.tube > 0) return nearest(p.tube, TUBE_SIZES)
    defaults.push(`管徑未指定，暫用 Ø${fallback}`)
    return fallback
  }
  let spec: GenericSpec
  switch (p.kind) {
    case 'fitting': {
      const form = p.form === 'elbow' || p.form === 'tee' ? p.form : 'straight'
      spec = isThread(p.thread) ? { kind: 'fitting', form, thread: p.thread, std, tube: tube() } : { kind: 'fitting', form, tube: tube() }
      break
    }
    case 'silencer':
    case 'plug':
    case 'gauge':
      spec = { kind: p.kind, thread: thread('1/8'), std }
      break
    case 'bushing': {
      const outer = thread('1/4', '外牙')
      const inner = isThread(p.inner) ? p.inner : (defaults.push('內牙未指定，暫用 PT1/8'), '1/8' as ThreadSize)
      spec = { kind: 'bushing', thread: outer, inner, std }
      break
    }
    case 'speedController':
      spec = { kind: 'speedController', thread: thread('1/8'), tube: tube(), std }
      break
    case 'valve': {
      const fn: ValveFunction = p.valveFunction && p.valveFunction in VALVE_FUNCTION_LABEL ? p.valveFunction : (defaults.push('閥的功能未指定，暫用 5/2 單電控'), '52Single')
      spec = {
        kind: 'valve',
        fn,
        thread: thread('1/8', '接管口'),
        std,
        ...(p.mount === 'base' && { mount: 'base' as const }),
        ...(p.mount !== 'base' && isThread(p.exhaust) && p.exhaust !== p.thread && { exhaust: p.exhaust }),
      }
      break
    }
    case 'manifold': {
      const stations = typeof p.stations === 'number' && p.stations > 0 ? Math.min(20, Math.round(p.stations)) : (defaults.push('站數未指定，暫用 4 站'), 4)
      spec = { kind: 'manifold', stations, thread: thread('1/8', 'A／B 口'), std }
      break
    }
    case 'cylinder': {
      const bore = typeof p.bore === 'number' && p.bore > 0 ? nearest(p.bore, STANDARD_BORES.filter((b) => b >= 6 && b <= 200)) : (defaults.push('缸徑未指定，暫用 Ø32'), 32)
      const stroke = typeof p.stroke === 'number' && p.stroke > 0 ? Math.min(2000, Math.round(p.stroke)) : (defaults.push('行程未指定，暫用 50 mm'), 50)
      spec = { kind: 'cylinder', bore, stroke, ...(p.singleActing && { single: true }) }
      break
    }
    case 'frl': {
      const unit: FrlUnit = p.frlUnit && p.frlUnit in FRL_LABEL ? p.frlUnit : (defaults.push('三點組合種類未指定，暫用過濾調壓閥'), 'filterRegulator')
      spec = { kind: 'frl', unit, thread: thread('1/4', '接管口'), std }
      break
    }
    default:
      return undefined
  }
  return { spec, defaults }
}

/** 整理後的一列：用產品庫的產品，或產生通用 3D */
export interface PlanRow {
  ref: string
  label: string
  qty: number
  /** 產品庫的產品 */
  product?: Product
  /** 要產生的通用零件 */
  spec?: GenericSpec
  /** 原廠型號（AI 判斷或使用者寫的） */
  code?: string
  maker?: string
  connectTo?: string
  ports: string[]
  confidence: AiPart['confidence']
  /** 補上的預設值、無法產生的原因 */
  notes: string[]
}

/** AI 的回答 → 清單（檢查型號是否真的在產品庫、尺寸是否合理） */
export function planFromAi(result: AiResult, products: readonly Product[]): PlanRow[] {
  const byCode = new Map(products.filter(hasModel).map((p) => [normalizeCode(p.modelCode), p]))
  const refs = new Set(result.parts.map((p) => p.ref))
  return result.parts
    .filter((p) => p && typeof p.label === 'string')
    .map((p, i): PlanRow => {
      const qty = Math.max(1, Math.min(200, Math.round(Number(p.qty) || 1)))
      const product = (p.libraryCode && byCode.get(normalizeCode(p.libraryCode))) || (p.code && byCode.get(normalizeCode(p.code))) || undefined
      const base: PlanRow = {
        ref: p.ref || `p${i + 1}`,
        label: p.label,
        qty,
        ...(p.code && { code: p.code.trim() }),
        ...(p.maker && { maker: p.maker }),
        ...(p.connectTo && refs.has(p.connectTo) && p.connectTo !== p.ref && { connectTo: p.connectTo }),
        ports: (p.ports ?? []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()),
        confidence: p.confidence ?? 'medium',
        notes: [],
      }
      if (product) return { ...base, product }
      const g = toGenericSpec(p)
      if (!g) return { ...base, notes: ['無法判斷種類與尺寸，不會加入'] }
      return { ...base, spec: g.spec, notes: g.defaults }
    })
}

/** 型號 → 通用零件（AI 判斷不認得的型號） */
export function genericFromAi(result: AiResult, codes: readonly string[]): Map<string, { spec: GenericSpec; name?: string; maker?: string }> {
  const out = new Map<string, { spec: GenericSpec; name?: string; maker?: string }>()
  const wanted = new Map(codes.map((c) => [normalizeCode(c), c]))
  for (const p of result.parts) {
    const code = p.code && wanted.get(normalizeCode(p.code))
    if (!code || p.confidence === 'low') continue
    const g = toGenericSpec(p)
    if (g) out.set(code, { spec: g.spec, name: p.label, ...(p.maker && { maker: p.maker }) })
  }
  return out
}

/** 清單的一列 → 型號清單的一行（接在哪個零件、哪些埠） */
export function planToList(rows: readonly (PlanRow & { modelCode: string })[]): string {
  const byRef = new Map(rows.map((r) => [r.ref, r]))
  return rows
    .map((r) => {
      const target = r.connectTo ? byRef.get(r.connectTo) : undefined
      const hint = target ? ` → ${target.modelCode}${r.ports.length ? ` 的 ${r.ports.join('、')}` : ''}` : r.ports.length ? ` → ${r.ports.join('、')}` : ''
      return `${r.modelCode} ×${r.qty}${hint}  # ${r.label}`
    })
    .join('\n')
}

