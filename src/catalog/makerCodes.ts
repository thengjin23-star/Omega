/**
 * 從型號判斷產品：分類、名稱、預期的埠與規格（目前支援亞德客 AirTAC 常用系列）。
 *
 * 用途：
 * - 匯入 3D 檔時（型號預設取檔名），決定分類與名稱，並用預期的規格核對從孔徑量到的規格
 *   （例如同樣 Ø8.6 的孔，PT 與 G 量不出差別，型號說了才知道）。
 * - 清單上的型號產品庫沒有、也沒有 3D 檔時，依預期的埠產生通用 3D（見 generic/）。
 */
import { normalizeCode } from '../assembly/partsList'
import type { ProductCategory } from './types'

export interface ExpectedPort {
  name: string
  /** 可給 parseSpec 解析的規格，例如「Rc1/4」「R1/8」「Ø6 快插」 */
  spec: string
  /** 排氣口（自動命名時用） */
  exhaust?: boolean
}

export interface CodeInfo {
  maker: string
  series?: string
  category: ProductCategory
  /** 中文名稱，例如「5/2 單電控電磁閥 PT1/4」；也用來推斷氣動功能 */
  name: string
  /** 母牙的螺紋標準：PT（R／Rc）、G、NPT */
  thread: 'PT' | 'G' | 'NPT'
  ports: ExpectedPort[]
  /** 氣缸的缸徑與行程 */
  bore?: number
  stroke?: number
  /** 集裝座站數 */
  stations?: number
}

/** 管螺紋尺寸代號（閥、三點組合）：06 = 1/8 … */
const VALVE_SIZE: Record<string, string> = { M5: 'M5', '06': '1/8', '08': '1/4', '10': '3/8', '15': '1/2', '20': '3/4', '25': '1' }
/** 接頭的螺紋代號：01 = 1/8 … */
const FITTING_SIZE: Record<string, string> = { M5: 'M5', M6: 'M6', '01': '1/8', '02': '1/4', '03': '3/8', '04': '1/2' }

/** 規格文字：管螺紋加上標準（PT → R／Rc），公制直接寫 */
function threadText(size: string, gender: 'male' | 'female', thread: CodeInfo['thread']): string {
  if (size.startsWith('M')) return size
  if (thread === 'G') return `G${size} ${gender === 'male' ? '公' : '母'}`
  if (thread === 'NPT') return `NPT${size} ${gender === 'male' ? '公' : '母'}`
  return `${gender === 'male' ? 'R' : 'Rc'}${size}`
}
const sizeLabel = (size: string, thread: CodeInfo['thread']) => (size.startsWith('M') ? size : `${thread === 'PT' ? 'PT' : thread}${size}`)
const threadOf = (suffix: string | undefined): CodeInfo['thread'] => (suffix === 'G' ? 'G' : suffix === 'T' || suffix === 'N' ? 'NPT' : 'PT')

/** 4V／3V 各系列的排氣口尺寸（與主埠不同時） */
const EXHAUST_BY_SERIES: Record<string, string | undefined> = { '2': '1/8', '3': '1/4' }

const VALVE_TYPE_NAME: Record<string, string> = {
  '4V1': '5/2 單電控電磁閥',
  '4V2': '5/2 雙電控電磁閥',
  '4V3C': '5/3 中位封閉電磁閥',
  '4V3E': '5/3 中位排氣電磁閥',
  '4V3P': '5/3 中位加壓電磁閥',
  '3V1': '3/2 單電控電磁閥（常閉）',
  '3V2': '3/2 雙電控電磁閥',
  '4A1': '5/2 單氣控閥',
  '4A2': '5/2 雙氣控閥',
  '4A3C': '5/3 中位封閉氣控閥',
  '4A3E': '5/3 中位排氣氣控閥',
  '4A3P': '5/3 中位加壓氣控閥',
  '3A1': '3/2 單氣控閥',
  '3A2': '3/2 雙氣控閥',
}

const FITTING_KIND: Record<string, { name: string; male: boolean; tubes: number }> = {
  C: { name: '直通快插接頭', male: true, tubes: 1 },
  L: { name: '彎頭快插接頭', male: true, tubes: 1 },
  B: { name: '三通快插接頭（外牙在中間）', male: true, tubes: 2 },
  D: { name: '三通快插接頭（外牙在一端）', male: true, tubes: 2 },
  U: { name: '直通快插接頭（管對管）', male: false, tubes: 2 },
  V: { name: '彎頭快插接頭（管對管）', male: false, tubes: 2 },
  E: { name: '三通快插接頭（管對管）', male: false, tubes: 3 },
  Y: { name: 'Y 型快插接頭', male: false, tubes: 3 },
  M: { name: '隔板快插接頭', male: false, tubes: 2 },
}

const CYLINDER_SERIES: Record<string, string> = {
  SC: '標準氣缸',
  SU: '標準氣缸',
  SE: '標準氣缸',
  SI: 'ISO 標準氣缸',
  SG: '標準氣缸',
  MAL: '迷你氣缸（鋁）',
  MI: '迷你氣缸（不鏽鋼）',
  MA: '迷你氣缸（不鏽鋼）',
  MF: '迷你氣缸',
  SDA: '薄型氣缸',
  SDAS: '薄型氣缸（單動）',
  ACQ: '薄型氣缸',
  ACQS: '薄型氣缸（單動）',
  ACP: '薄型氣缸',
  TN: '雙軸氣缸',
  TR: '雙軸氣缸',
  TCL: '三軸氣缸',
  TCM: '三軸氣缸',
  MBL: '標準氣缸',
}

const FRL_NAME: Record<string, string> = {
  FR: '過濾調壓閥',
  R: '調壓閥',
  F: '過濾器',
  L: '給油器',
  C: '三點組合（過濾器＋調壓閥＋給油器）',
  FC: '二點組合（過濾調壓閥＋給油器）',
}

/** 依型號判斷產品；認不出來時回傳 undefined */
export function decodeModelCode(raw: string): CodeInfo | undefined {
  const code = normalizeCode(raw).replace(/[（(].*$/, '')
  return airtacValve(code) ?? airtacManifold(code) ?? airtacFitting(code) ?? airtacSpeedController(code) ?? airtacSilencer(code) ?? airtacCylinder(code) ?? airtacFrl(code)
}

const AIRTAC = 'AirTAC'

function airtacValve(code: string): CodeInfo | undefined {
  const m = /^(4V|3V|4A|3A|4M|4R)([1-4])([1-3])0([CEP])?-?(M5|06|08|10|15)([GT])?/.exec(code)
  if (!m) return undefined
  const [, kind, series, fn, center, sizeCode, suffix] = m
  const family = kind === '4M' || kind === '4R' ? '4V' : kind
  const key = `${family}${fn}${fn === '3' ? (center ?? 'C') : ''}`
  const typeName = VALVE_TYPE_NAME[key]
  if (!typeName) return undefined
  const thread = threadOf(suffix)
  const size = VALVE_SIZE[sizeCode]
  const exhaust = (size !== 'M5' && EXHAUST_BY_SERIES[series]) || size
  const main = threadText(size, 'female', thread)
  const ex = threadText(exhaust, 'female', thread)
  const five = family.startsWith('4')
  return {
    maker: AIRTAC,
    series: `${kind}${series}00`,
    category: 'valve',
    name: `${typeName} ${sizeLabel(size, thread)}`,
    thread,
    ports: five
      ? [
          { name: 'P', spec: main },
          { name: 'A', spec: main },
          { name: 'B', spec: main },
          { name: 'EA', spec: ex, exhaust: true },
          { name: 'EB', spec: ex, exhaust: true },
        ]
      : [
          { name: 'P', spec: main },
          { name: 'A', spec: main },
          { name: 'R', spec: ex, exhaust: true },
        ],
  }
}

function airtacManifold(code: string): CodeInfo | undefined {
  const m = /^([1-4])00M-?(\d{1,2})F/.exec(code)
  if (!m) return undefined
  const stations = Number(m[2])
  return {
    maker: AIRTAC,
    series: `4V${m[1]}00`,
    category: 'manifold',
    name: `集裝座 ${stations} 站（4V${m[1]}00 系列）`,
    thread: 'PT',
    ports: [],
    stations,
  }
}

function airtacFitting(code: string): CodeInfo | undefined {
  const m = /^A?P([CLBDUVEYM])(\d{1,2})(?:-?([GNT])?(M5|M6|0[1-4]))?$/.exec(code)
  if (!m) return undefined
  const [, kindCode, tubeText, suffix, threadCode] = m
  const kind = FITTING_KIND[kindCode]
  const tube = Number(tubeText)
  if (![3, 4, 6, 8, 10, 12, 16].includes(tube)) return undefined
  if (kind.male !== !!threadCode) return undefined
  const thread = threadOf(suffix)
  const ports: ExpectedPort[] = []
  let name = `${kind.name} Ø${tube}`
  if (kind.male) {
    const size = FITTING_SIZE[threadCode]
    ports.push({ name: '1', spec: threadText(size, 'male', thread) })
    name = `${kind.name} ${sizeLabel(size, thread)} × Ø${tube}`
  }
  for (let i = 0; i < kind.tubes; i++) ports.push({ name: String(ports.length + 1), spec: `Ø${tube} 快插` })
  return { maker: AIRTAC, series: `P${kindCode}`, category: 'fitting', name, thread, ports }
}

function airtacSpeedController(code: string): CodeInfo | undefined {
  const fitting = /^JSC(\d{1,2})-?([GNT])?(M5|M6|0[1-4])/.exec(code)
  if (fitting) {
    const tube = Number(fitting[1])
    const thread = threadOf(fitting[2])
    const size = FITTING_SIZE[fitting[3]]
    return {
      maker: AIRTAC,
      series: 'JSC',
      category: 'speedController',
      name: `速度控制接頭 ${sizeLabel(size, thread)} × Ø${tube}`,
      thread,
      ports: [
        { name: '1', spec: threadText(size, 'male', thread) },
        { name: '2', spec: `Ø${tube} 快插` },
      ],
    }
  }
  const inline = /^ASC\d{3}-?(M5|06|08|10|15)([GT])?/.exec(code)
  if (inline) {
    const thread = threadOf(inline[2])
    const size = VALVE_SIZE[inline[1]]
    return {
      maker: AIRTAC,
      series: 'ASC',
      category: 'speedController',
      name: `管路型速度控制閥 ${sizeLabel(size, thread)}`,
      thread,
      ports: [
        { name: 'IN', spec: threadText(size, 'female', thread) },
        { name: 'OUT', spec: threadText(size, 'female', thread) },
      ],
    }
  }
  return undefined
}

function airtacSilencer(code: string): CodeInfo | undefined {
  const m = /^(BSLM|BSL|BESL|PSL|ESL|SL)-?([GNT])?(M5|M6|0[1-4])$/.exec(code)
  if (!m) return undefined
  const thread = threadOf(m[2])
  const size = FITTING_SIZE[m[3]]
  return {
    maker: AIRTAC,
    series: m[1],
    category: 'silencer',
    name: `消音器 ${sizeLabel(size, thread)}`,
    thread,
    ports: [{ name: '1', spec: threadText(size, 'male', thread) }],
  }
}

function airtacCylinder(code: string): CodeInfo | undefined {
  const m = /^(SDAS|SDA|ACQS|ACQ|ACP|MAL|MBL|SC|SU|SE|SI|SG|MI|MA|MF|TCL|TCM|TN|TR)J?(\d{1,3})[X×*](\d{1,4})/.exec(code)
  if (!m) return undefined
  const [, series, boreText, strokeText] = m
  const bore = Number(boreText)
  const stroke = Number(strokeText)
  return {
    maker: AIRTAC,
    series,
    category: 'cylinder',
    name: `${CYLINDER_SERIES[series] ?? '氣缸'} Ø${bore} × ${stroke}`,
    thread: 'PT',
    ports: [],
    bore,
    stroke,
  }
}

function airtacFrl(code: string): CodeInfo | undefined {
  const m = /^(?:G|A|B|GA)(FR|FC|R|F|L|C)(\d{3,4})-?(06|08|10|15|20|25)([GT])?/.exec(code)
  if (!m) return undefined
  const [, kind, seriesNo, sizeCode, suffix] = m
  const thread = threadOf(suffix)
  const size = VALVE_SIZE[sizeCode]
  const main = threadText(size, 'female', thread)
  const ports: ExpectedPort[] = [
    { name: 'IN', spec: main },
    { name: 'OUT', spec: main },
  ]
  if (kind === 'FR' || kind === 'R' || kind === 'C' || kind === 'FC') ports.push({ name: '壓力錶', spec: threadText('1/8', 'female', thread) })
  return {
    maker: AIRTAC,
    series: `${code.slice(0, code.indexOf(seriesNo))}${seriesNo}`,
    category: 'frl',
    name: `${FRL_NAME[kind]} ${sizeLabel(size, thread)}`,
    thread,
    ports,
  }
}
