import { create } from 'zustand'
import { getCatalog } from '../catalog/library'
import { DEFAULT_GEMINI_MODEL } from './gemini'

/**
 * AI（Gemini）設定。API 金鑰只存在這台電腦的瀏覽器裡，另外存放（key = 'ai'），
 * 不會放進「完整備份」或匯出的產品庫、模組檔。
 */
export interface AiSettings {
  apiKey: string
  model: string
}

const KEY = 'ai'

interface AiSettingsState extends AiSettings {
  loaded: boolean
  load(): Promise<void>
  update(patch: Partial<AiSettings>): Promise<void>
}

let loading: Promise<void> | undefined

export const useAiSettings = create<AiSettingsState>()((set, get) => ({
  apiKey: '',
  model: DEFAULT_GEMINI_MODEL,
  loaded: false,
  load() {
    loading ??= (async () => {
      try {
        const saved = (await (await getCatalog()).getSetting(KEY)) as Partial<AiSettings> | undefined
        set({ apiKey: saved?.apiKey ?? '', model: saved?.model || DEFAULT_GEMINI_MODEL, loaded: true })
      } catch {
        set({ loaded: true })
      }
    })()
    return loading
  },
  async update(patch) {
    const next = { apiKey: patch.apiKey ?? get().apiKey, model: patch.model ?? get().model }
    set(next)
    await (await getCatalog()).putSetting(KEY, next)
  },
}))

/** 已經設定好金鑰 */
export const aiReady = (s: Pick<AiSettings, 'apiKey'>) => s.apiKey.trim().length > 0
