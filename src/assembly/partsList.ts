/**
 * 型號清單：使用者貼上「要用哪些零件、各幾個」，例如
 *
 *   4SV200M5F
 *   4SV21008BD ×4
 *   PL802D ×8 → A, B
 *   BSL01 ×2 → EA, EB
 *
 * 也接受從 Excel 複製的欄位（Tab 或逗號分隔：型號、…、數量）、「4 個」「4pcs」這類寫法，
 * 一行可以用「、」「；」寫多個。「→」「->」「@」「接在」後面是指定的埠（可加上要接的零件型號）。
 */
import type { Product } from '../catalog/types'

export interface PartsListEntry {
  /** 第幾行（1 起算） */
  line: number
  /** 使用者寫的型號 */
  code: string
  qty: number
  /** 指定要接的埠（名稱）與零件型號 */
  hint?: { target?: string; ports: string[] }
}

export interface PartsListParse {
  entries: PartsListEntry[]
  /** 看不懂的行 */
  errors: { line: number; text: string; message: string }[]
}

/** 全形英數、符號轉半形（中文不變；＊、＠ 留給數量與指定埠的判斷） */
const toHalfWidth = (text: string) =>
  text
    .replace(/[\uFF01-\uFF5E]/g, (c) => (c === '\uFF0A' || c === '\uFF20' ? c : String.fromCharCode(c.charCodeAt(0) - 0xfee0)))
    .replace(/\u3000/g, ' ')

/** 全形轉半形、轉大寫、去掉空白：比對型號用 */
export function normalizeCode(code: string): string {
  return toHalfWidth(code).replace(/\s+/g, '').toUpperCase()
}

/** 寬鬆比對：再去掉 - _ / . 等符號 */
const looseCode = (code: string) => normalizeCode(code).replace(/[-_/.·]/g, '')

const UNIT = '(?:個|顆|支|只|組|套|條|pcs?|PCS?|ea|EA)'
/** 數量寫在後面：依序嘗試「×4」「 x 4」「 4」「 4個」，最後才是緊接的「x4」（可能是型號的一部分） */
const QTY_SUFFIXES: { re: RegExp; ambiguous?: boolean }[] = [
  { re: new RegExp(`^(.+?)\\s*[×*＊]\\s*(\\d+)\\s*${UNIT}?$`) },
  { re: new RegExp(`^(.+?)\\s+[xX]\\s*(\\d+)\\s*${UNIT}?$`) },
  { re: new RegExp(`^(.+?)\\s+(\\d+)\\s*${UNIT}?$`) },
  { re: new RegExp(`^(.+?)(\\d+)\\s*${UNIT}$`) },
  { re: new RegExp(`^(.+?)[xX](\\d+)$`), ambiguous: true },
]
const QTY_PREFIX = new RegExp(`^(\\d+)\\s*(?:${UNIT}\\s*|[×xX*＊]\\s*|\\s+)(.+)$`)
const HINT_SPLIT = /\s*(?:→|->|=>|@|＠|接在|接到|裝在)\s*/

/** 埠名稱比對：大寫、去掉「埠」「口」等字 */
export const normalizePortName = (name: string): string =>
  normalizeCode(name)
    .replace(/[埠口孔]$/u, '')
    .replace(/^PORT/, '')

/**
 * 解析清單。isCode 用來判斷一段文字是不是產品庫裡的型號
 * （避免把型號結尾的數字或 X 當成數量，例如 SC32X100）。
 */
export function parsePartsList(text: string, isCode: (code: string) => boolean = () => false): PartsListParse {
  const entries: PartsListEntry[] = []
  const errors: PartsListParse['errors'] = []
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = i + 1
    const content = toHalfWidth(rawLine)
      .replace(/(^|\s)(#|\/\/).*$/, '')
      .trim()
    if (!content) return
    // 表格（Excel 的 Tab、CSV 的逗號）：取型號欄與最後一個數字欄
    if (/\t/.test(content) || (/,/.test(content) && !HINT_SPLIT.test(content))) {
      const cells = content.split(/\t|,/).map((c) => c.trim()).filter(Boolean)
      const known = cells.find((c) => isCode(c))
      const qtyCell = [...cells].reverse().find((c) => /^\d+$/.test(c) && c !== known)
      // 沒有型號、也沒有數字的列是表頭（項次、型號、數量…）：略過
      if (!known && !qtyCell) return
      const codeCell = known ?? cells.find((c) => !/^\d+(\.\d+)?$/.test(c))
      if (codeCell) {
        entries.push({ line, code: codeCell, qty: qtyCell ? Number(qtyCell) : 1 })
        return
      }
    }
    // 「；」分開多個項目；「、」也可以分開，但有指定埠時「、」是埠的分隔（→ A、B）
    const parts = content
      .split(/[；;]/)
      .flatMap((seg) => (HINT_SPLIT.test(seg) ? [seg] : seg.split('、')))
      .map((p) => p.trim())
      .filter(Boolean)
    for (const part of parts) {
      const [itemText, hintText] = part.split(HINT_SPLIT, 2)
      const entry = parseItem(itemText.trim(), isCode)
      if (!entry) {
        errors.push({ line, text: part, message: '看不懂這一行：請寫「型號 ×數量」' })
        continue
      }
      if (entry.qty < 1) {
        errors.push({ line, text: part, message: '數量要大於 0' })
        continue
      }
      const hint = hintText ? parseHint(hintText, isCode) : undefined
      entries.push({ line, code: entry.code, qty: entry.qty, ...(hint && { hint }) })
    }
  })
  return { entries, errors }
}

function parseItem(text: string, isCode: (code: string) => boolean): { code: string; qty: number } | undefined {
  if (!text) return undefined
  if (isCode(text)) return { code: text, qty: 1 }
  const prefix = QTY_PREFIX.exec(text)
  if (prefix && (isCode(prefix[2].trim()) || !isCode(text))) return { code: prefix[2].trim(), qty: Number(prefix[1]) }
  for (const { re, ambiguous } of QTY_SUFFIXES) {
    const m = re.exec(text)
    if (!m) continue
    const code = m[1].trim()
    // 緊接的 x 數字（例如 SC32X100）只有在拆開後的型號確定存在時才當成數量
    if (ambiguous && !isCode(code)) continue
    return { code, qty: Number(m[2]) }
  }
  return { code: text, qty: 1 }
}

function parseHint(text: string, isCode: (code: string) => boolean): PartsListEntry['hint'] {
  // 型號本身含空白（例如「通用 集裝座 4 站 PT1/8」）：整段是型號，或「型號 的 埠」
  const trimmed = text.trim()
  if (/\s/.test(trimmed) && isCode(trimmed)) return { target: trimmed, ports: [] }
  const withPorts = /^(.+?)\s*(?:的|上的?)\s*(.+)$/u.exec(trimmed)
  if (withPorts && /\s/.test(withPorts[1].trim()) && isCode(withPorts[1].trim())) {
    const rest = parseHint(withPorts[2], () => false)
    return { target: withPorts[1].trim(), ports: rest?.ports ?? [] }
  }
  const tokens = text
    .split(/[,，、/\s]+/)
    .map((t) => t.replace(/^(的|上的?|之)|(的|上)$/gu, '').trim())
    .filter((t) => t && !/^(的|埠|口|上|和|及|與|跟|and)$/iu.test(t))
  let target: string | undefined
  const ports: string[] = []
  for (const t of tokens) {
    if (!target && isCode(t)) target = t
    else ports.push(t.replace(/(埠|口)$/u, ''))
  }
  if (!target && !ports.length) return undefined
  return { ...(target && { target }), ports }
}

/** 產品庫的型號索引：精確（正規化後相同）與寬鬆（去掉符號後相同）比對，找不到時給相近的型號 */
export function productIndex(products: readonly Product[]) {
  const exact = new Map<string, Product[]>()
  const loose = new Map<string, Product[]>()
  const add = (map: Map<string, Product[]>, key: string, p: Product) => {
    if (!key) return
    const list = map.get(key) ?? []
    list.push(p)
    map.set(key, list)
  }
  for (const p of products) {
    add(exact, normalizeCode(p.modelCode), p)
    add(loose, looseCode(p.modelCode), p)
  }
  const find = (code: string): Product | undefined => exact.get(normalizeCode(code))?.[0] ?? loose.get(looseCode(code))?.[0]
  const similar = (code: string, max = 3): Product[] => {
    const q = looseCode(code)
    if (!q) return []
    return products
      .map((p) => {
        const c = looseCode(p.modelCode)
        const d = c.startsWith(q) || q.startsWith(c) ? Math.abs(c.length - q.length) * 0.5 : editDistance(q, c)
        return { p, d }
      })
      .filter((x) => x.d <= Math.max(2, Math.floor(q.length / 4)))
      .sort((a, b) => a.d - b.d || a.p.modelCode.localeCompare(b.p.modelCode))
      .slice(0, max)
      .map((x) => x.p)
  }
  return { find, similar, isCode: (code: string) => !!find(code) }
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}
