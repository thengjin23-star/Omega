/**
 * 產生通用零件的 STEP 檔（OpenCascade／replicad，WASM 約 23 MB，第一次使用時下載，之後由 service worker 快取）。
 */
import { exportSTEP, setOC } from 'replicad'
import opencascade from 'replicad-opencascadejs'
import wasmUrl from 'replicad-opencascadejs/wasm?url'
import type { SamplePortDef } from '../samples'
import { buildGeneric } from './buildGeneric'
import type { GenericSpec } from './genericParts'

export interface GenericRequest {
  specs: GenericSpec[]
}

export type GenericMessage =
  | { type: 'loading' }
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; parts: { bytes: Uint8Array; ports: SamplePortDef[] }[] }
  | { type: 'error'; error: string }

const post = (message: GenericMessage, transfer: Transferable[] = []) => self.postMessage(message, { transfer })

self.onmessage = async (event: MessageEvent<GenericRequest>) => {
  const { specs } = event.data
  try {
    post({ type: 'loading' })
    const oc = await opencascade({ locateFile: () => wasmUrl, print: () => undefined, printErr: () => undefined })
    setOC(oc)
    const parts: { bytes: Uint8Array; ports: SamplePortDef[] }[] = []
    for (const spec of specs) {
      const built = buildGeneric(spec)
      const blob = exportSTEP(built.shapes.map(({ shape, name, color }) => ({ shape, name, color })))
      parts.push({ bytes: new Uint8Array(await blob.arrayBuffer()), ports: built.ports })
      post({ type: 'progress', done: parts.length, total: specs.length })
    }
    post(
      { type: 'done', parts },
      parts.map((p) => p.bytes.buffer as ArrayBuffer),
    )
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}
