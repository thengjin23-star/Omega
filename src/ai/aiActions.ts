import type { Product } from '../catalog/types'
import type { CodeInterpreter } from '../module-ui/moduleStore'
import { aiReady, useAiSettings } from './aiSettings'
import { GeminiError, geminiJson, listGeminiModels, pickDefaultModel } from './gemini'
import { RESULT_SCHEMA, SYSTEM_PROMPT, codesPrompt, describePrompt, genericFromAi, planFromAi, type AiResult, type PlanRow } from './partsAi'

/** 用設定的金鑰與模型呼叫；模型不存在（404）時改用帳號可用的最新 Flash 模型再試一次 */
async function ask(prompt: string, signal?: AbortSignal): Promise<AiResult> {
  const settings = useAiSettings.getState()
  await settings.load()
  const { apiKey, model } = useAiSettings.getState()
  if (!aiReady({ apiKey })) throw new GeminiError('還沒有設定 Gemini API 金鑰：請到「設定」貼上金鑰')
  const run = (m: string) => geminiJson<AiResult>({ apiKey, model: m, system: SYSTEM_PROMPT, prompt, schema: RESULT_SCHEMA, signal })
  try {
    return normalize(await run(model))
  } catch (err) {
    if (!(err instanceof GeminiError) || err.status !== 404) throw err
    const picked = pickDefaultModel(await listGeminiModels(apiKey, signal))
    if (!picked || picked === model) throw err
    await useAiSettings.getState().update({ model: picked })
    return normalize(await run(picked))
  }
}

const normalize = (r: AiResult): AiResult => ({ moduleName: r?.moduleName ?? null, parts: Array.isArray(r?.parts) ? r.parts : [], notes: Array.isArray(r?.notes) ? r.notes.filter((n) => typeof n === 'string') : [] })

/** 敘述 → 零件清單 */
export async function analyzeDescription(description: string, products: readonly Product[], signal?: AbortSignal): Promise<{ result: AiResult; rows: PlanRow[] }> {
  const result = await ask(describePrompt(description, products), signal)
  return { result, rows: planFromAi(result, products) }
}

/** 產品庫沒有的型號 → 通用零件規格 */
export const interpretCodes: CodeInterpreter = async (codes) => genericFromAi(await ask(codesPrompt(codes)), codes)
