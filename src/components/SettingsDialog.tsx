import { useEffect, useRef, useState } from 'react'
import { BACKUP_EXT, LIBRARY_EXT, MODULE_EXT } from '../catalog/archive'
import { downloadBackup, restoreFromFile } from '../settings/backup'
import { useSettingsStore, type AppSettings } from '../settings/settings'
import { AiSettingsSection } from './AiSettingsSection'
import { Button, Dialog } from './ui'

const inputClass = 'mt-0.5 h-8 w-full rounded-md border border-slate-300 px-2 text-sm text-slate-800'
const sectionTitle = 'mb-2 text-sm font-semibold text-slate-700'

const formatBytes = (n: number) =>
  n > 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n > 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`

/** 把圖片縮到最大 480×160，轉成 PNG data URL（存進設定、印在圖面標題欄） */
async function logoDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('無法讀取圖片'))
      el.src = url
    })
    const scale = Math.min(1, 480 / img.width, 160 / img.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}

function SettingsDialogImpl({ onClose }: { onClose: () => void }) {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [storage, setStorage] = useState<{ usage?: number; quota?: number; persisted?: boolean }>({})
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | undefined>()
  const [busy, setBusy] = useState(false)
  const restoreInput = useRef<HTMLInputElement>(null)
  const logoInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void (async () => {
      const [estimate, persisted] = await Promise.all([
        navigator.storage?.estimate?.().catch(() => undefined),
        navigator.storage?.persisted?.().catch(() => undefined),
      ])
      setStorage({ usage: estimate?.usage, quota: estimate?.quota, persisted })
    })()
  }, [])

  const company = (patch: Partial<AppSettings['company']>) => setDraft((d) => ({ ...d, company: { ...d.company, ...patch } }))
  const run = async (task: () => Promise<string | void>) => {
    setBusy(true)
    setMessage(undefined)
    try {
      const text = await task()
      if (text) setMessage({ kind: 'info', text })
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="設定"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={() => {
              void update({ company: draft.company, drawer: draft.drawer, paper: draft.paper, projection: draft.projection, dxfFont: draft.dxfFont })
              onClose()
            }}
          >
            儲存設定
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <section>
          <h3 className={sectionTitle}>公司資訊（印在圖面標題欄）</h3>
          <div className="grid grid-cols-2 gap-2">
            <label className="col-span-2 block text-xs text-slate-500">
              公司名稱
              <input value={draft.company.name} onChange={(e) => company({ name: e.target.value })} className={inputClass} />
            </label>
            <label className="col-span-2 block text-xs text-slate-500">
              地址
              <input value={draft.company.address ?? ''} onChange={(e) => company({ address: e.target.value || undefined })} className={inputClass} />
            </label>
            <label className="block text-xs text-slate-500">
              電話
              <input value={draft.company.phone ?? ''} onChange={(e) => company({ phone: e.target.value || undefined })} className={inputClass} />
            </label>
            <label className="block text-xs text-slate-500">
              Email
              <input value={draft.company.email ?? ''} onChange={(e) => company({ email: e.target.value || undefined })} className={inputClass} />
            </label>
            <div className="col-span-2 flex items-center gap-3">
              {draft.company.logo ? (
                <img src={draft.company.logo} alt="公司標誌" className="h-10 max-w-40 rounded border border-slate-200 object-contain p-0.5" />
              ) : (
                <span className="text-xs text-slate-400">尚未設定標誌</span>
              )}
              <Button size="sm" onClick={() => logoInput.current?.click()}>
                {draft.company.logo ? '更換標誌' : '上傳標誌'}
              </Button>
              {draft.company.logo && (
                <Button size="sm" variant="ghost" onClick={() => company({ logo: undefined })}>
                  移除
                </Button>
              )}
              <input
                ref={logoInput}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) void run(async () => company({ logo: await logoDataUrl(file) }))
                }}
              />
            </div>
            <label className="col-span-2 block text-xs text-slate-500">
              繪圖者
              <input value={draft.drawer} onChange={(e) => setDraft((d) => ({ ...d, drawer: e.target.value }))} className={inputClass} />
            </label>
          </div>
        </section>

        <section>
          <h3 className={sectionTitle}>圖面預設</h3>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-slate-500">
              紙張
              <select value={draft.paper} onChange={(e) => setDraft((d) => ({ ...d, paper: e.target.value as AppSettings['paper'] }))} className={inputClass}>
                <option value="A3">A3 橫式</option>
                <option value="A4">A4 橫式</option>
              </select>
            </label>
            <label className="block text-xs text-slate-500">
              投影法
              <select
                value={draft.projection}
                onChange={(e) => setDraft((d) => ({ ...d, projection: e.target.value as AppSettings['projection'] }))}
                className={inputClass}
              >
                <option value="third">第三角法</option>
                <option value="first">第一角法</option>
              </select>
            </label>
            <label className="col-span-2 block text-xs text-slate-500">
              DXF 中文字型檔名
              <input value={draft.dxfFont} onChange={(e) => setDraft((d) => ({ ...d, dxfFont: e.target.value }))} className={inputClass} />
              <span className="mt-0.5 block text-[11px] text-slate-400">AutoCAD 依此字型顯示中文，常用：msjh.ttc（微軟正黑體）、mingliu.ttc（細明體）</span>
            </label>
          </div>
        </section>

        <AiSettingsSection />

        <section>
          <h3 className={sectionTitle}>資料與備份</h3>
          <div className="space-y-2 text-xs leading-5 text-slate-600">
            <p>
              產品庫、模組、迴路圖都存在這台裝置的瀏覽器中
              {storage.usage !== undefined && `（已使用 ${formatBytes(storage.usage)}${storage.quota ? `／可用約 ${formatBytes(storage.quota)}` : ''}）`}。
              {storage.persisted === true && ' 已設為永久保存，瀏覽器不會自動清除。'}
              {storage.persisted === false && ' 瀏覽器尚未同意永久保存；清除瀏覽資料時可能被刪除，請定期備份。'}
            </p>
            <p>
              上次完整備份：
              {settings.lastBackupAt ? new Date(settings.lastBackupAt).toLocaleString('zh-TW') : '尚未備份'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await downloadBackup()
                    return '已下載完整備份。請存到雲端硬碟或隨身碟。'
                  })
                }
              >
                下載完整備份（{BACKUP_EXT}）
              </Button>
              <Button size="sm" disabled={busy} onClick={() => restoreInput.current?.click()}>
                從備份還原…
              </Button>
              <input
                ref={restoreInput}
                type="file"
                accept={`${BACKUP_EXT},${LIBRARY_EXT},${MODULE_EXT}`}
                hidden
                data-testid="restore-file-input"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  void run(async () => {
                    const { text } = await restoreFromFile(file)
                    return `還原完成：${text}。重新整理後即可在清單中看到還原的模組與迴路圖。`
                  })
                }}
              />
            </div>
            <p className="text-[11px] text-slate-400">
              完整備份包含產品（含 3D 檔）、模組、迴路圖、搭配記錄與設定。還原時與這台裝置的資料合併，不會刪除現有資料。
            </p>
          </div>
        </section>

        {message && (
          <p
            role="status"
            className={`rounded-md p-2 text-xs leading-5 ${message.kind === 'error' ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800'}`}
          >
            {message.text}
          </p>
        )}
      </div>
    </Dialog>
  )
}

/** 設定對話框（兩個分頁共用，由 useSettingsStore.openDialog 開啟） */
export function SettingsDialog() {
  const open = useSettingsStore((s) => s.dialogOpen)
  const openDialog = useSettingsStore((s) => s.openDialog)
  return open ? <SettingsDialogImpl onClose={() => openDialog(false)} /> : null
}
