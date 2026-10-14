/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readCad, type OcctModule } from '../cad'
import type { CadParser } from '../importer'
import type { SampleManifest } from '../samples'

const require = createRequire(import.meta.url)
let occt: Promise<OcctModule> | undefined

/** 在 Node 中直接使用 occt-import-js（瀏覽器中則由 Web Worker 執行） */
export function nodeOcct(): Promise<OcctModule> {
  return (occt ??= (require('occt-import-js') as () => Promise<OcctModule>)())
}

export const nodeParser: CadParser = async (bytes, format) => readCad(await nodeOcct(), bytes, format)

export const samplesDir = fileURLToPath(new URL('../../../public/samples/', import.meta.url))
export const readSample = async (file: string): Promise<Uint8Array> => new Uint8Array(readFileSync(samplesDir + file))
export const sampleManifest = (): SampleManifest => JSON.parse(readFileSync(samplesDir + 'manifest.json', 'utf8'))
/** 測試用的 STEP 檔（不在範例零件庫中） */
export const readFixture = async (file: string): Promise<Uint8Array> => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url))))

let dbCounter = 0
/** 每個測試使用獨立的資料庫名稱 */
export const uniqueDbName = () => `test-catalog-${Date.now()}-${dbCounter++}`
