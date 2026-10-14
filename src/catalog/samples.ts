import type { Vec3 } from '../geometry/vec3'
import { parseSpec, type InterfaceSpec } from '../threads'
import type { ParamValue } from '../engine/types'
import type { CatalogStore } from './db'
import { importCadFile, type CadParser } from './importer'
import { matchPortsByName } from './pneumatic'
import { makePort } from './ports'
import type { ProductCategory, ProductPneumatic, ProductPort } from './types'

/** public/samples/manifest.json 的格式（由 scripts/make-sample-parts.mjs 產生） */
export interface SamplePortDef {
  name: string
  /** 規格文字，例如 Rc1/8、R1/8、Ø6 快插、安裝面：… */
  spec: string
  role?: InterfaceSpec['role']
  shape: 'hole' | 'boss'
  origin: Vec3
  axis: Vec3
  /** 繞軸旋轉的基準（安裝面靠它決定方向；沒給時用預設） */
  ref?: Vec3
  /** 被哪個埠（名稱）封住：見 ProductPort.sealedBy */
  sealedBy?: string
}

/** 範例零件的氣動功能；ports 以埠名稱對應（未提供時依名稱自動配對） */
export interface SamplePneumaticDef {
  type: string
  ports?: Record<string, string>
  params?: Record<string, ParamValue>
}

export interface SamplePartDef {
  file: string
  modelCode: string
  name: string
  category: ProductCategory
  ports: SamplePortDef[]
  pneumatic?: SamplePneumaticDef
}

export interface SampleManifest {
  version: number
  parts: SamplePartDef[]
}

export function portsFromDefs(defs: readonly SamplePortDef[]): ProductPort[] {
  const ports = defs.map((d) => {
    const parsed = parseSpec(d.spec, { gender: d.shape === 'hole' ? 'female' : 'male', interfaceRole: d.role })
    if (!parsed.ok) throw new Error(`範例埠「${d.name}」的規格錯誤：${parsed.error}`)
    return makePort({ name: d.name, spec: parsed.spec, origin: d.origin, axis: d.axis, ref: d.ref, detected: { shape: d.shape } })
  })
  // 封住的埠：名稱 → id
  return ports.map((p, i) => {
    const by = defs[i].sealedBy && ports.find((q) => q.name === defs[i].sealedBy)
    return by ? { ...p, sealedBy: by.id } : p
  })
}

/** 把範例的氣動功能（以埠名稱對應）轉成產品資料（以埠 id 對應） */
export function pneumaticFromDef(def: SamplePneumaticDef, ports: readonly ProductPort[]): ProductPneumatic {
  const portMap = def.ports
    ? Object.fromEntries(
        Object.entries(def.ports).flatMap(([fn, name]) => {
          const port = ports.find((p) => p.name === name)
          return port ? [[fn, port.id]] : []
        }),
      )
    : matchPortsByName(def.type, ports)
  return def.params ? { type: def.type, portMap, params: { ...def.params } } : { type: def.type, portMap }
}

/**
 * 安裝範例零件庫。已存在的範例（同一個檔案）若已經有埠設定就保留使用者的版本。
 * readFile 由呼叫端提供：瀏覽器用 fetch，測試用 fs。
 */
export async function installSamples(
  store: CatalogStore,
  manifest: SampleManifest,
  readFile: (file: string) => Promise<Uint8Array>,
  parse: CadParser,
): Promise<{ added: number; existing: number }> {
  let added = 0
  let existing = 0
  for (const def of manifest.parts) {
    const { product, status } = await importCadFile(store, def.file, await readFile(def.file), parse)
    if (status === 'existing' && product.ports.length > 0) {
      existing++
      continue
    }
    // 範例改版（檔案內容不同）：舊版留著（模組可能用到），型號加註「舊版」以免與新版同名
    if (status === 'new')
      for (const old of await store.listProducts())
        if (old.id !== product.id && old.modelCode === def.modelCode && old.source?.fileName === def.file)
          await store.putProduct({ ...old, modelCode: `${def.modelCode}（舊版）`, updatedAt: Date.now() })
    const ports = portsFromDefs(def.ports)
    await store.putProduct({
      ...product,
      modelCode: def.modelCode,
      name: def.name,
      category: def.category,
      ports,
      ...(def.pneumatic && { pneumatic: pneumaticFromDef(def.pneumatic, ports) }),
      updatedAt: Date.now(),
    })
    if (status === 'new') added++
    else existing++
  }
  return { added, existing }
}
