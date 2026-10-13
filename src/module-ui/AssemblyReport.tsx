import { useMemo, useState } from 'react'
import { moduleReport, type ReportItem, type ReportLevel } from '../assembly/moduleReport'
import { Button } from '../components/ui'
import { useModuleStore } from './moduleStore'

const STYLE: Record<ReportLevel, { icon: string; box: string; text: string }> = {
  error: { icon: '✕', box: 'border-red-200 bg-red-50', text: 'text-red-700' },
  warn: { icon: '!', box: 'border-amber-200 bg-amber-50', text: 'text-amber-800' },
  info: { icon: 'i', box: 'border-slate-200 bg-slate-50', text: 'text-slate-600' },
}

/** 目前模組的搭配檢查（即時）：搭配不對、沒接的埠與建議，可一鍵補上 */
function useModuleReport(): ReportItem[] {
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const stats = useModuleStore((s) => s.stats)
  return useMemo(() => moduleReport(doc, products, { stats }), [doc, products, stats])
}

const reportCounts = (items: readonly ReportItem[]) => ({
  error: items.filter((i) => i.level === 'error').length,
  warn: items.filter((i) => i.level === 'warn').length,
})

/**
 * 搭配檢查清單。collapsible：只顯示一行摘要，按了才展開（放在示意圖對話框上方）。
 * onLocate：按項目標題時選取零件後呼叫（對話框用來關閉並在 3D 畫面對準該零件）。
 */
export function AssemblyReport({ collapsible = false, onLocate }: { collapsible?: boolean; onLocate?: (instance: string) => void }) {
  const items = useModuleReport()
  const { attachAt, attachMany, select } = useModuleStore.getState()
  const busy = useModuleStore((s) => s.busy)
  const counts = reportCounts(items)
  const [open, setOpen] = useState(!collapsible || counts.error > 0)
  const recommended = items.flatMap((i) => (i.at && i.fixes?.[0]?.recommended ? [{ at: i.at, productId: i.fixes[0].productId, portId: i.fixes[0].portId }] : []))

  const summary =
    counts.error || counts.warn
      ? [counts.error && `✕ ${counts.error} 個搭配不對`, counts.warn && `! ${counts.warn} 個要注意`].filter(Boolean).join('、')
      : '✓ 沒有問題'

  return (
    <section aria-label="搭配檢查" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-700">搭配檢查</h3>
        <span
          className={`text-xs ${counts.error ? 'text-red-700' : counts.warn ? 'text-amber-800' : 'text-green-700'}`}
          data-report-summary={`${counts.error}/${counts.warn}`}
        >
          {summary}
        </span>
        {recommended.length > 0 && (
          <Button size="sm" disabled={!!busy} onClick={() => void attachMany(recommended)} title="依以前的搭配記錄（排氣口配消音器）一次補上">
            依建議補上 {recommended.length} 個
          </Button>
        )}
        {collapsible && items.length > 0 && (
          <Button size="sm" className="ml-auto" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? '收起' : '查看'}
          </Button>
        )}
      </div>
      {open && items.length > 0 && (
        <ul className={`space-y-1.5 ${collapsible ? 'max-h-48 overflow-y-auto pr-1' : ''}`}>
          {items.map((item) => {
            const s = STYLE[item.level]
            return (
              <li key={item.key} className={`rounded-md border px-2.5 py-1.5 text-xs ${s.box}`} data-report-level={item.level}>
                <div className={`flex items-start gap-1.5 ${s.text}`}>
                  <span aria-hidden className="font-bold">
                    {s.icon}
                  </span>
                  <button
                    type="button"
                    className="text-left font-medium hover:underline disabled:no-underline"
                    disabled={!item.instance}
                    onClick={() => {
                      if (!item.instance) return
                      select(item.instance)
                      onLocate?.(item.instance)
                    }}
                    title={item.instance ? '在 3D 畫面選取這個零件' : undefined}
                  >
                    {item.title}
                  </button>
                </div>
                {item.detail && <p className="mt-0.5 pl-4 text-slate-600">{item.detail}</p>}
                {item.at && item.fixes && item.fixes.length > 0 && (
                  <div className="mt-1 flex flex-wrap items-center gap-1 pl-4">
                    <span className="text-slate-500">補上：</span>
                    {item.fixes.map((f) => (
                      <button
                        key={f.productId}
                        type="button"
                        disabled={!!busy}
                        onClick={() => void attachAt(item.at!, f.productId, f.portId)}
                        className={`rounded border px-1.5 py-0.5 font-mono ${f.recommended ? 'border-blue-300 bg-white text-blue-700' : 'border-slate-300 bg-white text-slate-700'} hover:bg-blue-50`}
                        title={f.uses ? `以前接過 ${f.uses} 次` : '規格相容'}
                      >
                        {f.label}
                        {f.uses > 0 && <span className="ml-1 text-[10px] text-slate-400">用過 {f.uses}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
