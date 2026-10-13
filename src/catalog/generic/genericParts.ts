/**
 * 通用 3D 零件：沒有 3D 檔（或沒有型號）的零件，依種類與尺寸產生簡化的示意模型，埠的位置與規格一併定義好。
 * 形狀不是實物，但接口尺寸（螺紋外徑、孔徑、管徑）貼近實物，可以直接組裝、出示意圖與圖面。
 *
 * 這個檔案只有規格與名稱（純 TS）；形狀由 buildGeneric.ts 以 replicad 在 Web Worker 中產生。
 */
import type { ParamValue } from '../../engine/types'
import type { CodeInfo } from '../makerCodes'
import type { ProductCategory } from '../types'

export type ThreadSize = 'M5' | 'M6' | '1/8' | '1/4' | '3/8' | '1/2' | '3/4'
/** 螺紋標準：PT（R／Rc）、G、NPT */
export type ThreadStd = 'PT' | 'G' | 'NPT'
export type ValveFunction = '52Single' | '52Double' | '53Closed' | '53Exhaust' | '53Pressure' | '32NC' | '52Pilot'
export type FrlUnit = 'filter' | 'regulator' | 'lubricator' | 'filterRegulator' | 'combo'

export type GenericSpec =
  /** 快插接頭：有 thread 為外牙接頭，沒有則是管對管；form：直通、彎頭、三通 */
  | { kind: 'fitting'; form: 'straight' | 'elbow' | 'tee'; thread?: ThreadSize; std?: ThreadStd; tube: number }
  | { kind: 'silencer'; thread: ThreadSize; std?: ThreadStd }
  | { kind: 'plug'; thread: ThreadSize; std?: ThreadStd }
  /** 轉接頭：外牙 thread、內牙 inner */
  | { kind: 'bushing'; thread: ThreadSize; inner: ThreadSize; std?: ThreadStd }
  | { kind: 'speedController'; thread: ThreadSize; tube: number; std?: ThreadStd }
  /** 電磁閥：body = 管接式（P／EA／EB 在前面、A／B 在上面）；base = 底板式（裝在集裝座上） */
  | { kind: 'valve'; fn: ValveFunction; thread: ThreadSize; exhaust?: ThreadSize; std?: ThreadStd; mount?: 'body' | 'base' }
  /** 集裝座：stations 站，每站的 A／B 為 thread，P 大一號 */
  | { kind: 'manifold'; stations: number; thread: ThreadSize; std?: ThreadStd }
  | { kind: 'cylinder'; bore: number; stroke: number; single?: boolean; std?: ThreadStd }
  | { kind: 'frl'; unit: FrlUnit; thread: ThreadSize; std?: ThreadStd }
  | { kind: 'gauge'; thread: ThreadSize; std?: ThreadStd }

export const THREAD_SIZES: readonly ThreadSize[] = ['M5', 'M6', '1/8', '1/4', '3/8', '1/2', '3/4']
export const TUBE_SIZES: readonly number[] = [4, 6, 8, 10, 12, 16]

export const VALVE_FUNCTION_LABEL: Record<ValveFunction, string> = {
  '52Single': '5/2 單電控電磁閥',
  '52Double': '5/2 雙電控電磁閥',
  '53Closed': '5/3 中位封閉電磁閥',
  '53Exhaust': '5/3 中位排氣電磁閥',
  '53Pressure': '5/3 中位加壓電磁閥',
  '32NC': '3/2 電磁閥（常閉）',
  '52Pilot': '5/2 氣控閥',
}
/** 型號用的簡稱 */
const VALVE_SHORT: Record<ValveFunction, string> = {
  '52Single': '5/2單',
  '52Double': '5/2雙',
  '53Closed': '5/3中封',
  '53Exhaust': '5/3中排',
  '53Pressure': '5/3中壓',
  '32NC': '3/2',
  '52Pilot': '5/2氣控',
}
const VALVE_TYPE: Record<ValveFunction, string> = {
  '52Single': 'valve52Single',
  '52Double': 'valve52Double',
  '53Closed': 'valve53Closed',
  '53Exhaust': 'valve53Exhaust',
  '53Pressure': 'valve53Pressure',
  '32NC': 'valve32NC',
  '52Pilot': 'valve52Pilot',
}

export const FRL_LABEL: Record<FrlUnit, string> = {
  filter: '過濾器',
  regulator: '調壓閥',
  lubricator: '給油器',
  filterRegulator: '過濾調壓閥',
  combo: '三點組合（過濾調壓閥＋給油器）',
}
const FRL_TYPE: Record<FrlUnit, string> = { filter: 'filter', regulator: 'regulator', lubricator: 'lubricator', filterRegulator: 'regulator', combo: 'frl' }

/** 螺紋顯示：PT1/8、G1/4、NPT1/8、M5 */
export const threadLabel = (size: ThreadSize, std: ThreadStd = 'PT') => (size.startsWith('M') ? size : `${std}${size}`)

/** 給 parseSpec 的規格文字 */
export function threadSpecText(size: ThreadSize, gender: 'male' | 'female', std: ThreadStd = 'PT'): string {
  if (size.startsWith('M')) return size
  if (std === 'G') return `G${size} ${gender === 'male' ? '公' : '母'}`
  if (std === 'NPT') return `NPT${size} ${gender === 'male' ? '公' : '母'}`
  return `${gender === 'male' ? 'R' : 'Rc'}${size}`
}

/** 氣缸的接管尺寸（依缸徑） */
export function cylinderPortSize(bore: number): ThreadSize {
  if (bore <= 16) return 'M5'
  if (bore <= 32) return '1/8'
  if (bore <= 50) return '1/4'
  if (bore <= 80) return '3/8'
  return '1/2'
}

/** 大一號的管螺紋（集裝座的 P 口） */
export function nextSize(size: ThreadSize): ThreadSize {
  const order: ThreadSize[] = ['M5', '1/8', '1/4', '3/8', '1/2', '3/4']
  const i = order.indexOf(size === 'M6' ? 'M5' : size)
  return order[Math.min(order.length - 1, i + 1)]
}

/** 集裝座與底板式閥共用的安裝面名稱 */
export const baseInterfaceKey = (size: ThreadSize, std: ThreadStd = 'PT') => `通用 ${threadLabel(size, std)} 閥座`

export interface GenericMeta {
  /** 建議的型號（使用者沒給型號時用） */
  modelCode: string
  name: string
  category: ProductCategory
  pneumatic: { type: string; ports?: Record<string, string>; params?: Record<string, ParamValue> }
}

/** 規格的唯一字串（產品庫已經有相同的通用零件就沿用） */
export function genericKey(spec: GenericSpec): string {
  return JSON.stringify(Object.keys(spec).sort().map((k) => [k, (spec as Record<string, unknown>)[k] ?? null]))
}

/** 通用零件的型號、名稱、分類與氣動功能 */
export function genericMeta(spec: GenericSpec): GenericMeta {
  const t = (size: ThreadSize) => threadLabel(size, 'std' in spec ? spec.std : 'PT')
  switch (spec.kind) {
    case 'fitting': {
      const form = { straight: '直通', elbow: '彎頭', tee: '三通' }[spec.form]
      if (!spec.thread) return meta(`${form}接頭 Ø${spec.tube}`, `${form}快插接頭（管對管） Ø${spec.tube}`, 'fitting', { type: 'fitting' })
      return meta(`${form}接頭 ${t(spec.thread)}-Ø${spec.tube}`, `${form}快插接頭 ${t(spec.thread)} × Ø${spec.tube}`, 'fitting', { type: 'fitting' })
    }
    case 'silencer':
      return meta(`消音器 ${t(spec.thread)}`, `消音器 ${t(spec.thread)}`, 'silencer', { type: 'silencer', ports: { E: '1' } })
    case 'plug':
      return meta(`塞頭 ${t(spec.thread)}`, `塞頭 ${t(spec.thread)}`, 'fitting', { type: 'plug' })
    case 'bushing':
      return meta(`轉接頭 ${t(spec.thread)}-${t(spec.inner)}`, `轉接頭 ${t(spec.thread)} 外牙 × ${t(spec.inner)} 內牙`, 'fitting', { type: 'fitting' })
    case 'speedController':
      return meta(`速控接頭 ${t(spec.thread)}-Ø${spec.tube}`, `速度控制接頭 ${t(spec.thread)} × Ø${spec.tube}`, 'speedController', {
        type: 'flowControl',
        ports: { 2: '1', 1: '2' },
      })
    case 'valve': {
      const label = VALVE_FUNCTION_LABEL[spec.fn]
      if (spec.mount === 'base') return meta(`底板閥 ${VALVE_SHORT[spec.fn]} ${t(spec.thread)}`, `${label}（底板式，集裝座用 ${t(spec.thread)}）`, 'valve', { type: VALVE_TYPE[spec.fn] })
      return meta(`電磁閥 ${VALVE_SHORT[spec.fn]} ${t(spec.thread)}`, `${label} ${t(spec.thread)}`, 'valve', { type: VALVE_TYPE[spec.fn] })
    }
    case 'manifold':
      return meta(`集裝座 ${spec.stations} 站 ${t(spec.thread)}`, `集裝座 ${spec.stations} 站（A／B ${t(spec.thread)}）`, 'manifold', { type: 'manifold' })
    case 'cylinder': {
      const type = spec.single ? 'cylinderSingle' : 'cylinderDouble'
      return meta(`氣缸 Ø${spec.bore}×${spec.stroke}`, `${spec.single ? '單動' : '雙動'}氣缸 Ø${spec.bore} × ${spec.stroke}`, 'cylinder', {
        type,
        params: { bore: spec.bore, stroke: spec.stroke },
      })
    }
    case 'frl':
      return meta(`${FRL_LABEL[spec.unit].replace(/（.*）/, '')} ${t(spec.thread)}`, `${FRL_LABEL[spec.unit]} ${t(spec.thread)}`, 'frl', {
        type: FRL_TYPE[spec.unit],
        ...(spec.unit === 'regulator' || spec.unit === 'filterRegulator' ? { params: { setting: 0.5 } } : {}),
      })
    case 'gauge':
      return meta(`壓力錶 ${t(spec.thread)}`, `壓力錶 ${t(spec.thread)}`, 'other', { type: 'pressureGauge' })
  }
}

const meta = (code: string, name: string, category: ProductCategory, pneumatic: GenericMeta['pneumatic']): GenericMeta => ({
  modelCode: `通用 ${code}`,
  name,
  category,
  pneumatic,
})

/** 型號規則認出的產品 → 通用零件規格（不知道形狀時回傳 undefined） */
export function genericFromCode(info: CodeInfo): GenericSpec | undefined {
  const std: ThreadStd = info.thread
  const sizeOf = (spec: string | undefined): ThreadSize | undefined => {
    const m = spec && /(M5|M6|1\/8|1\/4|3\/8|1\/2|3\/4)/.exec(spec)
    return m ? (m[1] as ThreadSize) : undefined
  }
  const tubeOf = (spec: string | undefined) => {
    const m = spec && /Ø(\d+)/.exec(spec)
    return m ? Number(m[1]) : undefined
  }
  const male = info.ports.find((p) => /^(R|M\d|G.*公|NPT.*公)/.test(p.spec) && !/^Rc/.test(p.spec))
  const tube = tubeOf(info.ports.find((p) => /快插/.test(p.spec))?.spec)
  switch (info.category) {
    case 'fitting': {
      if (!tube) return undefined
      const tubes = info.ports.filter((p) => /快插/.test(p.spec)).length
      const form = /彎頭/.test(info.name) ? 'elbow' : /三通|Y 型/.test(info.name) || tubes >= 3 || (male && tubes >= 2) ? 'tee' : 'straight'
      return { kind: 'fitting', form, tube, std, ...(male && { thread: sizeOf(male.spec) }) }
    }
    case 'silencer': {
      const size = sizeOf(male?.spec)
      return size && { kind: 'silencer', thread: size, std }
    }
    case 'speedController': {
      const size = sizeOf(male?.spec)
      return size && tube ? { kind: 'speedController', thread: size, tube, std } : undefined
    }
    case 'valve': {
      const main = sizeOf(info.ports.find((p) => p.name === 'P')?.spec)
      const exhaust = sizeOf(info.ports.find((p) => p.exhaust)?.spec)
      if (!main) return undefined
      const fn: ValveFunction = /3\/2/.test(info.name)
        ? '32NC'
        : /氣控/.test(info.name)
          ? '52Pilot'
          : /中位封閉/.test(info.name)
            ? '53Closed'
            : /中位排氣/.test(info.name)
              ? '53Exhaust'
              : /中位加壓/.test(info.name)
                ? '53Pressure'
                : /雙電控/.test(info.name)
                  ? '52Double'
                  : '52Single'
      return { kind: 'valve', fn, thread: main, std, ...(exhaust && exhaust !== main && { exhaust }) }
    }
    case 'cylinder':
      return info.bore && info.stroke ? { kind: 'cylinder', bore: info.bore, stroke: info.stroke, single: /單動/.test(info.name), std } : undefined
    case 'frl': {
      const size = sizeOf(info.ports.find((p) => p.name === 'IN')?.spec)
      if (!size) return undefined
      const unit: FrlUnit = /三點|二點/.test(info.name)
        ? 'combo'
        : /過濾調壓/.test(info.name)
          ? 'filterRegulator'
          : /調壓/.test(info.name)
            ? 'regulator'
            : /給油/.test(info.name)
              ? 'lubricator'
              : 'filter'
      return { kind: 'frl', unit, thread: size, std }
    }
    case 'manifold':
      return info.stations ? { kind: 'manifold', stations: info.stations, thread: info.series === '4V100' ? 'M5' : '1/8', std } : undefined
    default:
      return undefined
  }
}
