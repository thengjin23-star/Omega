import type { SamplePortDef } from '../samples'
import type { GenericSpec } from './genericParts'
import type { GenericMessage, GenericRequest } from './generic.worker'

/** 在背景執行緒產生通用零件的 STEP 檔與埠 */
export function buildGenericInWorker(specs: GenericSpec[], onProgress?: (done: number, total: number) => void): Promise<{ bytes: Uint8Array; ports: SamplePortDef[] }[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./generic.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<GenericMessage>) => {
      const m = event.data
      if (m.type === 'progress') onProgress?.(m.done, m.total)
      else if (m.type === 'done') {
        worker.terminate()
        resolve(m.parts)
      } else if (m.type === 'error') {
        worker.terminate()
        reject(new Error(`無法產生通用 3D：${m.error}`))
      }
    }
    worker.onerror = () => {
      worker.terminate()
      reject(new Error('通用 3D 元件載入失敗，請確認網路連線後再試'))
    }
    worker.postMessage({ specs } satisfies GenericRequest)
  })
}
