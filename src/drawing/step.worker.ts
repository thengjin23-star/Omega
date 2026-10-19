/**
 * STEP 組立檔輸出、拆開 STEP 檔（OpenCascade／replicad，WASM 約 23 MB）：第一次使用時下載，之後由 service worker 快取。
 * 每次使用一個新的 worker，完成或取消後結束，釋放 OpenCascade 佔用的記憶體。
 */
import { setOC } from 'replicad'
import opencascade from 'replicad-opencascadejs'
import wasmUrl from 'replicad-opencascadejs/wasm?url'
import { buildAssemblyStep, extractStepParts, type StepPart, type StepPick, type StepTube } from './stepAssembly'

export type StepRequest =
  | { kind?: 'assembly'; files: Record<string, Uint8Array>; parts: StepPart[]; tubes?: StepTube[] }
  /** 把 STEP 檔拆成數個零件，各自寫成 STEP 檔 */
  | { kind: 'extract'; bytes: Uint8Array; picks: StepPick[] }

export type StepMessage =
  | { type: 'loading' }
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; bytes: Uint8Array }
  | { type: 'extracted'; files: Uint8Array[] }
  | { type: 'error'; error: string }

const post = (message: StepMessage, transfer: Transferable[] = []) => self.postMessage(message, { transfer })

self.onmessage = async (event: MessageEvent<StepRequest>) => {
  const request = event.data
  try {
    post({ type: 'loading' })
    // OpenCascade 會輸出大量記錄訊息：關掉
    const oc = await opencascade({ locateFile: () => wasmUrl, print: () => undefined, printErr: () => undefined })
    setOC(oc)
    if (request.kind === 'extract') {
      const files = await extractStepParts(request.bytes, request.picks)
      post({ type: 'extracted', files }, files.map((f) => f.buffer))
      return
    }
    const { files, parts, tubes = [] } = request
    post({ type: 'progress', done: 0, total: parts.length + tubes.length })
    const bytes = await buildAssemblyStep(new Map(Object.entries(files)), parts, (done, total) => post({ type: 'progress', done, total }), tubes)
    post({ type: 'done', bytes }, [bytes.buffer])
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}
