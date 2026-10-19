import { useMemo, useRef, useState } from 'react'
import { computeTransforms } from '../assembly/moduleOps'
import { getCatalog } from '../catalog/library'
import { Button, Dialog } from '../components/ui'
import { exportAssemblyStep, type StepProgress } from '../drawing/stepClient'
import { buildStepMeta, embedStepMeta } from '../drawing/stepMeta'
import { collectStepParts } from '../drawing/stepParts'
import { downloadFile, safeFileName } from '../utils/download'
import { useModuleStore } from './moduleStore'

type Phase = { kind: 'idle' } | { kind: 'running'; progress?: StepProgress } | { kind: 'done'; bytes: number } | { kind: 'error'; message: string }

/** 匯出 STEP 組立檔：所有零件依模組中的位置寫成一個 STEP，可在 SolidWorks、Inventor、Fusion 等 CAD 開啟 */
export function StepExportDialog({ onClose }: { onClose: () => void }) {
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const meshes = useModuleStore((s) => s.meshes)
  const plan = useMemo(() => collectStepParts(doc, products, meshes, computeTransforms(doc, products).transforms), [doc, products, meshes])
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const abort = useRef<AbortController | undefined>(undefined)

  const start = async () => {
    const controller = new AbortController()
    abort.current = controller
    setPhase({ kind: 'running' })
    try {
      const catalog = await getCatalog()
      const files: Record<string, Uint8Array> = {}
      for (const sha of plan.sources) {
        const file = await catalog.getFile(sha)
        if (!file) throw new Error('找不到零件的原始 STEP 檔（可能是從舊版的封存檔匯入）')
        files[sha] = file.bytes
      }
      const step = await exportAssemblyStep(
        { files, parts: plan.parts, tubes: plan.tubes },
        (progress) => setPhase({ kind: 'running', progress }),
        controller.signal,
      )
      // 模組資料（零件、位置、鎖合）寫在 STEP 的註解裡：再匯入本程式時可以完整還原；其他 CAD 會忽略
      const colors: Record<string, string> = {}
      for (const inst of doc.instances) {
        const root = plan.roots[inst.id]
        const color = root !== undefined ? plan.parts[root].color : undefined
        if (color) colors[inst.productId] ??= color
      }
      const bytes = embedStepMeta(step, buildStepMeta(doc, products, plan.roots, colors))
      downloadFile(bytes, `${safeFileName(doc.name)}.step`, 'application/step')
      setPhase({ kind: 'done', bytes: bytes.length })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') setPhase({ kind: 'idle' })
      else setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const running = phase.kind === 'running'
  const progress = running ? phase.progress : undefined
  const percent = progress?.stage === 'parts' && progress.total ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <Dialog
      title="匯出 STEP 組立檔"
      onClose={() => {
        abort.current?.abort()
        onClose()
      }}
      footer={
        running ? (
          <Button onClick={() => abort.current?.abort()}>取消</Button>
        ) : (
          <>
            <Button onClick={onClose}>關閉</Button>
            <Button variant="primary" disabled={!plan.parts.length && !plan.tubes.length} onClick={() => void start()}>
              {phase.kind === 'done' ? '再匯出一次' : '開始匯出'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        <p>
          把模組中的 {plan.parts.length} 個零件{plan.tubes.length > 0 && `與 ${plan.tubes.length} 條 PU 管`}，依組立位置寫成一個 STEP 檔（AP242，單位
          mm），每個零件以「項次_型號」命名，可在 SolidWorks、Inventor、Fusion 360 等 CAD 軟體開啟。
        </p>
        <p className="text-xs text-slate-500">
          檔案裡另外記下模組的組裝資料（零件、位置、鎖合）：再把這個 STEP 匯入本程式，會還原成可以個別操作的零件，位置與現在相同。
          第一次使用需下載 STEP 處理元件（約 23 MB），之後離線也能使用。
        </p>
        {plan.skipped.length > 0 && (
          <ul className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {plan.skipped.map((s) => (
              <li key={s.name}>
                略過「{s.name}」：{s.reason}
              </li>
            ))}
          </ul>
        )}
        {running && (
          <div role="status" className="space-y-1">
            <div className="h-2 overflow-hidden rounded-full bg-slate-200">
              <div
                className={`h-full rounded-full bg-blue-600 transition-all ${progress?.stage === 'parts' ? '' : 'w-1/4 animate-pulse'}`}
                style={progress?.stage === 'parts' ? { width: `${Math.max(4, percent)}%` } : undefined}
              />
            </div>
            <p className="text-xs text-slate-500">
              {progress?.stage === 'parts'
                ? progress.done < progress.total
                  ? progress.done < plan.parts.length
                    ? `轉換零件 ${progress.done} / ${plan.parts.length}…`
                    : `產生 PU 管 ${progress.done - plan.parts.length} / ${plan.tubes.length}…`
                  : '寫入 STEP 檔…'
                : '載入 STEP 處理元件…'}
            </p>
          </div>
        )}
        {phase.kind === 'done' && (
          <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-xs text-green-800">
            已下載 {safeFileName(doc.name)}.step（{(phase.bytes / 1024).toFixed(0)} KB）
          </p>
        )}
        {phase.kind === 'error' && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{phase.message}</p>}
      </div>
    </Dialog>
  )
}
