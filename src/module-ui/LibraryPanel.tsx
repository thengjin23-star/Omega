import { useMemo, useRef, useState } from 'react'
import { useLibraryStore } from '../catalog/library'
import { CATEGORY_LABEL, hasModel, type Product, type ProductCategory } from '../catalog/types'
import { NewProductDialog } from '../components/NewProductDialog'
import { genericFromCode } from '../catalog/generic/genericParts'
import { decodeModelCode } from '../catalog/makerCodes'
import { GenericPartDialog } from './GenericPartDialog'
import { Button, LevelBadge } from '../components/ui'
import { formatSpecShort } from '../threads'
import { portLabel } from './labels'
import { useModuleStore, useSuggestions } from './moduleStore'

export const ACCEPT_FILES = '.step,.stp,.iges,.igs,.plib,.pmod'
const CAD_FILES = '.step,.stp,.iges,.igs'

/** 搜尋用的文字：型號、名稱、類別、廠牌、系列、備註，以及每個埠的規格 */
function searchText(p: Product): string {
  return [
    p.modelCode,
    p.name,
    CATEGORY_LABEL[p.category],
    p.maker,
    p.series,
    p.notes,
    ...p.ports.map((port) => (port.spec ? formatSpecShort(port.spec) : '')),
  ]
    .join(' ')
    .toLowerCase()
}

export function LibraryPanel() {
  const products = useModuleStore((s) => s.products)
  const thumbs = useLibraryStore((s) => s.thumbs)
  const importFiles = useModuleStore((s) => s.importFiles)
  const installSampleLibrary = useModuleStore((s) => s.installSampleLibrary)
  const exportLibraryFile = useModuleStore((s) => s.exportLibraryFile)
  const addProductToModule = useModuleStore((s) => s.addProductToModule)
  const attachModel = useModuleStore((s) => s.attachModel)
  const deleteProduct = useModuleStore((s) => s.deleteProduct)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<ProductCategory | 'all'>('all')
  const [creating, setCreating] = useState(false)
  const [generic, setGeneric] = useState(false)
  const suggestions = useSuggestions()
  const doc = useModuleStore((s) => s.doc)
  const addAndConnect = useModuleStore((s) => s.addAndConnect)
  const cancelConnect = useModuleStore((s) => s.cancelConnect)
  const input = useRef<HTMLInputElement>(null)
  const attachInput = useRef<HTMLInputElement>(null)
  const attachTarget = useRef<string | undefined>(undefined)

  const all = useMemo(() => Object.values(products).sort((a, b) => a.modelCode.localeCompare(b.modelCode)), [products])
  const counts = useMemo(() => {
    const c: Partial<Record<ProductCategory, number>> = {}
    for (const p of all) c[p.category] = (c[p.category] ?? 0) + 1
    return c
  }, [all])
  const list = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return all.filter((p) => {
      if (category !== 'all' && p.category !== category) return false
      if (!words.length) return true
      const text = searchText(p)
      return words.every((w) => text.includes(w))
    })
  }, [all, query, category])

  const onPick = (p: Product) => {
    if (hasModel(p)) {
      void addProductToModule(p.id)
      return
    }
    const info = decodeModelCode(p.modelCode)
    const spec = info && genericFromCode(info)
    if (spec && window.confirm(`「${p.modelCode}」還沒有 3D 檔。要用通用 3D（依型號產生的示意模型，埠已定義好）代替嗎？\n按「取消」則改為選擇 STEP／IGES 檔。`)) {
      void (async () => {
        const [made] = await useModuleStore.getState().createGenericParts([{ spec, productId: p.id, name: p.name || info.name, maker: info.maker }])
        await addProductToModule(made.id)
      })()
      return
    }
    if (!window.confirm(`「${p.modelCode}」還沒有 3D 檔。要現在選擇 STEP／IGES 檔附加上去嗎？`)) return
    attachTarget.current = p.id
    attachInput.current?.click()
  }

  const open = useModuleStore((s) => s.drawer === 'library')
  const chip = (active: boolean) =>
    `shrink-0 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap ${active ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`

  return (
    <aside
      className={`${open ? 'flex' : 'hidden'} absolute inset-y-0 left-0 z-20 w-72 flex-col border-r border-slate-200 bg-white shadow-xl lg:static lg:z-auto lg:flex lg:w-64 lg:shrink-0 lg:shadow-none`}
      aria-label="產品庫"
    >
      <div className="space-y-2 border-b border-slate-200 p-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-700">產品庫</h2>
          <span className="text-xs text-slate-400">{all.length} 個產品</span>
        </div>
        <Button variant="primary" className="w-full" onClick={() => input.current?.click()}>
          匯入 3D 檔（STEP／IGES）
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT_FILES}
          hidden
          data-testid="library-file-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            void importFiles(files)
          }}
        />
        <input
          ref={attachInput}
          type="file"
          accept={CAD_FILES}
          hidden
          data-testid="attach-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file && attachTarget.current) void attachModel(attachTarget.current, file)
          }}
        />
        <div className="flex gap-2">
          <Button size="sm" className="flex-1" onClick={() => void installSampleLibrary()}>
            安裝範例零件
          </Button>
          <Button size="sm" className="flex-1" onClick={() => void exportLibraryFile()} disabled={all.length === 0}>
            匯出產品庫
          </Button>
        </div>
        <Button size="sm" variant="ghost" className="w-full" onClick={() => setGeneric(true)} title="沒有原廠 3D 檔或沒有型號：依種類與尺寸產生示意模型（埠已定義好）">
          ＋ 產生通用 3D 零件
        </Button>
        <Button size="sm" variant="ghost" className="w-full" onClick={() => setCreating(true)}>
          ＋ 新增產品（無 3D 檔）
        </Button>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋型號、名稱或規格（Rc1/8）"
          aria-label="搜尋產品"
          className="h-8 w-full rounded-md border border-slate-300 px-2 text-sm"
        />
        {all.length > 0 && (
          <div className="flex flex-wrap gap-1" role="group" aria-label="依類別篩選">
            <button type="button" className={chip(category === 'all')} onClick={() => setCategory('all')}>
              全部
            </button>
            {(Object.keys(CATEGORY_LABEL) as ProductCategory[])
              .filter((c) => counts[c])
              .map((c) => (
                <button key={c} type="button" className={chip(category === c)} onClick={() => setCategory(category === c ? 'all' : c)}>
                  {CATEGORY_LABEL[c]} {counts[c]}
                </button>
              ))}
          </div>
        )}
      </div>

      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {suggestions.from && (
          <li className="mb-2 rounded-md border border-blue-200 bg-blue-50/60 p-2" aria-label="可接的零件">
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <p className="text-xs leading-4 text-blue-900">
                可接到 <strong>{portLabel(doc, products, suggestions.from)}</strong>
                {(() => {
                  const spec = doc.instances.find((i) => i.id === suggestions.from!.instance)
                  const port = spec && products[spec.productId]?.ports.find((p) => p.id === suggestions.from!.port)
                  return port?.spec ? `（${formatSpecShort(port.spec)}）` : ''
                })()}
                的零件；常用的排在前面：
              </p>
              <button type="button" className="shrink-0 text-xs text-blue-700 hover:underline" onClick={cancelConnect}>
                取消
              </button>
            </div>
            {suggestions.list.length === 0 ? (
              <p className="text-xs text-slate-500">產品庫中沒有規格相容的零件。也可以直接在 3D 畫面點另一個零件的埠。</p>
            ) : (
              <ul className="space-y-1">
                {suggestions.list.slice(0, 12).map((sug) => (
                  <li key={sug.product.id}>
                    <button
                      type="button"
                      onClick={() => void addAndConnect(sug.product.id, sug.port.id)}
                      data-suggestion={sug.product.modelCode}
                      className="flex w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-left hover:border-blue-400"
                    >
                      <span className="flex h-7 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-slate-50">
                        {thumbs[sug.product.source.sha256] && <img src={thumbs[sug.product.source.sha256]} alt="" className="h-full w-full object-contain" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-slate-800">{sug.product.modelCode}</span>
                        <span className="block truncate text-[11px] text-slate-500">
                          接 {sug.port.name}
                          {sug.port.spec ? `（${formatSpecShort(sug.port.spec)}）` : ''}
                          {sug.uses > 0 && <span className="ml-1 text-emerald-700">用過 {sug.uses} 次</span>}
                        </span>
                      </span>
                      <LevelBadge level={sug.level} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        )}
        {all.length === 0 && (
          <li className="p-2 text-xs leading-5 text-slate-500">產品庫是空的。匯入公司產品的 STEP 檔，或先安裝範例零件試用。</li>
        )}
        {all.length > 0 && list.length === 0 && <li className="p-2 text-xs text-slate-500">沒有符合的產品。</li>}
        {list.map((p) => {
          const unset = p.ports.filter((x) => !x.spec).length
          const thumb = thumbs[p.source.sha256]
          return (
            <li key={p.id} className="group relative">
              <button
                type="button"
                onClick={() => onPick(p)}
                title={hasModel(p) ? '加入目前的模組' : '還沒有 3D 檔：點一下附加'}
                data-product={p.modelCode}
                className="flex w-full items-center gap-2 rounded-md border border-transparent px-1.5 py-1.5 text-left hover:border-blue-300 hover:bg-blue-50"
              >
                <span className="flex h-9 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-slate-50">
                  {thumb ? (
                    <img src={thumb} alt="" className="h-full w-full object-contain" />
                  ) : (
                    <span className="text-[10px] text-slate-300">{hasModel(p) ? '…' : '無 3D'}</span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate pr-6 text-sm font-medium text-slate-800">{p.modelCode}</span>
                  {p.name && <span className="block truncate text-xs text-slate-500">{p.name}</span>}
                  <span className="block truncate text-[11px] text-slate-400">
                    {[CATEGORY_LABEL[p.category], p.maker, `埠 ${p.ports.length}`].filter(Boolean).join('．')}
                    {unset > 0 && <span className="text-amber-600">（{unset} 個未設定規格）</span>}
                    {!hasModel(p) && <span className="ml-1 rounded bg-slate-100 px-1 text-slate-500">無 3D</span>}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`從產品庫刪除「${p.modelCode}」？（包含 3D 檔與已定義的埠）`)) void deleteProduct(p.id)
                }}
                className="absolute top-1.5 right-1 hidden rounded px-1 text-xs text-slate-400 group-hover:block hover:bg-red-50 hover:text-red-600"
                aria-label={`刪除 ${p.modelCode}`}
              >
                刪除
              </button>
            </li>
          )
        })}
      </ul>

      <p className="border-t border-slate-200 p-3 text-[11px] leading-5 text-slate-500">
        也可以直接把 STEP 檔拖進 3D 畫面。產品與埠記在這台電腦的瀏覽器裡，請定期在「設定」下載完整備份。
      </p>
      {creating && <NewProductDialog onClose={() => setCreating(false)} />}
      {generic && <GenericPartDialog onClose={() => setGeneric(false)} />}
    </aside>
  )
}
