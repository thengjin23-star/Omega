import type { ProductMap } from '../assembly/moduleOps'
import type { ModuleDoc } from '../assembly/types'
import type { Product } from '../catalog/types'

/**
 * 寫在 STEP 檔註解裡的模組資料。STEP（ISO 10303-21）允許在任何空白處放 `/* … *\/` 註解，
 * 其他 CAD 會忽略它；本程式重新匯入時用它還原每個零件、位置與鎖合，而不是把整個檔案當成一個零件。
 */
export const STEP_META_MARK = 'PNEUMATIC-SIM-MODULE'
export const STEP_META_VERSION = 1

export interface StepModuleMeta {
  version: typeof STEP_META_VERSION
  /** 匯出當下的模組（零件、根零件位置、鎖合、PU 管、設定） */
  module: ModuleDoc
  /** 寫進 STEP 的零件實例：實例 id → 檔案頂層的第幾個零件（0 起算） */
  roots: Record<string, number>
  /** 模組用到的產品（埠、氣動功能、型號…；不含 3D 檔本身） */
  products: Record<string, Product>
  /** 產品在 STEP 中的顏色（#rrggbb）：從檔案取出零件時沿用 */
  colors?: Record<string, string>
}

export function buildStepMeta(doc: ModuleDoc, products: ProductMap, roots: Record<string, number>, colors?: Record<string, string>): StepModuleMeta {
  const used: Record<string, Product> = {}
  for (const inst of doc.instances) {
    const p = products[inst.productId]
    if (p) used[p.id] = p
  }
  return { version: STEP_META_VERSION, module: doc, roots, products: used, ...(colors && { colors }) }
}

const LINE = 76

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 把模組資料放進 STEP 檔：在 HEADER 前加一段註解（base64，內容不會出現註解結束符號） */
export function embedStepMeta(step: Uint8Array, meta: StepModuleMeta): Uint8Array {
  const text = new TextDecoder('latin1').decode(step.subarray(0, Math.min(step.length, 4096)))
  const at = text.indexOf('HEADER;')
  if (at < 0) throw new Error('STEP 檔格式不正確（找不到 HEADER）')
  const b64 = toBase64(new TextEncoder().encode(JSON.stringify(meta)))
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += LINE) lines.push(b64.slice(i, i + LINE))
  const block = new TextEncoder().encode(`/* ${STEP_META_MARK} ${STEP_META_VERSION}\n${lines.join('\n')}\n*/\n`)
  // HEADER 之前都是 ASCII，字元位置就是位元組位置
  const out = new Uint8Array(step.length + block.length)
  out.set(step.subarray(0, at), 0)
  out.set(block, at)
  out.set(step.subarray(at), at + block.length)
  return out
}

/** 讀出 STEP 檔裡的模組資料；不是本程式匯出的檔案（或內容損毀）回傳 undefined */
export function readStepMeta(step: Uint8Array): StepModuleMeta | undefined {
  const head = new TextDecoder('latin1').decode(step.subarray(0, Math.min(step.length, 4096)))
  // 註解在 HEADER 之前（註解很長時 HEADER 不在前 4 KB 內）
  const start = head.indexOf(`/* ${STEP_META_MARK} `)
  const header = head.indexOf('HEADER;')
  if (start < 0 || (header >= 0 && start > header)) return undefined
  // 註解可能很長：從開頭找到結束符號
  const bodyStart = head.indexOf('\n', start) + 1
  if (bodyStart <= 0) return undefined
  let end = -1
  for (let i = bodyStart; i < step.length - 1; i++) {
    if (step[i] === 0x2a && step[i + 1] === 0x2f) {
      end = i
      break
    }
  }
  if (end < 0) return undefined
  try {
    const b64 = new TextDecoder('latin1').decode(step.subarray(bodyStart, end)).replace(/\s+/g, '')
    const meta = JSON.parse(new TextDecoder().decode(fromBase64(b64))) as StepModuleMeta
    if (meta.version !== STEP_META_VERSION || !meta.module || !Array.isArray(meta.module.instances) || !meta.products || !meta.roots) return undefined
    return meta
  } catch {
    return undefined
  }
}
