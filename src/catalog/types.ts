import type { ParamValue } from '../engine/types'
import type { Vec3 } from '../geometry/vec3'
import type { PortSpec } from '../threads'
import type { GenericSpec } from './generic/genericParts'

export type { Vec3 }

/**
 * 埠的座標系（零件座標，單位 mm）
 * - origin：母牙取孔口中心；公牙取螺紋根部（肩面）中心；安裝面取基準孔的孔口中心
 * - axis：朝外的單位向量（母牙朝孔外、公牙朝螺紋尖端）
 * - ref：與 axis 垂直的單位向量，作為繞軸旋轉的基準（安裝面靠它決定方向）
 */
export interface PortFrame {
  origin: Vec3
  axis: Vec3
  ref: Vec3
}

/** 鎖合後能否繞軸旋轉：螺紋可自由轉；安裝面固定，或只允許 steps 等分（例如 2 = 可轉 180°） */
export type PortRotation = 'free' | 'fixed' | { steps: number }

export interface ProductPort {
  /** 固定不變的識別碼（模組的鎖合以它引用） */
  id: string
  /** 顯示名稱，例如 P、A、IN、1 */
  name: string
  /** 可以暫時留空：漸進式建檔，之後再補 */
  spec?: PortSpec
  frame: PortFrame
  rotation: PortRotation
  /** 由 3D 模型自動量測到的資訊；auto = 匯入時自動找到（使用者還沒確認） */
  detected?: { shape: 'hole' | 'boss' | 'plane'; diameter?: number; auto?: boolean }
}

export type ProductCategory =
  | 'fitting'
  | 'silencer'
  | 'speedController'
  | 'valve'
  | 'cylinder'
  | 'frl'
  | 'manifold'
  | 'other'

export const CATEGORY_LABEL: Record<ProductCategory, string> = {
  fitting: '接頭',
  silencer: '消音器',
  speedController: '速度控制閥',
  valve: '閥',
  cylinder: '氣缸',
  frl: '三點組合',
  manifold: '集裝座',
  other: '其他',
}

export type CadFormat = 'step' | 'iges'

export interface ProductSource {
  fileName: string
  /** 原始檔案的 SHA-256：同一個檔案再次匯入時，用它認出已記住的產品 */
  sha256: string
  format: CadFormat
  bytes: number
}

/**
 * 產品的氣動功能：它在迴路圖中是哪一種元件、怎麼模擬。
 * - type：引擎元件 type（例如 'valve52Single'），或特殊值：
 *   'fitting'（接頭、轉接頭：氣流直接通過，迴路圖以管線表示）、
 *   'manifold'（集裝座：迴路圖中不單獨畫出）
 * - portMap：功能埠 → 產品埠 id（3D 模擬與「由模組產生迴路圖」用；可只對應一部分）
 * - params：元件參數（例如缸徑、行程）
 */
export interface ProductPneumatic {
  type: string
  portMap: Record<string, string>
  params?: Record<string, ParamValue>
  /** 氣缸的可動件（3D 模擬時沿 axis 移動「活塞位置 × 行程」）：網格零件的索引與伸出方向（產品座標） */
  motion?: { parts: number[]; axis: Vec3 }
}

export interface Product {
  id: string
  /** 型號（預設取檔名） */
  modelCode: string
  /** 名稱（可留空，顯示時改用型號） */
  name: string
  category: ProductCategory
  source: ProductSource
  ports: ProductPort[]
  /** 氣動功能；沒有設定時由分類與埠名自動判斷（見 catalog/pneumatic.ts） */
  pneumatic?: ProductPneumatic
  /** 廠牌，例如 SMC、AirTAC */
  maker?: string
  /** 系列 */
  series?: string
  /** 單價（選填；有填時 BOM 會算出小計與合計） */
  price?: number
  notes?: string
  /** 通用 3D：系統依尺寸產生的示意模型（不是原廠 3D 檔），記下規格以便沿用 */
  generic?: GenericSpec
  createdAt: number
  updatedAt: number
}

export const productLabel = (p: Pick<Product, 'modelCode' | 'name'>): string => p.name || p.modelCode

/** 產品是否有 3D 檔（沒有 3D 的產品只有型號，source.bytes 為 0） */
export const hasModel = (p: Pick<Product, 'source'>): boolean => p.source.bytes > 0
