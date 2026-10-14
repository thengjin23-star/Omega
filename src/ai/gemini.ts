/**
 * Google Gemini API（直接從瀏覽器呼叫，金鑰只存在使用者自己的瀏覽器）。
 * 文件：generateContent 以 responseSchema 要求 JSON 輸出。
 */
const BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** 沒有選模型時使用；「測試連線」會改成帳號可用的最新 Flash 模型 */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'

/** Gemini 的回應格式（OpenAPI 子集） */
export type GeminiSchema =
  | { type: 'OBJECT'; properties: Record<string, GeminiSchema>; required?: string[]; propertyOrdering?: string[]; description?: string; nullable?: boolean }
  | { type: 'ARRAY'; items: GeminiSchema; description?: string; nullable?: boolean }
  | { type: 'STRING'; enum?: string[]; description?: string; nullable?: boolean }
  | { type: 'INTEGER' | 'NUMBER' | 'BOOLEAN'; description?: string; nullable?: boolean }

export class GeminiError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GeminiError'
    this.status = status
  }
}

/** 把 API 的錯誤轉成看得懂的中文 */
async function explain(res: Response): Promise<GeminiError> {
  let detail = ''
  let reason = ''
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string; details?: { reason?: string }[] } }
    detail = body.error?.message ?? ''
    reason = body.error?.details?.find((d) => d.reason)?.reason ?? body.error?.status ?? ''
  } catch {
    /* 不是 JSON */
  }
  if (reason === 'API_KEY_INVALID' || /API key not valid/i.test(detail)) return new GeminiError('API 金鑰無效：請到「設定」重新貼上 Gemini API 金鑰', res.status)
  if (res.status === 403) return new GeminiError(`金鑰沒有使用 Gemini API 的權限（${detail || reason}）`, res.status)
  if (res.status === 404) return new GeminiError(`找不到模型（${detail}）：請到「設定」按「測試連線」重新選擇模型`, res.status)
  if (res.status === 429) return new GeminiError('超過 Gemini 的使用額度或頻率限制，請稍後再試', res.status)
  if (res.status >= 500) return new GeminiError('Gemini 服務暫時無法使用，請稍後再試', res.status)
  return new GeminiError(`Gemini 回應錯誤 ${res.status}：${detail || reason || res.statusText}`, res.status)
}

async function call(url: string, apiKey: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, ...(init.headers ?? {}) } })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new GeminiError('無法連線到 Gemini：請確認網路連線')
  }
  if (!res.ok) throw await explain(res)
  return res
}

export interface GeminiRequest {
  apiKey: string
  model: string
  system: string
  prompt: string
  schema: GeminiSchema
  signal?: AbortSignal
}

/** 呼叫 generateContent，回傳依 schema 解析好的 JSON */
export async function geminiJson<T>({ apiKey, model, system, prompt, schema, signal }: GeminiRequest): Promise<T> {
  const id = model.replace(/^models\//, '')
  const res = await call(
    `${BASE}/models/${encodeURIComponent(id)}:generateContent`,
    apiKey,
    {
      method: 'POST',
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 },
      }),
    },
    signal,
  )
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]
    promptFeedback?: { blockReason?: string }
  }
  if (body.promptFeedback?.blockReason) throw new GeminiError(`Gemini 拒絕回答（${body.promptFeedback.blockReason}）`)
  const candidate = body.candidates?.[0]
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
  if (!text) throw new GeminiError(`Gemini 沒有回答${candidate?.finishReason ? `（${candidate.finishReason}）` : ''}，請換個說法再試`)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new GeminiError(candidate?.finishReason === 'MAX_TOKENS' ? 'Gemini 的回答太長被截斷，請把敘述分成幾次' : 'Gemini 的回答格式不正確，請再試一次')
  }
}

export interface GeminiModel {
  /** 例如 gemini-2.5-flash */
  id: string
  displayName: string
}

/** 帳號可用、支援 generateContent 的模型 */
export async function listGeminiModels(apiKey: string, signal?: AbortSignal): Promise<GeminiModel[]> {
  const res = await call(`${BASE}/models?pageSize=1000`, apiKey, {}, signal)
  const body = (await res.json()) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] }
  return (body.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(m.name))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), displayName: m.displayName ?? m.name }))
}

/** 挑預設模型：版本最新的 Flash 正式版（沒有 -preview、-exp 等字尾），其次 gemini-flash-latest，再其次任何 Flash */
export function pickDefaultModel(models: readonly GeminiModel[]): string | undefined {
  const version = (id: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0)
  const stable = models.filter((m) => /^gemini-\d+(\.\d+)?-flash$/.test(m.id)).sort((a, b) => version(b.id) - version(a.id))
  if (stable.length) return stable[0].id
  if (models.some((m) => m.id === 'gemini-flash-latest')) return 'gemini-flash-latest'
  const flash = models.filter((m) => /flash/.test(m.id) && !/lite|image|tts|audio|live|embedding/.test(m.id)).sort((a, b) => version(b.id) - version(a.id))
  return flash[0]?.id ?? models[0]?.id
}
