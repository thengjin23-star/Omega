import { useEffect, useState } from 'react'
import { analyzeDescription } from '../ai/aiActions'
import { aiReady, useAiSettings } from '../ai/aiSettings'
import { planToList, type PlanRow } from '../ai/partsAi'
import { genericMeta } from '../catalog/generic/genericParts'
import { Button, Dialog } from '../components/ui'
import { useSettingsStore } from '../settings/settings'
import { useModuleStore } from './moduleStore'

const EXAMPLE = `4 位電磁閥集裝座，5/2 單電控，A、B 口都接 6mm 快插接頭，P 口接 8mm 快插，排氣口加消音器。
另外一支 Ø32 行程 100 的氣缸，兩個口接 6mm 的速度控制接頭。`

/**
 * 依敘述產生（AI）：用文字描述要的模組（不用知道型號），AI 判斷要用哪些零件、幾個、接在哪；
 * 產品庫有的用原廠 3D，沒有的產生通用 3D；確認後自動組裝，再產生示意圖。
 */
export function DescribeDialog({ onClose, onBuild }: { onClose: () => void; onBuild: (text: string, name?: string) => void }) {
  const products = useModuleStore((s) => s.products)
  const busy = useModuleStore((s) => s.busy)
  const { createGenericParts } = useModuleStore.getState()
  const ai = useAiSettings()
  const [text, setText] = useState('')
  const [rows, setRows] = useState<PlanRow[]>()
  const [notes, setNotes] = useState<string[]>([])
  const [name, setName] = useState('')
  const [working, setWorking] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    void ai.load()
  }, [ai])

  const analyze = async () => {
    setWorking('AI 分析中…')
    setError(undefined)
    try {
      const r = await analyzeDescription(text, Object.values(products))
      setRows(r.rows)
      setNotes(r.result.notes)
      setName(r.result.moduleName ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(undefined)
    }
  }

  const usable = (rows ?? []).filter((r) => r.product || r.spec)
  const build = async () => {
    setWorking('建立零件…')
    setError(undefined)
    try {
      const generic = usable.filter((r) => !r.product)
      const made = await createGenericParts(generic.map((r) => ({ spec: r.spec!, modelCode: r.code, name: r.label, maker: r.maker })))
      const codeOf = new Map(generic.map((r, i) => [r.ref, made[i].modelCode]))
      const list = planToList(usable.map((r) => ({ ...r, modelCode: r.product?.modelCode ?? codeOf.get(r.ref)! })))
      onBuild(list, name.trim() || undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(undefined)
    }
  }

  const setRow = (i: number, patch: Partial<PlanRow> | null) =>
    setRows((list) => (patch === null ? list?.filter((_, k) => k !== i) : list?.map((r, k) => (k === i ? { ...r, ...patch } : r))))
  const labelOf = (ref?: string) => rows?.find((r) => r.ref === ref)?.label

  return (
    <Dialog
      wide
      title="依敘述產生（AI）"
      onClose={onClose}
      footer={
        <>
          <span className={`mr-auto self-center text-xs ${error ? 'text-red-600' : 'text-slate-500'}`} role="status">
            {error ?? working ?? busy ?? (rows ? `${usable.length} 項零件．確認後按「建立零件並組裝」` : '')}
          </span>
          <Button onClick={onClose}>關閉</Button>
          <Button variant="primary" disabled={!usable.length || !!working || !!busy} onClick={() => void build()}>
            建立零件並組裝
          </Button>
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
        <form
          className="flex shrink-0 flex-col gap-2 lg:w-[26rem]"
          onSubmit={(e) => {
            e.preventDefault()
            void analyze()
          }}
        >
          {!aiReady(ai) && ai.loaded && (
            <div className="rounded-md bg-amber-50 p-2 text-xs leading-5 text-amber-900" data-ai-missing>
              還沒有設定 AI 的 API 金鑰。請到「設定 → AI 判斷（Google Gemini）」貼上金鑰（用 Google 帳號免費建立）。
              <div className="mt-1">
                <Button size="sm" onClick={() => useSettingsStore.getState().openDialog(true)}>
                  開啟設定
                </Button>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between text-xs text-slate-500">
            <label htmlFor="describe-text">用文字描述要的模組（不用知道型號）</label>
            <button type="button" className="text-blue-600 hover:underline" onClick={() => setText(EXAMPLE)}>
              填入範例
            </button>
          </div>
          <textarea
            id="describe-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            placeholder={`例如：\n${EXAMPLE}`}
            className="min-h-48 flex-1 resize-none rounded-md border border-slate-300 p-2 text-sm leading-6 text-slate-800 placeholder:text-slate-400"
          />
          <ul className="space-y-0.5 text-[11px] leading-4 text-slate-500">
            <li>．可以混著寫型號與敘述，例如「4V210-08 三顆，A、B 接 PC8-02」</li>
            <li>．1分、2分、3分 = 1/8"、1/4"、3/8"；沒說牙型就當 PT</li>
            <li>．產品庫有的零件用原廠 3D，沒有的產生通用 3D（示意模型）</li>
          </ul>
          <Button type="submit" variant="primary" disabled={!text.trim() || !aiReady(ai) || !!working}>
            {working === 'AI 分析中…' ? 'AI 分析中…' : rows ? '重新分析' : 'AI 分析'}
          </Button>
        </form>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
          {!rows ? (
            <p className="text-xs leading-5 text-slate-500">
              AI 會判斷要用哪些零件、各幾個、接在哪裡。結果會列在這裡讓你確認（可以改數量或移除），確認後建立零件、自動組裝並檢查搭配，再產生示意圖。
            </p>
          ) : (
            <>
              <label className="block max-w-sm text-xs text-slate-500">
                模組名稱
                <input value={name} onChange={(e) => setName(e.target.value)} className="mt-0.5 h-8 w-full rounded-md border border-slate-300 px-2 text-sm text-slate-800" />
              </label>
              <table className="w-full text-xs" aria-label="AI 判斷的零件">
                <thead className="text-left text-slate-500">
                  <tr className="border-b border-slate-200">
                    <th className="py-1 font-normal">零件</th>
                    <th className="w-16 py-1 font-normal">數量</th>
                    <th className="py-1 pl-2 font-normal">3D</th>
                    <th className="py-1 pl-2 font-normal">接在</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.ref + i} className="border-b border-slate-100 align-top" data-plan-row={r.label} data-plan-source={r.product ? 'library' : r.spec ? 'generic' : 'none'}>
                      <td className="py-1.5">
                        <div className="font-medium text-slate-800">{r.label}</div>
                        {r.code && <div className="font-mono text-[11px] text-slate-500">{r.code}</div>}
                        {(r.notes.length > 0 || r.confidence === 'low') && (
                          <div className="mt-0.5 text-[11px] text-amber-800">
                            {[r.confidence === 'low' ? 'AI 不太確定，請確認' : '', ...r.notes].filter(Boolean).join('；')}
                          </div>
                        )}
                      </td>
                      <td className="py-1.5">
                        <input
                          type="number"
                          min={1}
                          value={r.qty}
                          aria-label={`${r.label} 的數量`}
                          onChange={(e) => setRow(i, { qty: Math.max(1, Number(e.target.value) || 1) })}
                          className="h-7 w-14 rounded border border-slate-300 px-1 text-right"
                        />
                      </td>
                      <td className="py-1.5 pl-2">
                        {r.product ? (
                          <span className="text-emerald-700">✓ 產品庫 {r.product.modelCode}</span>
                        ) : r.spec ? (
                          <span className="text-blue-700">◇ 通用 3D{!r.code ? `（${genericMeta(r.spec).modelCode}）` : ''}</span>
                        ) : (
                          <span className="text-red-700">✕ 無法產生</span>
                        )}
                      </td>
                      <td className="py-1.5 pl-2 text-slate-600">
                        {r.connectTo ? `${labelOf(r.connectTo) ?? r.connectTo}${r.ports.length ? ` 的 ${r.ports.join('、')}` : ''}` : r.ports.length ? r.ports.join('、') : '—'}
                      </td>
                      <td className="py-1.5 text-right">
                        <button type="button" className="text-slate-400 hover:text-red-600" aria-label={`移除 ${r.label}`} onClick={() => setRow(i, null)}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {notes.length > 0 && (
                <section aria-label="AI 的假設" className="rounded-md bg-slate-50 p-2 text-xs leading-5 text-slate-600">
                  <div className="font-medium text-slate-700">AI 的假設與要確認的地方</div>
                  <ul className="list-inside list-disc">
                    {notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}
