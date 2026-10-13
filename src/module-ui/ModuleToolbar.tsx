import { useState } from 'react'
import { WorkspaceTabs } from '../components/WorkspaceTabs'
import { useSettingsStore } from '../settings/settings'
import { useModuleStore } from './moduleStore'
import { BarButton, Button, Dialog } from '../components/ui'
import { DrawingDialog } from './DrawingDialog'
import { IllustrationDialog } from './IllustrationDialog'
import { StepExportDialog } from './StepExportDialog'
import { generateCircuitFromModule } from './generateCircuit'

export function ModuleToolbar() {
  const doc = useModuleStore((s) => s.doc)
  const saved = useModuleStore((s) => s.saved)
  const busy = useModuleStore((s) => s.busy)
  const canUndo = useModuleStore((s) => s.past.length > 0)
  const canRedo = useModuleStore((s) => s.future.length > 0)
  const selected = useModuleStore((s) => s.selected)
  const drawer = useModuleStore((s) => s.drawer)
  const mode = useModuleStore((s) => s.mode)
  const drawingOpen = useModuleStore((s) => s.drawingOpen)
  const sequenceOpen = useModuleStore((s) => s.sequenceOpen)
  const { newModule, undo, redo, requestFit, exportModuleFile, renameModule, toggleDrawer, setMode, openDrawing, toggleSequencePanel } = useModuleStore.getState()
  const [listOpen, setListOpen] = useState(false)
  const [stepOpen, setStepOpen] = useState(false)
  const [illustrationOpen, setIllustrationOpen] = useState(false)

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 overflow-x-auto bg-slate-800 px-2 text-white sm:px-3">
      <WorkspaceTabs />
      {/* 窄螢幕：側邊面板改為抽屜 */}
      <span className="flex shrink-0 lg:hidden">
        <BarButton label="產品庫" onClick={() => toggleDrawer('library')} aria-pressed={drawer === 'library'} />
        <BarButton label="屬性" onClick={() => toggleDrawer('inspector')} aria-pressed={drawer === 'inspector'} />
      </span>
      <NameField key={`${doc.id}-name`} value={doc.name} placeholder="模組名稱" width="w-40" onCommit={(name) => renameModule({ name: name || '未命名模組' })} />
      <NameField key={`${doc.id}-customer`} value={doc.customer ?? ''} placeholder="客戶" width="w-28" onCommit={(customer) => renameModule({ customer })} />
      <div className="mx-1 h-6 w-px shrink-0 bg-white/15" />
      <BarButton label="新模組" onClick={newModule} />
      <BarButton label="開啟…" onClick={() => setListOpen(true)} />
      <BarButton label="復原" onClick={undo} disabled={!canUndo || mode === 'simulate'} title="Ctrl+Z" />
      <BarButton label="重做" onClick={redo} disabled={!canRedo || mode === 'simulate'} title="Ctrl+Y" />
      <BarButton label="顯示全部" onClick={() => requestFit()} />
      <BarButton
        label={mode === 'measure' ? '結束量測' : '量測'}
        aria-pressed={mode === 'measure'}
        onClick={() => setMode(mode === 'measure' ? 'select' : 'measure')}
        disabled={doc.instances.length === 0}
        title="量測兩點距離"
      />
      <BarButton
        label={mode === 'simulate' ? '結束模擬' : '模擬'}
        aria-pressed={mode === 'simulate'}
        onClick={() => setMode(mode === 'simulate' ? 'select' : 'simulate')}
        disabled={doc.instances.length === 0}
        title="依模組的氣路模擬：點閥切換、氣缸動作"
      />
      <BarButton
        label="程序"
        aria-pressed={sequenceOpen}
        onClick={() => toggleSequencePanel()}
        disabled={doc.instances.length === 0}
        title="程序控制：動作順序（A+ B+ B- A-）、自動／單步執行、位移－步驟圖"
      />
      <BarButton
        label={mode === 'tube' ? '結束接管' : '接 PU 管'}
        aria-pressed={mode === 'tube'}
        onClick={() => setMode(mode === 'tube' ? 'select' : 'tube')}
        disabled={doc.instances.length === 0}
        title="點選兩個快插接頭，接上 PU 管"
      />
      <BarButton label="對準選取" onClick={() => requestFit(selected)} disabled={!selected} title="縮放到選取的零件" />
      <BarButton label="產生圖面" onClick={() => openDrawing(true)} disabled={doc.instances.length === 0} title="三視圖、零件表、標題欄：PDF／DXF／SVG" />
      <BarButton
        label="產生示意圖"
        onClick={() => setIllustrationOpen(true)}
        disabled={doc.instances.length === 0 || mode === 'simulate'}
        title="著色的 3D 圖，標上每個零件的型號與箭頭：PNG／複製圖片／PDF（給研發申請、報價附圖）"
      />
      <BarButton
        label="產生迴路圖"
        onClick={() => {
          const error = generateCircuitFromModule()
          if (error) useModuleStore.setState({ message: { kind: 'error', text: error } })
        }}
        disabled={doc.instances.length === 0 || mode === 'simulate'}
        title="依模組的氣路產生迴路圖（開在迴路圖分頁）"
      />
      <BarButton label="匯出 STEP" onClick={() => setStepOpen(true)} disabled={doc.instances.length === 0} title="STEP 組立檔（所有零件依組立位置）" />
      <BarButton label="匯出模組" onClick={() => void exportModuleFile()} disabled={doc.instances.length === 0} />
      <span className="ml-auto pl-2 text-xs whitespace-nowrap text-slate-300" role="status">
        {busy ?? (saved ? '已儲存' : '儲存中…')}
      </span>
      <BarButton label="設定" onClick={() => useSettingsStore.getState().openDialog(true)} />
      {listOpen && <ModuleList onClose={() => setListOpen(false)} />}
      {drawingOpen && <DrawingDialog onClose={() => openDrawing(false)} />}
      {stepOpen && <StepExportDialog onClose={() => setStepOpen(false)} />}
      {illustrationOpen && <IllustrationDialog onClose={() => setIllustrationOpen(false)} />}
    </header>
  )
}

/** 失去焦點或按 Enter 時才寫入（避免每個字都產生一筆復原紀錄） */
function NameField({ value, placeholder, width, onCommit }: { value: string; placeholder: string; width: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value)
  const commit = () => text.trim() !== value && onCommit(text.trim())
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      placeholder={placeholder}
      aria-label={placeholder}
      className={`${width} h-8 shrink-0 rounded-md border border-white/15 bg-white/5 px-2 text-sm text-white placeholder:text-slate-400 focus:bg-white/10 focus:outline-none`}
    />
  )
}

function ModuleList({ onClose }: { onClose: () => void }) {
  const modules = useModuleStore((s) => s.modules)
  const current = useModuleStore((s) => s.doc.id)
  const { openModule, deleteModule } = useModuleStore.getState()
  return (
    <Dialog title="開啟模組" onClose={onClose}>
      {modules.length === 0 ? (
        <p className="text-sm text-slate-500">還沒有儲存的模組。</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-slate-800">
          {modules.map((m) => (
            <li key={m.id} className="flex items-center gap-2 py-2">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  void openModule(m.id)
                  onClose()
                }}
              >
                <div className="truncate font-medium">
                  {m.name}
                  {m.id === current && <span className="ml-1 text-xs text-blue-600">（目前）</span>}
                </div>
                <div className="text-xs text-slate-500">
                  {m.customer ? `${m.customer}．` : ''}
                  {m.parts} 個零件．{new Date(m.updatedAt).toLocaleString('zh-TW')}
                </div>
              </button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => window.confirm(`刪除模組「${m.name}」？`) && void deleteModule(m.id)}
              >
                刪除
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
