import type { StepPick } from './stepAssembly'
import type { StepMessage, StepRequest } from './step.worker'

export type StepProgress = { stage: 'loading' } | { stage: 'parts'; done: number; total: number }

/** 在背景執行緒執行一個 STEP 工作；signal 中止時立即結束 worker */
function runStepWorker<T>(request: StepRequest, onMessage: (m: StepMessage) => T | undefined, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' })
    const finish = () => {
      worker.terminate()
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      finish()
      reject(new DOMException('已取消', 'AbortError'))
    }
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort)
    worker.onmessage = (event: MessageEvent<StepMessage>) => {
      const m = event.data
      if (m.type === 'error') {
        finish()
        reject(new Error(m.error))
        return
      }
      const result = onMessage(m)
      if (result !== undefined) {
        finish()
        resolve(result)
      }
    }
    worker.onerror = () => {
      finish()
      reject(new Error('STEP 元件載入失敗，請確認網路連線後再試'))
    }
    // 原始檔會被複製一份到 worker（呼叫端的資料不受影響）
    worker.postMessage(request)
  })
}

/** 在背景執行緒產生 STEP 組立檔 */
export function exportAssemblyStep(request: Extract<StepRequest, { files: unknown }>, onProgress: (p: StepProgress) => void, signal?: AbortSignal): Promise<Uint8Array> {
  return runStepWorker(
    request,
    (m) => {
      if (m.type === 'loading') onProgress({ stage: 'loading' })
      else if (m.type === 'progress') onProgress({ stage: 'parts', done: m.done, total: m.total })
      else if (m.type === 'done') return m.bytes
      return undefined
    },
    signal,
  )
}

/** 在背景執行緒把 STEP 檔拆成數個零件（各自一個 STEP 檔） */
export function extractStepPartsInWorker(bytes: Uint8Array, picks: StepPick[]): Promise<Uint8Array[]> {
  return runStepWorker({ kind: 'extract', bytes, picks }, (m) => (m.type === 'extracted' ? m.files : undefined))
}
