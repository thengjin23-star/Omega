import type { Params, Sequence } from '../engine'
import type { SizingSettings } from '../sizing/sizing'

/** 指向某個零件實例上的某個埠 */
export interface PortRef {
  instance: string
  port: string
}

/** 模組中的一個零件（同一個產品可以出現多次） */
export interface ModuleInstance {
  id: string
  productId: string
  /**
   * 這個零件在模組中的應用參數（氣缸代號、線圈訊號、負載…），覆蓋產品氣動功能的參數。
   * 同一個產品在不同模組、不同位置可以不同。
   */
  params?: Params
}

/**
 * 埠對埠鎖合：子零件的埠與父零件的埠原點重合、軸線相反，並繞軸旋轉 angle 度。
 * 鎖合關係構成樹（森林），子零件的位置由父零件推導。
 */
export interface Mate {
  id: string
  parent: PortRef
  child: PortRef
  angle: number
}

/** PU 管：接在兩個快插埠之間（不影響零件位置） */
export interface ModuleTube {
  id: string
  a: PortRef
  b: PortRef
  /** 管外徑（mm） */
  od: number
  /** 顯示用的管徑，例如「Ø6」「Ø1/4"」 */
  label?: string
  /** 管長（mm）；未指定時依兩端位置估算 */
  length?: number
}

/** 模擬用的供氣口：接在哪個埠、供氣壓力（MPa） */
export interface ModuleSupply extends PortRef {
  pressure?: number
}

/** 4×4 矩陣，行優先（column-major，與 three.js Matrix4.elements 相同） */
export type Mat4 = number[]

/** 圖面的正面：觀察者位在模組的哪一側（以模組的座標軸表示） */
export type FrontSide = '-y' | '+y' | '+x' | '-x' | '+z' | '-z'

/** 圖面設定：記在模組裡，下次產生圖面時沿用 */
export interface DrawingInfo {
  number?: string
  revision?: string
  notes?: string
  front?: FrontSide
  paper?: 'A3' | 'A4'
  projection?: 'third' | 'first'
  hidden?: boolean
  dimensions?: boolean
  balloons?: boolean
  portTags?: boolean
  iso?: boolean
  /** 附選型計算書（另一張圖紙） */
  sizingSheet?: boolean
}

/** 示意圖的視角：目前 3D 畫面、六個正面方向或等角 */
export type IllustrationView = 'current' | FrontSide | 'iso'

/** 示意圖設定（著色 3D 圖＋型號標註）：記在模組裡，下次打開沿用 */
export interface IllustrationInfo {
  view?: IllustrationView
  /** view 為 'current' 時記下的視線方向（相機看的方向）與畫面上方 */
  camera?: { dir: [number, number, number]; up: [number, number, number] }
  /** 零件顏色：依 3D 檔，或統一灰色（型錄風格） */
  color?: 'model' | 'gray'
  /** 零件輪廓線 */
  edges?: boolean
  /** 標註內容：型號、型號＋數量、型號＋名稱 */
  label?: 'code' | 'code-qty' | 'code-name'
  /** 標註的字高（示意圖像素，預設 26）；PNG、PDF 依同樣比例 */
  fontSize?: number
  /** 不標註的型號（群組鍵：產品 id，PU 管為 tube:管徑） */
  hidden?: string[]
  /** 自訂的標註文字（群組鍵 → 文字） */
  texts?: Record<string, string>
  /** 拖曳過的標註位置（標籤左上角，示意圖座標）；換視角或按「重新排列」時清除 */
  positions?: Record<string, [number, number]>
  /** 圖片下方加上模組名稱、客戶與日期 */
  footer?: boolean
  /** 爆炸圖：鎖合的零件沿接口方向拉開的距離（mm），並畫出裝配線；0 或未設定 = 組好的樣子 */
  explode?: number
}

export interface ModuleDoc {
  id: string
  name: string
  customer?: string
  notes?: string
  drawing?: DrawingInfo
  /** 示意圖設定 */
  illustration?: IllustrationInfo
  /** 依型號清單自動組裝時的清單原文（再打開時可以修改後重新組裝） */
  partsList?: string
  instances: ModuleInstance[]
  mates: Mate[]
  /** PU 管 */
  tubes?: ModuleTube[]
  /** 模擬用的供氣口 */
  supply?: ModuleSupply
  /** 程序控制（3D 模擬時執行；產生迴路圖時一併帶入） */
  sequence?: Sequence
  /** 選型計算的設定（每分鐘循環數、計算壓力） */
  sizing?: SizingSettings
  /** 根零件（沒有父零件）的位置；鎖合的零件由 mates 推導，不存在這裡 */
  placements: Record<string, Mat4>
  createdAt: number
  updatedAt: number
}
