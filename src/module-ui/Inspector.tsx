import { useMemo, useState } from 'react'
import { bomColumns, bomTotal, buildBom } from '../assembly/bom'
import { formatMoney } from '../utils/money'
import { suggestPartners } from '../assembly/memory'
import { attachmentBranches } from '../assembly/copyAttachments'
import { estimateTubeLengthOf, getPort, mateChecks, mateRotation, usedPorts } from '../assembly/moduleOps'
import { useLibraryStore } from '../catalog/library'
import { effectivePneumatic, isCircuitType, pneumaticTypeLabel } from '../catalog/pneumatic'
import { CATEGORY_LABEL, hasModel, productLabel, type Product, type ProductCategory } from '../catalog/types'
import { PneumaticFunctionDialog } from '../components/PneumaticFunctionEditor'
import { SymbolPreview } from '../components/SymbolPreview'
import { formatSpec, type MateLevel } from '../threads'
import { portLabel } from './labels'
import { useModuleStore, useTransforms } from './moduleStore'
import { AirSummary } from '../components/sizing/AirSummary'
import { CylinderSizing } from '../components/sizing/CylinderSizing'
import { moduleSizingInputs } from '../sizing/moduleSizing'
import { computeSizing, cycleTimeOf } from '../sizing/sizing'
import { cylinderMotion } from './simulation'
import { deriveModuleCircuit } from '../assembly/moduleCircuit'
import { registry, SIGNAL_PARAM_NAMESPACE } from '../engine'
import type { Vec3 } from '../geometry/vec3'
import { formatMeters, tubeBom } from '../assembly/tubes'
import { LEVEL_COLOR } from '../components/levels'
import { Button, Dialog, Empty, LevelBadge } from '../components/ui'

type Tab = 'part' | 'calc' | 'check' | 'bom'

export function Inspector() {
  const [tab, setTab] = useState<Tab>('part')
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const checks = useMemo(() => mateChecks(doc, products), [doc, products])
  const problems = checks.filter((c) => c.result.level === 'error' || c.result.level === 'warn').length

  const tabs: { id: Tab; label: string }[] = [
    { id: 'part', label: '零件' },
    { id: 'calc', label: '計算' },
    { id: 'check', label: `檢查${checks.length ? `（${checks.length}）` : ''}` },
    { id: 'bom', label: 'BOM' },
  ]
  const open = useModuleStore((s) => s.drawer === 'inspector')
  return (
    <aside
      className={`${open ? 'flex' : 'hidden'} absolute inset-y-0 right-0 z-20 w-80 max-w-full flex-col border-l border-slate-200 bg-white shadow-xl lg:static lg:z-auto lg:flex lg:shrink-0 lg:shadow-none`}
      aria-label="屬性"
    >
      <nav className="flex border-b border-slate-200" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`relative flex-1 py-2.5 text-sm font-medium ${tab === t.id ? 'border-b-2 border-blue-600 text-blue-700' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {t.label}
            {t.id === 'check' && problems > 0 && (
              <span className="ml-1 rounded-full bg-red-600 px-1.5 text-[10px] text-white">{problems}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'part' && <PartTab />}
        {tab === 'calc' && <CalcTab />}
        {tab === 'check' && <CheckTab />}
        {tab === 'bom' && <BomTab />}
      </div>
    </aside>
  )
}

// ---------------- 計算（選型） ----------------

/** 模組中氣缸的選型：負載與缸徑檢核、耗氣量（含實際 PU 管）、閥與管徑 */
function CalcTab() {
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const trace = useModuleStore((s) => s.trace)
  const { setInstanceParams, setSizing, select, requestFit } = useModuleStore.getState()
  const { transforms } = useTransforms()
  const summary = useMemo(
    () => computeSizing(moduleSizingInputs(doc, products, doc.sizing, transforms), doc.sequence, doc.sizing),
    [doc, products, transforms],
  )
  const cycleTime = useMemo(() => cycleTimeOf(trace, trace?.samples[trace.samples.length - 1]?.t ?? 0), [trace])
  if (!summary.rows.length) {
    return (
      <Empty>
        模組中沒有氣缸（或氣缸還沒有設定氣動功能）。
        <br />
        設定後這裡會依負載檢核缸徑，並計算耗氣量、所需流量與建議的閥和管徑。
      </Empty>
    )
  }
  const pressureNote = doc.sizing?.pressure !== undefined ? '選型設定' : doc.supply ? '依供氣口' : '預設值'
  return (
    <div className="space-y-4 p-3">
      <section>
        <h3 className="mb-1.5 text-sm font-semibold text-slate-700">耗氣量</h3>
        <AirSummary
          summary={summary}
          settings={doc.sizing ?? {}}
          onChange={setSizing}
          cycleTime={cycleTime}
          onSelect={(id) => {
            select(id)
            requestFit(id)
          }}
        />
      </section>
      {summary.rows.map((row) => (
        <section key={row.id} className="rounded-md border border-slate-200 p-2" data-calc-cylinder={row.label}>
          <h3 className="text-sm font-semibold text-slate-700">{row.label}</h3>
          <p className="mb-2 text-[11px] text-slate-500">
            Ø{row.cylinder.bore} × {row.cylinder.stroke} mm{row.cylinder.single ? '（單動）' : ''}
          </p>
          <CylinderSizing
            row={row}
            params={doc.instances.find((i) => i.id === row.id)?.params}
            onParam={(key, value) => setInstanceParams(row.id, { [key]: value })}
            pressureNote={pressureNote}
            applyNote="要改缸徑，請在「零件」頁用「更換零件」換成對應的氣缸。"
          />
        </section>
      ))}
    </div>
  )
}

// ---------------- 零件 ----------------

function PartTab() {
  const selected = useModuleStore((s) => s.selected)
  const selectedTube = useModuleStore((s) => s.selectedTube)
  // 長度改變（例如復原）時重新載入輸入框
  const tubeLength = useModuleStore((s) => s.doc.tubes?.find((t) => t.id === s.selectedTube)?.length)
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const mode = useModuleStore((s) => s.mode)
  const setMode = useModuleStore((s) => s.setMode)
  const removeSelected = useModuleStore((s) => s.removeSelected)
  const inst = doc.instances.find((i) => i.id === selected)
  const product = inst && products[inst.productId]
  if (selectedTube) return <TubePanel key={`${selectedTube}:${tubeLength ?? ''}`} tubeId={selectedTube} />
  if (!inst || !product) {
    return (
      <Empty>
        點選 3D 畫面中的零件，就能在這裡編輯型號、名稱與埠。
        <br />
        點選零件上的<strong>埠（箭頭或標籤）</strong>開始連接。
      </Empty>
    )
  }
  return (
    <div className="space-y-4 p-3">
      <ProductForm key={product.id} product={product} />
      <PneumaticSection product={product} />
      <SignalSection key={inst.id} instanceId={inst.id} product={product} />
      <MotionSection product={product} />
      <section>
        <header className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">埠（{product.ports.length}）</h3>
          <span className="flex gap-1.5">
            {hasModel(product) && mode !== 'define-port' && <AutoPortsButton product={product} />}
            <Button size="sm" variant={mode === 'define-port' ? 'primary' : 'default'} onClick={() => setMode(mode === 'define-port' ? 'select' : 'define-port')}>
              {mode === 'define-port' ? '完成新增' : '＋ 新增埠'}
            </Button>
          </span>
        </header>
        <AutoPortsNotice product={product} />
        {mode === 'define-port' && (
          <p className="mb-2 rounded-md bg-blue-50 p-2 text-xs leading-5 text-blue-800">
            在 3D 畫面點選零件上的<strong>孔、凸柱或平面</strong>，系統會自動抓出位置、方向與直徑，並建議規格。
          </p>
        )}
        {product.ports.length === 0 && mode !== 'define-port' && (
          <p className="text-xs leading-5 text-slate-500">
            這個產品還沒有定義任何埠。按「自動找埠」由模型上的孔自動判斷，或按「新增埠」後點選模型上的孔。
          </p>
        )}
        <ul className="space-y-1.5">
          {product.ports.map((p) => (
            <PortRow key={p.id} instanceId={inst.id} product={product} portId={p.id} />
          ))}
        </ul>
      </section>
      <PartActions instanceId={inst.id} product={product} />
      <Button variant="danger" size="sm" onClick={removeSelected}>
        從模組移除這個零件
      </Button>
    </div>
  )
}

/** 零件的快速操作：自動配上常用零件、更換零件、複製、套用到相同零件 */
function PartActions({ instanceId, product }: { instanceId: string; product: Product }) {
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const stats = useModuleStore((s) => s.stats)
  const autoFill = useModuleStore((s) => s.autoFill)
  const duplicateSelected = useModuleStore((s) => s.duplicateSelected)
  const [replacing, setReplacing] = useState(false)
  const applyToSameParts = useModuleStore((s) => s.applyToSameParts)
  const splitInstance = useModuleStore((s) => s.splitInstance)
  const mesh = useModuleStore((s) => s.meshes[product.source.sha256])
  // STEP 有好幾個頂層零件（組立檔，或多實體的單一零件）：可以依結構拆開；舊資料沒有記下結構時，有多個實體就讓使用者試
  const splittable = product.source.format === 'step' && !!mesh && (mesh.groups ? mesh.groups.length >= 2 : mesh.parts.length >= 2)
  // 模組中還有幾個相同的零件、這個零件上接了幾串零件（可以照樣套用）
  const same = useMemo(() => doc.instances.filter((i) => i.productId === product.id && i.id !== instanceId).length, [doc.instances, product.id, instanceId])
  const branches = useMemo(() => (same ? attachmentBranches(doc, instanceId).length : 0), [doc, instanceId, same])
  // 有幾個空著的埠有搭配記錄
  const fillable = useMemo(() => {
    const used = usedPorts(doc, products)
    return product.ports.filter(
      (port) =>
        !used.has(`${instanceId}:${port.id}`) &&
        suggestPartners({ product, port }, Object.values(products), stats).some((sug) => sug.score > 0),
    ).length
  }, [doc, products, stats, product, instanceId])
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={fillable ? 'primary' : 'default'}
          disabled={!fillable}
          onClick={() => void autoFill(instanceId)}
          title={fillable ? '依以前的搭配記錄，把空著的埠一次接上常用的接頭、消音器等' : '空著的埠還沒有搭配記錄'}
        >
          自動配上常用零件{fillable ? `（${fillable}）` : ''}
        </Button>
        <Button size="sm" onClick={() => setReplacing(true)}>
          更換零件…
        </Button>
        <Button size="sm" onClick={() => void duplicateSelected()}>
          複製
        </Button>
        {same > 0 && (
          <Button
            size="sm"
            disabled={!branches}
            onClick={() => applyToSameParts(instanceId)}
            title={
              branches
                ? `把接在這個零件上的 ${branches} 組零件（接頭、消音器…），照樣接到其他 ${same} 個相同零件的同一個埠`
                : '這個零件上還沒有接零件：先接好一個，再套用到其他相同零件'
            }
          >
            套用到其他 {same} 個相同零件
          </Button>
        )}
        {splittable && (
          <Button
            size="sm"
            onClick={() => void splitInstance(instanceId)}
            title="這個 STEP 檔由好幾個頂層零件組成（例如組立檔）：拆成個別零件，各自放在原本的位置。一般的多實體零件（本體＋線圈…）不用拆。"
          >
            依 STEP 結構拆開{mesh?.groups ? `（${mesh.groups.length}）` : ''}
          </Button>
        )}
      </div>
      {replacing && <ReplaceDialog instanceId={instanceId} current={product} onClose={() => setReplacing(false)} />}
    </section>
  )
}

/** 更換零件：同類別的產品排在前面 */
function ReplaceDialog({ instanceId, current, onClose }: { instanceId: string; current: Product; onClose: () => void }) {
  const products = useModuleStore((s) => s.products)
  const thumbs = useLibraryStore((s) => s.thumbs)
  const replace = useModuleStore((s) => s.replaceInstanceProduct)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const list = Object.values(products)
    .filter((p) => p.id !== current.id && hasModel(p))
    .filter((p) => !q || `${p.modelCode} ${p.name} ${p.maker ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => Number(b.category === current.category) - Number(a.category === current.category) || a.modelCode.localeCompare(b.modelCode))
  return (
    <Dialog title={`更換「${current.modelCode}」`} onClose={onClose} footer={<Button onClick={onClose}>取消</Button>}>
      <p className="mb-2 text-xs leading-5 text-slate-500">原本的鎖合會對應到新產品同名或規格相容的埠；對應不到的會拆開。</p>
      <input
        autoFocus
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜尋型號或名稱"
        className="mb-2 h-8 w-full rounded-md border border-slate-300 px-2 text-sm"
      />
      <ul className="max-h-80 space-y-1 overflow-y-auto">
        {list.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              data-replace={p.modelCode}
              onClick={() => {
                void replace(instanceId, p.id)
                onClose()
              }}
              className="flex w-full items-center gap-2 rounded-md border border-slate-200 px-2 py-1 text-left hover:border-blue-400 hover:bg-blue-50"
            >
              <span className="flex h-8 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-slate-50">
                {thumbs[p.source.sha256] && <img src={thumbs[p.source.sha256]} alt="" className="h-full w-full object-contain" />}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-slate-800">{p.modelCode}</span>
                <span className="block truncate text-xs text-slate-500">
                  {[p.name, CATEGORY_LABEL[p.category]].filter(Boolean).join('．')}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}

function ProductForm({ product }: { product: Product }) {
  const updateProduct = useModuleStore((s) => s.updateProduct)
  const [draft, setDraft] = useState({
    modelCode: product.modelCode,
    name: product.name,
    maker: product.maker ?? '',
    series: product.series ?? '',
    price: product.price === undefined ? '' : String(product.price),
    notes: product.notes ?? '',
  })
  const save = (patch: Partial<Product>) => void updateProduct({ ...product, ...patch })
  const field = (key: keyof typeof draft) => ({
    value: draft[key],
    onChange: (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: e.target.value })),
  })
  const commitText = (key: 'name' | 'maker' | 'series' | 'notes') => {
    const value = draft[key].trim()
    if (value === (product[key] ?? '')) return
    save({ [key]: key === 'name' ? value : value || undefined })
  }
  const inputClass = 'mt-0.5 h-8 w-full rounded-md border border-slate-300 px-2 text-sm text-slate-800'
  return (
    <section className="space-y-2">
      <label className="block text-xs text-slate-500">
        型號
        <input
          {...field('modelCode')}
          onBlur={() => draft.modelCode.trim() && draft.modelCode !== product.modelCode && save({ modelCode: draft.modelCode.trim() })}
          className={inputClass}
        />
      </label>
      <label className="block text-xs text-slate-500">
        名稱
        <input {...field('name')} onBlur={() => commitText('name')} placeholder="例如：直通快插接頭" className={inputClass} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-slate-500">
          類別
          <select
            value={product.category}
            onChange={(e) => save({ category: e.target.value as ProductCategory })}
            className={inputClass}
          >
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-slate-500">
          廠牌
          <input {...field('maker')} onBlur={() => commitText('maker')} placeholder="SMC、AirTAC…" className={inputClass} />
        </label>
        <label className="block text-xs text-slate-500">
          系列
          <input {...field('series')} onBlur={() => commitText('series')} className={inputClass} />
        </label>
        <label className="block text-xs text-slate-500">
          單價（選填）
          <input
            {...field('price')}
            inputMode="decimal"
            onBlur={() => {
              const text = draft.price.trim()
              const price = text === '' ? undefined : Number(text)
              if (price !== undefined && !Number.isFinite(price)) return
              if (price !== product.price) save({ price })
            }}
            className={inputClass}
          />
        </label>
      </div>
      <label className="block text-xs text-slate-500">
        備註
        <textarea
          {...field('notes')}
          onBlur={() => commitText('notes')}
          rows={2}
          className="mt-0.5 w-full rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-800"
        />
      </label>
      <p className="text-[11px] text-slate-400">
        {product.source.bytes > 0
          ? `來源檔案：${product.source.fileName}（${(product.source.bytes / 1024).toFixed(0)} KB）`
          : '這個產品還沒有 3D 檔'}
      </p>
    </section>
  )
}

/** 產品的氣動功能：在迴路圖中是哪一種元件（兩個分頁共用） */
function PneumaticSection({ product }: { product: Product }) {
  const [editing, setEditing] = useState(false)
  const pn = effectivePneumatic(product)
  const mapped = pn ? Object.keys(pn.portMap).length : 0
  return (
    <section className="rounded-md border border-slate-200 p-2">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-700">氣動功能</h3>
        <Button size="sm" onClick={() => setEditing(true)}>
          {pn ? '編輯' : '設定'}
        </Button>
      </header>
      {pn ? (
        <div className="mt-1.5 flex items-center gap-2">
          {isCircuitType(pn.type) && (
            <div className="h-10 w-14 shrink-0 rounded border border-slate-100 bg-slate-50 p-0.5">
              <SymbolPreview type={pn.type} params={pn.params} className="h-full w-full" />
            </div>
          )}
          <div className="min-w-0 text-xs leading-5 text-slate-600">
            <p className="truncate">{pneumaticTypeLabel(pn.type)}</p>
            <p className="text-slate-400">
              {pn.inferred ? '自動判斷，請確認' : isCircuitType(pn.type) ? `埠對應 ${mapped} 個` : '不畫在迴路圖'}
            </p>
          </div>
        </div>
      ) : (
        <p className="mt-1 text-xs leading-5 text-slate-500">尚未設定：設定後這個產品就能放進「迴路圖」模擬。</p>
      )}
      {editing && <PneumaticFunctionDialog product={product} onClose={() => setEditing(false)} />}
    </section>
  )
}

const AUTO = '__auto'

/**
 * 訊號（程序控制用）：氣缸代號、電磁線圈的輸出、壓力開關、滾輪閥的觸發位置。
 * 記在這個模組的零件上（同一個產品在不同位置可以不同）；「自動」會在開始模擬或打開程序時依序指定。
 */
function SignalSection({ instanceId, product }: { instanceId: string; product: Product }) {
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const setInstanceParams = useModuleStore((s) => s.setInstanceParams)
  const pn = effectivePneumatic(product)
  const def = pn && isCircuitType(pn.type) && registry.has(pn.type) ? registry.get(pn.type) : undefined
  const keys = def?.params?.filter((p) => SIGNAL_PARAM_NAMESPACE[p.key] || p.key === 'trigger') ?? []
  // 其他零件用掉的名稱（提醒重複）
  const usedBy = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const inst of doc.instances) {
      const p = inst.id === instanceId ? undefined : products[inst.productId]
      const fn = p && effectivePneumatic(p)
      if (!p || !fn || !registry.has(fn.type)) continue
      for (const pd of registry.get(fn.type).params ?? []) {
        const ns = SIGNAL_PARAM_NAMESPACE[pd.key]
        const v = inst.params?.[pd.key]
        if (ns && typeof v === 'string' && v) map.set(`${ns}:${v}`, [...(map.get(`${ns}:${v}`) ?? []), p.modelCode || productLabel(p)])
      }
    }
    return map
  }, [doc.instances, products, instanceId])
  if (!def || !keys.length) return null
  const params = doc.instances.find((i) => i.id === instanceId)?.params
  return (
    <section className="rounded-md border border-slate-200 p-2">
      <h3 className="text-sm font-semibold text-slate-700">訊號（程序控制）</h3>
      <div className="mt-1.5 grid grid-cols-2 gap-2">
        {keys.map((p) => {
          const value = params?.[p.key]
          const ns = SIGNAL_PARAM_NAMESPACE[p.key]
          const shared = ns && typeof value === 'string' && value ? usedBy.get(`${ns}:${value}`) : undefined
          return (
            <label key={p.key} className="block text-xs text-slate-500">
              {p.label}
              <select
                value={typeof value === 'string' ? value : AUTO}
                onChange={(e) => setInstanceParams(instanceId, { [p.key]: e.target.value === AUTO ? undefined : e.target.value })}
                className="mt-0.5 h-8 w-full rounded-md border border-slate-300 bg-white px-1.5 text-sm text-slate-800"
                data-signal-param={p.key}
              >
                <option value={AUTO}>自動</option>
                {p.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {shared && (
                <span className={`mt-0.5 block text-[11px] leading-4 ${ns === 'coil' ? 'text-slate-500' : 'text-amber-700'}`}>
                  {ns === 'coil' ? `與 ${shared.join('、')} 共用，會一起動作` : `與 ${shared.join('、')} 重複`}
                </span>
              )}
            </label>
          )
        })}
      </div>
    </section>
  )
}

const AXES: { label: string; axis: Vec3 }[] = [
  { label: '+X', axis: [1, 0, 0] },
  { label: '−X', axis: [-1, 0, 0] },
  { label: '+Y', axis: [0, 1, 0] },
  { label: '−Y', axis: [0, -1, 0] },
  { label: '+Z', axis: [0, 0, 1] },
  { label: '−Z', axis: [0, 0, -1] },
]

/** 氣缸的可動件：3D 模擬時沿伸出方向移動（沒有設定時依零件名稱 ROD、PISTON… 自動判斷） */
function MotionSection({ product }: { product: Product }) {
  const mesh = useModuleStore((s) => s.meshes[product.source.sha256])
  const updateProduct = useModuleStore((s) => s.updateProduct)
  const pn = effectivePneumatic(product)
  const motion = useMemo(() => cylinderMotion(product, mesh), [product, mesh])
  if (!pn || !isCircuitType(pn.type) || registry.get(pn.type).category !== 'actuator' || !mesh || mesh.parts.length < 2) return null
  const explicit = !!pn.motion?.parts.length
  const save = (parts: number[], axis: Vec3) => {
    const { inferred: _inferred, ...base } = pn
    void updateProduct({ ...product, pneumatic: { ...base, motion: parts.length ? { parts, axis } : undefined } })
  }
  const parts = [...(motion?.parts ?? [])]
  const axis = motion?.axis ?? [1, 0, 0]
  const axisLabel = AXES.find((a) => a.axis.every((v, i) => v === axis[i]))?.label ?? '+X'
  return (
    <section className="rounded-md border border-slate-200 p-2">
      <h3 className="text-sm font-semibold text-slate-700">模擬時移動的零件</h3>
      <p className="mt-0.5 text-[11px] leading-4 text-slate-500">
        {explicit ? '已設定。' : motion ? '依零件名稱自動判斷，可修改。' : '勾選活塞桿等可動件，3D 模擬時會沿伸出方向移動。'}
      </p>
      <ul className="mt-1.5 space-y-0.5 text-xs">
        {mesh.parts.map((part, i) => (
          <li key={i}>
            <label className="flex items-center gap-2 text-slate-700">
              <input
                type="checkbox"
                checked={parts.includes(i)}
                onChange={(e) => save(e.target.checked ? [...parts, i] : parts.filter((k) => k !== i), axis)}
              />
              {part.name || `零件 ${i + 1}`}
            </label>
          </li>
        ))}
      </ul>
      <label className="mt-1.5 flex items-center gap-2 text-xs text-slate-500">
        伸出方向
        <select
          value={axisLabel}
          disabled={!parts.length}
          onChange={(e) => save(parts, AXES.find((a) => a.label === e.target.value)!.axis)}
          className="h-7 rounded border border-slate-300 bg-white px-1 text-slate-800"
        >
          {AXES.map((a) => (
            <option key={a.label}>{a.label}</option>
          ))}
        </select>
        <span className="text-slate-400">（產品座標）</span>
      </label>
    </section>
  )
}

function PortRow({ instanceId, product, portId }: { instanceId: string; product: Product; portId: string }) {
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const editPort = useModuleStore((s) => s.editPort)
  const clickPort = useModuleStore((s) => s.clickPort)
  const connectFrom = useModuleStore((s) => s.connectFrom)
  const setSupply = useModuleStore((s) => s.setSupply)
  const selectTube = useModuleStore((s) => s.selectTube)
  const port = product.ports.find((p) => p.id === portId)!
  const is = (r: { instance: string; port: string }) => r.instance === instanceId && r.port === portId
  const mate = doc.mates.find((m) => is(m.parent) || is(m.child))
  const other = mate && (is(mate.parent) ? mate.child : mate.parent)
  const tube = doc.tubes?.find((t) => is(t.a) || is(t.b))
  const tubeOther = tube && (is(tube.a) ? tube.b : tube.a)
  const isSupply = !!doc.supply && is(doc.supply)
  // 被安裝面封住（閥裝在集裝座上）：底面的 P／排氣口由集裝座供氣、排氣
  const sealed = !mate && !tube && !!port.sealedBy && doc.mates.some((m) => [m.parent, m.child].some((r) => r.instance === instanceId && r.port === port.sealedBy))
  const isFrom = connectFrom?.instance === instanceId && connectFrom.port === portId
  return (
    <li className={`rounded-md border p-2 ${isFrom ? 'border-blue-400 bg-blue-50' : 'border-slate-200'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-sm font-semibold text-slate-800">{port.name}</span>
          {port.detected?.auto && (
            <span className="rounded bg-violet-100 px-1 text-[10px] text-violet-700" title="匯入時由孔徑自動判斷；確認無誤後按「全部確認」，或按「編輯」修改">
              自動
            </span>
          )}
        </span>
        {port.spec ? (
          <span className="truncate text-xs text-slate-600">{formatSpec(port.spec)}</span>
        ) : (
          <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-800">未設定規格</span>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500">
        {tubeOther ? (
          <button type="button" className="truncate text-left text-sky-700 hover:underline" onClick={() => selectTube(tube!.id)}>
            PU 管 {tube!.label}：{portLabel(doc, products, tubeOther)}
          </button>
        ) : (
          <span className={`truncate ${isSupply ? 'font-medium text-red-700' : ''}`}>
            {other ? `已接：${portLabel(doc, products, other)}` : isSupply ? '供氣口（模擬時由這裡供氣）' : sealed ? '裝在集裝座上：由集裝座供氣／排氣' : '未連接'}
          </span>
        )}
        <span className="flex shrink-0 gap-1">
          {!mate && !tube && !sealed && port.spec?.kind !== 'interface' && (
            <Button size="sm" variant="ghost" onClick={() => setSupply(isSupply ? undefined : { instance: instanceId, port: portId })} title="模擬時由這個埠供氣">
              {isSupply ? '取消供氣' : '設為供氣口'}
            </Button>
          )}
          {!mate && !tube && !sealed && (
            <Button size="sm" variant="ghost" onClick={() => clickPort({ instance: instanceId, port: portId })}>
              {isFrom ? '取消' : '連接'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => editPort(product.id, portId)}>
            編輯
          </Button>
        </span>
      </div>
    </li>
  )
}

/** 由 3D 模型自動找埠 */
function AutoPortsButton({ product }: { product: Product }) {
  const autoDetectPorts = useModuleStore((s) => s.autoDetectPorts)
  const [running, setRunning] = useState(false)
  return (
    <Button
      size="sm"
      disabled={running}
      title="從模型上的孔與螺紋凸柱自動找出埠：位置、方向、規格（依孔徑與型號）與名稱"
      onClick={async () => {
        setRunning(true)
        const r = await autoDetectPorts(product.id)
        setRunning(false)
        if (!r) return
        const text = r.added.length
          ? `找到 ${r.added.length} 個新的埠：${r.added.map((p) => `${p.name}${p.spec ? `（${formatSpec(p.spec)}）` : ''}`).join('、')}`
          : r.maybe.length
            ? `沒有確定的新埠；有 ${r.maybe.length} 個不確定的孔列在下方，可以加入`
            : '沒有找到新的埠（模型上可能沒有畫出孔）：請按「新增埠」點選位置'
        useModuleStore.setState({ message: { kind: 'info', text } })
      }}
    >
      {running ? '找埠中…' : '自動找埠'}
    </Button>
  )
}

/** 自動找到的埠要確認；不確定的孔可以加入 */
function AutoPortsNotice({ product }: { product: Product }) {
  const maybe = useModuleStore((s) => s.maybePorts[product.id])
  const { confirmAutoPorts, addDetectedPorts } = useModuleStore.getState()
  const autoPorts = product.ports.filter((p) => p.detected?.auto)
  const auto = autoPorts.filter((p) => p.spec?.kind !== 'interface').length
  const mount = autoPorts.find((p) => p.spec?.kind === 'interface')
  const remaining = (maybe ?? []).filter((m) => !product.ports.some((p) => Math.hypot(...m.candidate.origin.map((v, i) => v - p.frame.origin[i])) < 1))
  if (!auto && !mount && !remaining.length) return null
  return (
    <div className="mb-2 space-y-1.5 rounded-md bg-violet-50 p-2 text-xs leading-5 text-violet-900" data-auto-ports={auto}>
      {(auto > 0 || mount) && (
        <div className="flex items-start justify-between gap-2">
          <span>
            {auto} 個埠是由孔徑<strong>自動判斷</strong>的：請看一下名稱與規格（PT／G 等牙型以型號為準），不對的按「編輯」修改。
            {mount?.spec?.kind === 'interface' && <> 底面另加上「{mount.spec.key}」安裝面，P／排氣由集裝座供應。</>}
          </span>
          <Button size="sm" className="shrink-0 whitespace-nowrap" onClick={() => void confirmAutoPorts(product.id)}>
            全部確認
          </Button>
        </div>
      )}
      {remaining.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-2">
            <span>不確定是不是埠的孔（可能是固定孔）：</span>
            {remaining.length > 1 && (
              <Button size="sm" variant="ghost" onClick={() => void addDetectedPorts(product.id, remaining)}>
                全部加入
              </Button>
            )}
          </div>
          <ul className="mt-1 flex flex-wrap gap-1">
            {remaining.map((m, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="rounded border border-violet-300 bg-white px-1.5 py-0.5 font-mono text-violet-800 hover:bg-violet-100"
                  title={`${m.candidate.shape === 'hole' ? '孔' : '凸柱'} Ø${m.candidate.diameter.toFixed(1)}、深 ${m.candidate.depth.toFixed(1)} mm${m.candidate.through ? '（貫穿）' : ''}`}
                  onClick={() => void addDetectedPorts(product.id, [m])}
                >
                  ＋ {m.spec ? formatSpec(m.spec) : `Ø${m.candidate.diameter.toFixed(1)}`}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** 選取的 PU 管：兩端、管徑、長度（可修改）、刪除 */
function TubePanel({ tubeId }: { tubeId: string }) {
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const { setTubeLength, deleteTube, select } = useModuleStore.getState()
  const tube = doc.tubes?.find((t) => t.id === tubeId)
  const estimate = useMemo(() => (tube ? estimateTubeLengthOf(doc, products, tube) : undefined), [doc, products, tube])
  const [text, setText] = useState(tube?.length !== undefined ? String(tube.length) : '')
  if (!tube) return <Empty>這條 PU 管已經刪除。</Empty>
  const commitLength = () => {
    const v = text.trim() === '' ? undefined : Number(text)
    if (v !== undefined && !(v > 0)) {
      setText(tube.length !== undefined ? String(tube.length) : '')
      return
    }
    if (v !== tube.length) setTubeLength(tube.id, v)
  }
  return (
    <div className="space-y-3 p-3 text-sm">
      <h3 className="font-semibold text-slate-800">PU 管 {tube.label}</h3>
      <ul className="space-y-1 text-xs">
        {[tube.a, tube.b].map((end) => (
          <li key={`${end.instance}:${end.port}`}>
            <button type="button" className="text-left text-slate-700 hover:underline" onClick={() => select(end.instance)}>
              {portLabel(doc, products, end)}
            </button>
          </li>
        ))}
      </ul>
      <label className="block text-xs text-slate-500">
        裁切長度（mm）
        <input
          value={text}
          inputMode="numeric"
          onChange={(e) => setText(e.target.value)}
          onBlur={commitLength}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="mt-0.5 h-8 w-full rounded-md border border-slate-300 px-2 text-sm text-slate-800"
          aria-label="PU 管長度"
        />
      </label>
      {estimate !== undefined && (
        <Button
          size="sm"
          onClick={() => {
            setText(String(estimate))
            setTubeLength(tube.id, estimate)
          }}
        >
          依目前位置重新估算（{estimate} mm）
        </Button>
      )}
      <p className="text-[11px] leading-4 text-slate-400">建議長度＝兩端之間的彎曲長度＋插入快插接頭的長度，進位到 10 mm。BOM 依管徑合計總長。</p>
      <Button size="sm" variant="danger" onClick={() => deleteTube(tube.id)}>
        刪除這條管
      </Button>
    </div>
  )
}

// ---------------- 檢查 ----------------

const ORDER: MateLevel[] = ['error', 'warn', 'unknown', 'ok']

function CheckTab() {
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const rotateMate = useModuleStore((s) => s.rotateMate)
  const disconnectMate = useModuleStore((s) => s.disconnectMate)
  const select = useModuleStore((s) => s.select)
  const checks = useMemo(
    () => mateChecks(doc, products).sort((a, b) => ORDER.indexOf(a.result.level) - ORDER.indexOf(b.result.level)),
    [doc, products],
  )
  const pneumatic = useMemo(() => deriveModuleCircuit(doc, products).warnings, [doc, products])
  if (checks.length === 0 && doc.instances.length === 0) {
    return <Empty>還沒有連接。點選一個零件的埠，再點選另一個零件的埠，就會檢查螺紋並鎖合。</Empty>
  }
  const count = (level: MateLevel) => checks.filter((c) => c.result.level === level).length
  return (
    <div className="space-y-3 p-3">
      {pneumatic.length > 0 && (
        <section aria-label="氣路檢查">
          <h3 className="mb-1 text-xs font-semibold text-slate-600">氣路（3D 模擬、產生迴路圖用）</h3>
          <ul className="space-y-1">
            {pneumatic.map((w, i) => (
              <li key={i}>
                <button
                  type="button"
                  disabled={!w.instance}
                  onClick={() => w.instance && select(w.instance)}
                  className={`w-full rounded px-2 py-1 text-left text-xs leading-4 ${w.kind === 'no-supply' || w.kind === 'unmounted-valve' ? 'bg-red-50 text-red-700' : w.kind === 'open-port' ? 'bg-slate-50 text-slate-600' : 'bg-amber-50 text-amber-800'} ${w.instance ? 'hover:underline' : ''}`}
                >
                  {w.text}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {checks.length === 0 && <p className="text-xs text-slate-500">還沒有鎖合。</p>}
      <div className="flex flex-wrap gap-2 text-xs">
        {ORDER.map((l) => count(l) > 0 && (
          <span key={l} className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: LEVEL_COLOR[l] }} />
            {({ ok: '正確', warn: '注意', error: '不相容', unknown: '未檢查' } as const)[l]} {count(l)}
          </span>
        ))}
      </div>
      <ul className="space-y-2">
        {checks.map(({ mate, result }) => {
          const rotation = mateRotation(getPort(doc, products, mate.parent), getPort(doc, products, mate.child))
          const steps = rotation === 'fixed' ? [] : rotation === 'free' ? [-90, -15, 15, 90] : [360 / rotation.steps]
          return (
            <li key={mate.id} className="rounded-md border border-slate-200 p-2 text-xs" data-mate={mate.id}>
              <div className="mb-1 flex items-start justify-between gap-2">
                <button type="button" className="text-left text-slate-700 hover:underline" onClick={() => select(mate.child.instance)}>
                  {portLabel(doc, products, mate.parent)}
                  <br />↔ {portLabel(doc, products, mate.child)}
                </button>
                <LevelBadge level={result.level} />
              </div>
              <p className="font-medium text-slate-800">{result.summary}</p>
              {result.reasons.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-500">
                  {result.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {steps.length > 0 && <span className="mr-1 text-slate-400">旋轉 {mate.angle}°</span>}
                {steps.map((d) => (
                  <Button key={d} size="sm" onClick={() => rotateMate(mate.id, d)}>
                    {d > 0 ? `+${d}°` : `${d}°`}
                  </Button>
                ))}
                <Button size="sm" variant="danger" className="ml-auto" onClick={() => disconnectMate(mate.id)}>
                  拆開
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ---------------- BOM ----------------

function BomTab() {
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const downloadBomCsv = useModuleStore((s) => s.downloadBomCsv)
  const rows = useMemo(() => buildBom(doc, products), [doc, products])
  const tubes = useMemo(() => tubeBom(doc), [doc])
  if (rows.length === 0) return <Empty>模組中還沒有零件。</Empty>
  const cols = bomColumns(rows.map((r) => r.product))
  const total = bomTotal(rows.map((r) => ({ price: r.product.price, quantity: r.quantity })))
  return (
    <div className="space-y-3 p-3">
      <table className="w-full text-xs" aria-label="BOM">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="py-1 pr-1">項次</th>
            <th className="py-1 pr-1">型號／名稱</th>
            <th className="py-1 text-right">數量</th>
            {cols.price && <th className="py-1 pl-1 text-right">小計</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.product.id} className="border-b border-slate-100 align-top">
              <td className="py-1 pr-1 text-slate-500">{r.index}</td>
              <td className="py-1 pr-1">
                <div className="font-medium text-slate-800">{r.product.modelCode}</div>
                <div className="text-slate-500">
                  {[r.product.name || '—', CATEGORY_LABEL[r.product.category], r.product.maker].filter(Boolean).join('．')}
                </div>
              </td>
              <td className="py-1 text-right font-semibold">{r.quantity}</td>
              {cols.price && (
                <td className="py-1 pl-1 text-right tabular-nums text-slate-700">
                  {r.product.price !== undefined ? formatMoney(r.product.price * r.quantity) : '—'}
                </td>
              )}
            </tr>
          ))}
          {tubes.map((t, i) => (
            <tr key={t.label} className="border-b border-slate-100 align-top" data-tube-row={t.label}>
              <td className="py-1 pr-1 text-slate-500">{rows.length + i + 1}</td>
              <td className="py-1 pr-1">
                <div className="font-medium text-slate-800">PU 管 {t.label}</div>
                <div className="text-slate-500">{t.count} 條</div>
              </td>
              <td className="py-1 text-right font-semibold whitespace-nowrap">{formatMeters(t.length)}</td>
              {cols.price && <td className="py-1 pl-1 text-right text-slate-400">—</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-slate-500">
        共 {doc.instances.length} 個零件、{rows.length} 種型號。
        {total !== undefined && <span className="ml-1 font-semibold text-slate-700">合計 {formatMoney(total)}</span>}
      </p>
      <Button size="sm" onClick={downloadBomCsv}>
        下載 CSV（可用 Excel 開啟）
      </Button>
    </div>
  )
}
