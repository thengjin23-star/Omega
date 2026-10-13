import { useEffect, useState } from 'react'
import { useAiSettings } from '../ai/aiSettings'
import { DEFAULT_GEMINI_MODEL, listGeminiModels, pickDefaultModel, type GeminiModel } from '../ai/gemini'
import { Button } from './ui'

const inputClass = 'mt-0.5 h-8 w-full rounded-md border border-slate-300 px-2 text-sm text-slate-800'

/** 設定：AI（Google Gemini）的 API 金鑰與模型。金鑰只存在這台電腦的瀏覽器，不會放進備份檔 */
export function AiSettingsSection() {
  const { apiKey, model, load, update } = useAiSettings()
  /** 輸入中的金鑰（undefined = 用已存的） */
  const [draft, setDraft] = useState<string>()
  const key = draft ?? apiKey
  const [models, setModels] = useState<GeminiModel[]>([])
  const [status, setStatus] = useState<{ kind: 'info' | 'error'; text: string }>()
  const [testing, setTesting] = useState(false)
  useEffect(() => {
    void load()
  }, [load])

  const test = async () => {
    setTesting(true)
    setStatus(undefined)
    try {
      await update({ apiKey: key.trim() })
      const list = await listGeminiModels(key.trim())
      setModels(list)
      const keep = list.some((m) => m.id === model)
      const picked = keep ? model : pickDefaultModel(list)
      if (picked && picked !== model) await update({ model: picked })
      setStatus({ kind: 'info', text: `連線成功：可用 ${list.length} 個模型，使用「${picked ?? model}」。` })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <section aria-label="AI（Google Gemini）">
      <h3 className="mb-2 text-sm font-semibold text-slate-700">AI 判斷（Google Gemini）</h3>
      <div className="space-y-2 rounded-md border border-slate-200 p-3">
        <p className="text-xs leading-5 text-slate-500">
          用來「依敘述產生」模組、判斷產品庫沒有的型號。到{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-blue-600 underline">
            Google AI Studio
          </a>{' '}
          用 Google 帳號免費建立 API 金鑰，貼在下面。
        </p>
        <label className="block text-xs text-slate-500">
          API 金鑰
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => key.trim() !== apiKey && void update({ apiKey: key.trim() })}
            placeholder="AIza…"
            aria-label="Gemini API 金鑰"
            className={inputClass}
          />
        </label>
        <div className="flex items-end gap-2">
          <label className="block flex-1 text-xs text-slate-500">
            模型
            {models.length ? (
              <select value={model} onChange={(e) => void update({ model: e.target.value })} className={inputClass} aria-label="Gemini 模型">
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={model}
                onChange={(e) => void update({ model: e.target.value.trim() || DEFAULT_GEMINI_MODEL })}
                aria-label="Gemini 模型"
                className={inputClass}
              />
            )}
          </label>
          <Button size="sm" disabled={!key.trim() || testing} onClick={() => void test()}>
            {testing ? '測試中…' : '測試連線'}
          </Button>
        </div>
        {status && (
          <p role="status" className={`rounded p-1.5 text-xs ${status.kind === 'error' ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800'}`}>
            {status.text}
          </p>
        )}
        <p className="text-[11px] leading-4 text-slate-400">
          金鑰只存在這台電腦的瀏覽器裡，不會放進備份檔或匯出的檔案。使用時會把你輸入的敘述、型號與產品庫的型號清單送到 Google 分析；
          免費方案的資料可能被 Google 用來改善服務，敏感的客戶資料請改用付費方案的金鑰。
        </p>
      </div>
    </section>
  )
}
