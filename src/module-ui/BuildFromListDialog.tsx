import { useId, useMemo, useState } from 'react'
import { parsePartsList, productIndex, type PartsListEntry } from '../assembly/partsList'
import { genericFromCode } from '../catalog/generic/genericParts'
import { decodeModelCode } from '../catalog/makerCodes'
import { hasModel, type Product } from '../catalog/types'
import { Button, Dialog } from '../components/ui'
import { AssemblyReport } from './AssemblyReport'
import { useModuleStore, type BuildOutcome } from './moduleStore'

const inputClass = 'mt-0.5 h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-800'

const PLACEHOLDER = `一行一個型號，後面寫數量；→ 後面可以指定接在哪個埠，例如：
4SV200M5F
4SV210-08 ×4
PL802D ×8 → A、B
BSL01 ×2 → EA、EB
（也可以直接從 Excel 複製「型號、數量」兩欄貼上）`

/** 範例零件的清單（產品庫裝了範例零件時可以一鍵填入） */
const DEMO_LIST = `DEMO-MANIFOLD-4
DEMO-VALVE-VB ×4
DEMO-FITTING-R18-D6 ×4 → A
DEMO-FITTING-R18-D4 ×4 → B
DEMO-BUSH-R14-RC18 → P
DEMO-FITTING-R18-D6 → DEMO-BUSH-R14-RC18
DEMO-SILENCER-R18 ×2 → EA、EB`

type RowStatus = { level: 'ok' | 'generic' | 'warn' | 'error'; text: string; similar?: Product[] }

/** 型號規則認得、可以產生通用 3D 的名稱 */
const genericName = (code: string) => {
  const info = decodeModelCode(code)
  return info && genericFromCode(info) ? info.name : undefined
}

function rowStatus(
  entry: PartsListEntry,
  product: Product | undefined,
  index: ReturnType<typeof productIndex>,
  generic: { on: boolean; ai: boolean },
): RowStatus {
  if (!product || !hasModel(product)) {
    const known = generic.on && genericName(product?.modelCode ?? entry.code)
    if (known) return { level: 'generic', text: `${product ? '沒有 3D 檔' : '產品庫沒有'}：會產生通用 3D（${known}）` }
    if (generic.on && generic.ai) return { level: 'generic', text: `${product ? '沒有 3D 檔' : '產品庫沒有'}：會請 AI 判斷規格，再產生通用 3D`, similar: product ? undefined : index.similar(entry.code) }
  }
  if (!product) return { level: 'error', text: '產品庫找不到這個型號', similar: index.similar(entry.code) }
  if (!hasModel(product)) return { level: 'error', text: '沒有 3D 檔：請先在產品庫匯入，或勾選「自動產生通用 3D」' }
  if (!product.ports.length) return { level: 'warn', text: '還沒有設定埠：無法自動接上' }
  if (!product.ports.some((p) => p.spec)) return { level: 'warn', text: '埠沒有規格：無法判斷接在哪' }
  if (entry.hint?.target && !index.find(entry.hint.target)) return { level: 'warn', text: `指定的「${entry.hint.target}」找不到` }
  return { level: 'ok', text: product.name || '' }
}

const hintText = (hint: PartsListEntry['hint']) =>
  hint ? `→ ${hint.target ? `${hint.target}${hint.ports.length ? ' 的 ' : ''}` : ''}${hint.ports.join('、')}` : ''

/**
 * 依型號清單組裝：貼上要用的型號與數量，系統自動在 3D 組好模組，檢查搭配並提醒，再產生示意圖。
 */
export function BuildFromListDialog({ onClose, onIllustrate }: { onClose: () => void; onIllustrate: () => void }) {
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const busy = useModuleStore((s) => s.busy)
  const { buildFromList, requestFit } = useModuleStore.getState()
  const fromList = doc.partsList !== undefined
  const manual = doc.instances.length > 0 && !fromList
  const [text, setText] = useState(doc.partsList ?? '')
  const [name, setName] = useState(manual ? '' : doc.name)
  const [customer, setCustomer] = useState(manual ? '' : (doc.customer ?? ''))
  const [outcome, setOutcome] = useState<BuildOutcome | undefined>()
  const [building, setBuilding] = useState(false)
  const [useGeneric, setUseGeneric] = useState(true)
  const aiReady = false
  const listId = useId()

  const library = useMemo(() => Object.values(products), [products])
  const index = useMemo(() => productIndex(library), [library])
  const parsed = useMemo(() => parsePartsList(text, index.isCode), [text, index])
  const rows = parsed.entries.map((e) => {
    const product = index.find(e.code)
    return { entry: e, product, status: rowStatus(e, product, index, { on: useGeneric, ai: aiReady }) }
  })
  const usable = rows.filter((r) => r.status.level !== 'error')
  const total = usable.reduce((n, r) => n + r.entry.qty, 0)
  const demoReady = useMemo(() => parsePartsList(DEMO_LIST, index.isCode).entries.every((e) => index.isCode(e.code)), [index])
  const built = fromList && doc.instances.length > 0
  const changed = built && text !== doc.partsList

  const replaceCode = (line: number, code: string, replacement: string) => {
    const lines = text.split(/\r?\n/)
    const i = line - 1
    lines[i] = lines[i].includes(code) ? lines[i].replace(code, replacement) : replacement
    setText(lines.join('\n'))
  }

  const build = async () => {
    setBuilding(true)
    try {
      setOutcome(await buildFromList(text, { name: name.trim(), customer: customer.trim(), generic: useGeneric }))
    } catch {
      /* 錯誤訊息由 store 顯示 */
    } finally {
      setBuilding(false)
    }
  }

  const locate = (instance: string) => {
    requestFit(instance)
    onClose()
  }

  const problems = outcome && outcome.notFound.length + outcome.noModel.length + outcome.errors.length + outcome.leftovers.length

  return (
    <Dialog
      wide
      title="依型號清單組裝"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-slate-500" role="status">
            {building || busy ? (busy ?? '自動組裝中…') : changed ? '清單改過了：按「重新組裝」更新模組' : built ? `模組中有 ${doc.instances.length} 個零件` : ''}
          </span>
          <Button onClick={onClose}>{built ? '在 3D 畫面查看' : '關閉'}</Button>
          <Button variant="primary" disabled={!built || building || !!busy} onClick={onIllustrate} title="著色的 3D 圖，標上每個零件的型號與箭頭">
            產生示意圖
          </Button>
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
        <form
          className="flex shrink-0 flex-col gap-2 lg:w-[26rem]"
          onSubmit={(e) => {
            e.preventDefault()
            void build()
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-slate-500">
              模組名稱
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="未命名模組" className={inputClass} />
            </label>
            <label className="block text-xs text-slate-500">
              客戶
              <input value={customer} onChange={(e) => setCustomer(e.target.value)} className={inputClass} />
            </label>
          </div>
          <div className="flex min-h-0 flex-1 flex-col text-xs text-slate-500">
            <div className="flex items-center justify-between">
              <label htmlFor={listId}>型號清單</label>
              {demoReady && (
                <button type="button" className="text-blue-600 hover:underline" onClick={() => setText(DEMO_LIST)}>
                  填入範例
                </button>
              )}
            </div>
            <textarea
              id={listId}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={PLACEHOLDER}
              spellCheck={false}
              rows={12}
              className="mt-0.5 min-h-48 flex-1 resize-none rounded-md border border-slate-300 bg-white p-2 font-mono text-sm leading-6 text-slate-800 placeholder:font-sans placeholder:text-slate-400"
            />
          </div>
          <ul className="space-y-0.5 text-[11px] leading-4 text-slate-500">
            <li>．數量：「×4」「x 4」「4 個」都可以；沒寫就是 1 個</li>
            <li>．指定埠：「→ A、B」「@ EA」「接在 型號 的 P」；沒指定時依規格與以前的搭配自動決定（排氣口優先接消音器）</li>
            <li>．「#」後面是備註；Excel 的表格可以直接貼上</li>
          </ul>
          <label className="flex items-start gap-2 text-xs leading-5 text-slate-600">
            <input type="checkbox" className="mt-1" checked={useGeneric} onChange={(e) => setUseGeneric(e.target.checked)} />
            <span>
              產品庫沒有、或沒有 3D 檔的型號：<strong>自動產生通用 3D</strong>（依型號判斷種類與尺寸的示意模型，埠已定義好）
            </span>
          </label>
          {manual && (
            <p className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-800">目前的模組是手動組的，會保留不動，另外開一個新模組。</p>
          )}
          <Button type="submit" variant="primary" disabled={!total || building || !!busy}>
            {built ? '重新組裝' : '自動組裝'}
            {total > 0 && `（${total} 個零件）`}
          </Button>
        </form>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
          <section aria-label="清單內容" className="space-y-1.5">
            <h3 className="text-sm font-semibold text-slate-700">清單內容</h3>
            {rows.length === 0 && parsed.errors.length === 0 ? (
              <p className="text-xs text-slate-500">在左邊輸入型號，這裡會即時顯示每一行對應的產品。</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-left text-slate-500">
                  <tr className="border-b border-slate-200">
                    <th className="w-8 py-1 font-normal">行</th>
                    <th className="py-1 font-normal">型號</th>
                    <th className="w-12 py-1 text-right font-normal whitespace-nowrap">數量</th>
                    <th className="py-1 pl-3 font-normal whitespace-nowrap">指定</th>
                    <th className="py-1 pl-3 font-normal">產品</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ entry, product, status }, i) => (
                    <tr key={i} className="border-b border-slate-100 align-top" data-list-row={entry.code} data-list-status={status.level}>
                      <td className="py-1 text-slate-400">{entry.line}</td>
                      <td className="py-1 font-mono text-slate-800">{product?.modelCode ?? entry.code}</td>
                      <td className="py-1 text-right">{entry.qty}</td>
                      <td className="py-1 pl-3 font-mono text-slate-600">{hintText(entry.hint)}</td>
                      <td
                        className={`py-1 pl-3 ${status.level === 'error' ? 'text-red-700' : status.level === 'warn' ? 'text-amber-800' : status.level === 'generic' ? 'text-blue-700' : 'text-slate-600'}`}
                      >
                        {status.level === 'ok' ? '✓ ' : status.level === 'warn' ? '! ' : status.level === 'generic' ? '◇ ' : '✕ '}
                        {status.text}
                        {status.similar && status.similar.length > 0 && (
                          <span className="ml-1 inline-flex flex-wrap gap-1">
                            {status.similar.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                className="rounded border border-blue-300 bg-white px-1 font-mono text-blue-700 hover:bg-blue-50"
                                onClick={() => replaceCode(entry.line, entry.code, p.modelCode)}
                              >
                                換成 {p.modelCode}
                              </button>
                            ))}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {parsed.errors.map((e) => (
                    <tr key={`e${e.line}-${e.text}`} className="border-b border-slate-100 text-red-700" data-list-status="error">
                      <td className="py-1 text-slate-400">{e.line}</td>
                      <td colSpan={4} className="py-1">
                        ✕ {e.text}：{e.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {outcome && (
            <section aria-label="組裝結果" className="space-y-1.5">
              <h3 className="text-sm font-semibold text-slate-700">組裝結果</h3>
              <p className="text-xs text-slate-600" data-build-placed={outcome.placed}>
                已組裝 {outcome.placed} 個零件
                {outcome.groups > 1 && `，分成 ${outcome.groups} 組（彼此接不上，並排放置）`}
                {problems ? `；${problems} 項沒有放進模組：` : '，清單上的零件都接上了。'}
              </p>
              <ul className="space-y-1.5 text-xs">
                {outcome.generated.map((g) => (
                  <li key={`gen${g.line}${g.code}`} className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-blue-800" data-outcome="generated">
                    ◇ 第 {g.line} 行 <span className="font-mono">{g.code}</span>：沒有原廠 3D 檔，已用通用 3D 產生（{g.name}
                    {g.by === 'ai' ? '，AI 判斷' : ''}）
                  </li>
                ))}
                {outcome.aiError && (
                  <li className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-amber-800" data-outcome="ai-error">
                    ! AI 判斷失敗：{outcome.aiError}
                  </li>
                )}
                {outcome.notFound.map((n) => (
                  <li key={`nf${n.line}${n.code}`} className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-red-700" data-outcome="not-found">
                    ✕ 第 {n.line} 行「{n.code}」產品庫找不到{n.similar.length > 0 && `（相近：${n.similar.join('、')}）`}
                  </li>
                ))}
                {outcome.errors.map((e) => (
                  <li key={`er${e.line}${e.text}`} className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-red-700" data-outcome="error">
                    ✕ 第 {e.line} 行「{e.text}」：{e.message}
                  </li>
                ))}
                {outcome.noModel.map((n) => (
                  <li key={`nm${n.line}${n.code}`} className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-red-700" data-outcome="no-model">
                    ✕ 第 {n.line} 行「{n.code}」沒有 3D 檔，無法組裝：請先在產品庫匯入
                  </li>
                ))}
                {outcome.leftovers.map((l, i) => (
                  <li key={`lo${i}`} className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-amber-800" data-outcome="leftover">
                    <div className="font-medium">
                      ! {l.line ? `第 ${l.line} 行 ` : ''}
                      <span className="font-mono">{l.code}</span> 有 {l.qty} 個沒有接上
                    </div>
                    <p className="mt-0.5 pl-3 text-slate-600">{l.reason}</p>
                    {l.adapters.length > 0 && (
                      <p className="mt-0.5 pl-3 text-slate-600">
                        建議：
                        {l.adapters.map((a) => `在 ${a.at} 加轉接頭 ${a.adapter}`).join('；或 ')}
                        ，再把它加進清單
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {built && <AssemblyReport onLocate={locate} />}
        </div>
      </div>
    </Dialog>
  )
}
