import { readFileSync } from 'node:fs'
import occtimportjs from 'occt-import-js'
import { describe, expect, it } from 'vitest'
import { computeTransforms } from '../../assembly/moduleOps'
import { PRODUCTS, valveIsland } from '../../assembly/__tests__/sampleModules'
import { buildStepMeta, embedStepMeta, readStepMeta, STEP_META_MARK } from '../stepMeta'

const VALVE = new Uint8Array(readFileSync('public/samples/DEMO-VALVE-52-01.step'))

describe('STEP 檔裡的模組資料', () => {
  const b = valveIsland()
  const roots = Object.fromEntries(b.doc.instances.map((i, k) => [i.id, k]))
  const meta = buildStepMeta({ ...b.doc, name: '閥島「測試」*/ 註解' }, PRODUCTS, roots)

  it('寫在 HEADER 前的註解裡，讀回來完全相同（名稱含中文與註解符號也沒問題）', () => {
    const bytes = embedStepMeta(VALVE, meta)
    const text = new TextDecoder('latin1').decode(bytes.subarray(0, 200))
    expect(text.startsWith('ISO-10303-21;')).toBe(true)
    expect(text).toContain(`/* ${STEP_META_MARK} 1`)
    expect(readStepMeta(bytes)).toEqual(meta)
    // 只用到的產品
    expect(Object.keys(meta.products).sort()).toEqual([...new Set(b.doc.instances.map((i) => i.productId))].sort())
  })

  it('其他 CAD 讀取器照常讀得到幾何（註解被忽略）', async () => {
    const occt = await occtimportjs()
    const plain = occt.ReadStepFile(VALVE, null) as { success: boolean; meshes: unknown[] }
    const tagged = occt.ReadStepFile(embedStepMeta(VALVE, meta), null) as { success: boolean; meshes: unknown[] }
    expect(tagged.success).toBe(true)
    expect(tagged.meshes.length).toBe(plain.meshes.length)
  })

  it('不是本程式匯出的檔案、或資料損毀：沒有模組資料', () => {
    expect(readStepMeta(VALVE)).toBeUndefined()
    const bytes = embedStepMeta(VALVE, meta)
    const text = new TextDecoder('latin1').decode(bytes)
    const broken = new TextEncoder().encode(text.replace(/(PNEUMATIC-SIM-MODULE 1\n)./, '$1#'))
    expect(readStepMeta(broken)).toBeUndefined()
  })

  it('位置資料與模組相同', () => {
    const back = readStepMeta(embedStepMeta(VALVE, meta))!
    expect(computeTransforms(back.module, back.products).transforms).toEqual(computeTransforms(b.doc, PRODUCTS).transforms)
  })
})
