import { useEffect, useState, type DragEvent } from 'react'
import { formatSpec } from '../threads'
import { Inspector } from './Inspector'
import { portLabel } from './labels'
import { LibraryPanel } from './LibraryPanel'
import { MateDialog } from './MateDialog'
import { ModuleToolbar } from './ModuleToolbar'
import { useModuleStore } from './moduleStore'
import { PortEditor } from './PortEditor'
import { Button } from '../components/ui'
import { Viewport } from './Viewport'
import { SimulationPanel } from './SimulationPanel'
import { SequencePanel } from '../components/sequence/SequencePanel'
import { moduleSequenceHost } from './moduleSequenceHost'
import { useModuleBounds } from './useModuleBounds'
import { formatMm } from './bounds'
import { getPort } from '../assembly/moduleOps'

/** 3D 模組組立工作區（延遲載入） */
export default function ModuleWorkspace() {
  const status = useModuleStore((s) => s.status)
  const error = useModuleStore((s) => s.error)
  const init = useModuleStore((s) => s.init)
  const importFiles = useModuleStore((s) => s.importFiles)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  useKeyboard()

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const files = [...e.dataTransfer.files]
    if (files.length) void importFiles(files)
  }

  if (status === 'error') {
    return (
      <div className="flex h-full flex-col">
        <ModuleToolbar />
        <p className="m-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">無法開啟產品庫：{error}</p>
      </div>
    )
  }

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <ModuleToolbar />
      <div className="relative flex min-h-0 flex-1">
        <LibraryPanel />
        <main className="relative flex min-w-0 flex-1 flex-col bg-slate-100">
          <div className="relative min-h-0 flex-1">
            {status === 'loading' ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">載入產品庫…</div>
            ) : (
              <Viewport />
            )}
            <HintBar />
            <SimulationPanel />
            <DimensionsBadge />
            <EmptyState />
            <Toast />
            {dragging && (
              <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-500 bg-blue-50/70 text-lg font-medium text-blue-800">
                放開以匯入 STEP／IGES（或 .plib／.pmod）
              </div>
            )}
          </div>
          <ModuleSequencePanel />
        </main>
        <Inspector />
      </div>
      <PortEditor />
      <MateDialog />
    </div>
  )
}

/** 程序控制面板（工具列「程序」開關），在 3D 畫面下方 */
function ModuleSequencePanel() {
  const open = useModuleStore((s) => s.sequenceOpen)
  return open ? <SequencePanel host={moduleSequenceHost} /> : null
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      const s = useModuleStore.getState()
      if (e.key === 'Escape') {
        if (s.gizmo) s.setGizmo(undefined)
        else if (s.connectFrom) s.cancelConnect()
        else if (s.mode === 'tube' && s.tubeFrom) s.setMode('tube')
        else if (s.mode === 'measure' && s.measure.length) s.clearMeasure()
        else if (s.mode !== 'select') s.setMode('select')
        else {
          s.select(undefined)
          s.selectTube(undefined)
        }
      } else if (s.mode === 'simulate') {
        // 模擬中不能編輯
        return
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && (s.selected || s.selectedTube)) {
        e.preventDefault()
        s.removeSelected()
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && s.selected && s.mode === 'select' && (e.key === 'm' || e.key === 'M' || e.key === 'r' || e.key === 'R')) {
        // M：拖曳移動、R：拖曳旋轉（再按一次關閉）
        const g = e.key.toLowerCase() === 'm' ? 'move' : 'rotate'
        s.setGizmo(s.gizmo === g ? undefined : g)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        s.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function HintBar() {
  const mode = useModuleStore((s) => s.mode)
  const connectFrom = useModuleStore((s) => s.connectFrom)
  const hasParts = useModuleStore((s) => s.doc.instances.length > 0)
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  let text: string | undefined
  if (mode === 'simulate') {
    // 模擬面板已有說明
    text = undefined
  } else if (mode === 'tube') {
    text = '接 PU 管：點選一個快插接頭，再點另一個相同管徑的快插接頭（Esc 結束）'
  } else if (mode === 'measure') {
    text = '量測：點選零件表面或埠的中心，連點兩個點顯示距離；再點會開始新的量測（Esc 結束）'
  } else if (connectFrom) {
    const spec = getPort(doc, products, connectFrom)?.spec
    text = `已選 ${portLabel(doc, products, connectFrom)}${spec ? `（${formatSpec(spec)}）` : ''} → 點選另一個零件的埠（綠＝正確、黃＝注意、紅＝不相容、灰＝未設定），或從產品庫挑選可接的零件（Esc 取消）`
  } else if (mode === 'define-port') {
    text = '新增埠：點選零件上的孔、凸柱或平面（Esc 結束）'
  } else if (hasParts) {
    text = '點選零件以編輯；點選埠的箭頭或標籤開始連接。拖曳旋轉視角、滾輪縮放。'
  }
  if (!text) return null
  return (
    <div className="pointer-events-none absolute top-3 left-1/2 max-w-[90%] -translate-x-1/2 rounded-md bg-slate-800/85 px-3 py-1.5 text-center text-xs text-white shadow">
      {text}
    </div>
  )
}

/** 左上角：模組外形尺寸（W×D×H），可切換 3D 尺寸線 */
function DimensionsBadge() {
  const bounds = useModuleBounds()
  const showDims = useModuleStore((s) => s.showDims)
  const toggleDims = useModuleStore((s) => s.toggleDims)
  if (!bounds) return null
  const [w, d, h] = [0, 1, 2].map((k) => formatMm(bounds.max[k] - bounds.min[k]))
  return (
    <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-md border border-slate-200 bg-white/90 px-2 py-1 text-xs text-slate-700 shadow-sm">
      <span data-dims>
        外形 W {w} × D {d} × H {h} mm
      </span>
      <button
        type="button"
        aria-pressed={showDims}
        onClick={toggleDims}
        className={`rounded px-1.5 py-0.5 ${showDims ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
      >
        尺寸線
      </button>
    </div>
  )
}

function EmptyState() {
  const empty = useModuleStore((s) => s.status === 'ready' && s.doc.instances.length === 0)
  const hasProducts = useModuleStore((s) => Object.keys(s.products).length > 0)
  const installSampleLibrary = useModuleStore((s) => s.installSampleLibrary)
  if (!empty) return null
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <div className="pointer-events-auto max-w-md rounded-lg border border-dashed border-slate-300 bg-white/90 px-6 py-5 text-center text-sm text-slate-600 shadow-sm">
        <p className="font-medium text-slate-800">把要組合的 STEP 檔拖進來</p>
        <p className="mt-1 leading-6">
          或從左側產品庫點選已記住的零件。第一次使用的零件，點選它的孔來定義埠與螺紋規格，系統會記住，下次直接沿用。
        </p>
        {!hasProducts && (
          <Button className="mt-3" onClick={() => void installSampleLibrary()}>
            先安裝範例零件試用
          </Button>
        )}
      </div>
    </div>
  )
}

function Toast() {
  const message = useModuleStore((s) => s.message)
  const dismiss = useModuleStore((s) => s.dismissMessage)
  useEffect(() => {
    if (message?.kind !== 'info') return
    // 有按鈕的訊息留久一點
    const t = setTimeout(dismiss, message.action ? 30000 : 7000)
    return () => clearTimeout(t)
  }, [message, dismiss])
  if (!message) return null
  return (
    <div
      role="alert"
      className={`absolute bottom-12 left-3 z-10 flex max-w-lg items-start gap-2 rounded-md border px-3 py-2 text-sm shadow ${message.kind === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-slate-200 bg-white text-slate-700'}`}
    >
      <span className="flex-1">{message.text}</span>
      {message.action && (
        <button
          type="button"
          className="shrink-0 rounded-md bg-blue-600 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-white hover:bg-blue-700"
          onClick={() => {
            const run = message.action!.run
            dismiss()
            run()
          }}
        >
          {message.action.label}
        </button>
      )}
      <button type="button" onClick={dismiss} className="text-slate-400 hover:text-slate-700" aria-label="關閉訊息">
        ✕
      </button>
    </div>
  )
}
