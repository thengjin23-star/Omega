import { useState } from 'react'
import { STANDARD_BORES } from '../engine/components/cylinderDouble'
import {
  FRL_LABEL,
  THREAD_SIZES,
  TUBE_SIZES,
  VALVE_FUNCTION_LABEL,
  VALVE_SERIES,
  MANIFOLD_PORT,
  seriesOf,
  type ValveSeries,
  genericMeta,
  type FrlUnit,
  type GenericSpec,
  type ThreadSize,
  type ThreadStd,
  type ValveFunction,
} from '../catalog/generic/genericParts'
import { Button, Dialog } from '../components/ui'
import { useModuleStore } from './moduleStore'

const selectClass = 'mt-0.5 h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-800'
const inputClass = 'mt-0.5 h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-800'

type Kind =
  | 'fitting-straight'
  | 'fitting-elbow'
  | 'fitting-tee'
  | 'union-straight'
  | 'union-elbow'
  | 'union-tee'
  | 'silencer'
  | 'plug'
  | 'bushing'
  | 'speedController'
  | 'valve'
  | 'manifold'
  | 'cylinder'
  | 'frl'
  | 'gauge'

const KINDS: { value: Kind; label: string }[] = [
  { value: 'fitting-straight', label: '直通快插接頭（外牙）' },
  { value: 'fitting-elbow', label: '彎頭快插接頭（外牙）' },
  { value: 'fitting-tee', label: '三通快插接頭（外牙在中間）' },
  { value: 'union-straight', label: '直通接頭（管對管）' },
  { value: 'union-elbow', label: '彎頭接頭（管對管）' },
  { value: 'union-tee', label: '三通接頭（管對管）' },
  { value: 'silencer', label: '消音器' },
  { value: 'plug', label: '塞頭' },
  { value: 'bushing', label: '轉接頭（外牙 × 內牙）' },
  { value: 'speedController', label: '速度控制接頭' },
  { value: 'valve', label: '電磁閥（A／B 在上、P／排氣在底面，可裝集裝座）' },
  { value: 'manifold', label: '集裝座（P／排氣在端面）' },
  { value: 'cylinder', label: '氣缸' },
  { value: 'frl', label: '三點組合／過濾器／調壓閥' },
  { value: 'gauge', label: '壓力錶' },
]

const usesThread = (k: Kind) => !k.startsWith('union') && k !== 'cylinder' && k !== 'manifold'
const usesTube = (k: Kind) => k.startsWith('fitting') || k.startsWith('union') || k === 'speedController'

/**
 * 產生通用 3D 零件：沒有原廠 3D 檔（或沒有型號）的零件，依種類與尺寸產生示意模型，埠也一併定義好。
 */
export function GenericPartDialog({ onClose }: { onClose: () => void }) {
  const { createGenericParts, addProductToModule } = useModuleStore.getState()
  const busy = useModuleStore((s) => s.busy)
  const [kind, setKind] = useState<Kind>('fitting-straight')
  const [thread, setThread] = useState<ThreadSize>('1/8')
  const [std, setStd] = useState<ThreadStd>('PT')
  const [tube, setTube] = useState(6)
  const [inner, setInner] = useState<ThreadSize>('1/8')
  const [fn, setFn] = useState<ValveFunction>('52Single')
  const [exhaust, setExhaust] = useState<ThreadSize | ''>('')
  const [stations, setStations] = useState(4)
  const [series, setSeries] = useState<ValveSeries | 0>(0)
  const [bore, setBore] = useState(32)
  const [stroke, setStroke] = useState(100)
  const [single, setSingle] = useState(false)
  const [unit, setUnit] = useState<FrlUnit>('filterRegulator')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()

  const spec = ((): GenericSpec => {
    switch (kind) {
      case 'fitting-straight':
      case 'fitting-elbow':
      case 'fitting-tee':
        return { kind: 'fitting', form: kind === 'fitting-straight' ? 'straight' : kind === 'fitting-elbow' ? 'elbow' : 'tee', thread, std, tube }
      case 'union-straight':
      case 'union-elbow':
      case 'union-tee':
        return { kind: 'fitting', form: kind === 'union-straight' ? 'straight' : kind === 'union-elbow' ? 'elbow' : 'tee', tube }
      case 'silencer':
      case 'plug':
      case 'gauge':
        return { kind, thread, std }
      case 'bushing':
        return { kind: 'bushing', thread, inner, std }
      case 'speedController':
        return { kind: 'speedController', thread, tube, std }
      case 'valve':
        return { kind: 'valve', fn, thread, std, ...(exhaust && exhaust !== thread && { exhaust }), ...(series && { series }) }
      case 'manifold':
        return { kind: 'manifold', stations, series: series || 200, std }
      case 'cylinder':
        return { kind: 'cylinder', bore, stroke, single }
      case 'frl':
        return { kind: 'frl', unit, thread, std }
    }
  })()
  const meta = genericMeta(spec)

  const create = async (add: boolean) => {
    setError(undefined)
    try {
      const [product] = await createGenericParts([{ spec, modelCode: code.trim() || undefined, name: name.trim() || undefined }])
      if (add) await addProductToModule(product.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const sizes = (list: readonly ThreadSize[] = THREAD_SIZES) => list.map((s) => <option key={s} value={s}>{s === 'M5' || s === 'M6' ? s : `${std}${s}`}</option>)

  return (
    <Dialog
      title="產生通用 3D 零件"
      onClose={onClose}
      footer={
        <>
          <span className={`mr-auto self-center text-xs ${error ? 'text-red-600' : 'text-slate-500'}`} role="status">
            {error ?? busy ?? ''}
          </span>
          <Button onClick={onClose}>取消</Button>
          <Button disabled={!!busy} onClick={() => void create(false)}>
            只加到產品庫
          </Button>
          <Button variant="primary" disabled={!!busy} onClick={() => void create(true)}>
            產生並加入模組
          </Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => e.preventDefault()}>
        <p className="text-xs leading-5 text-slate-500">
          沒有原廠 3D 檔、或是沒有型號的零件：依種類與尺寸產生<strong>示意模型</strong>，埠（螺紋、快插、安裝面）也一併定義好，可以直接組裝、出示意圖。
          形狀不是實物，但接口尺寸接近實物。
        </p>
        <label className="block text-xs text-slate-500">
          種類
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={selectClass} aria-label="種類">
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          {usesThread(kind) && (
            <label className="block text-xs text-slate-500">
              {kind === 'bushing' ? '外牙' : kind === 'valve' || kind === 'frl' ? '接管口徑' : '螺紋'}
              <select value={thread} onChange={(e) => setThread(e.target.value as ThreadSize)} className={selectClass} aria-label="螺紋">
                {sizes()}
              </select>
            </label>
          )}
          {usesThread(kind) && (
            <label className="block text-xs text-slate-500">
              牙型
              <select value={std} onChange={(e) => setStd(e.target.value as ThreadStd)} className={selectClass} aria-label="牙型">
                <option value="PT">PT（R／Rc 錐管）</option>
                <option value="G">G（PF 平行管）</option>
                <option value="NPT">NPT</option>
              </select>
            </label>
          )}
          {usesTube(kind) && (
            <label className="block text-xs text-slate-500">
              管徑
              <select value={tube} onChange={(e) => setTube(Number(e.target.value))} className={selectClass} aria-label="管徑">
                {TUBE_SIZES.map((t) => (
                  <option key={t} value={t}>
                    Ø{t}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === 'bushing' && (
            <label className="block text-xs text-slate-500">
              內牙
              <select value={inner} onChange={(e) => setInner(e.target.value as ThreadSize)} className={selectClass} aria-label="內牙">
                {sizes()}
              </select>
            </label>
          )}
          {(kind === 'valve' || kind === 'manifold') && (
            <label className="block text-xs text-slate-500">
              大小系列（閥與集裝座要相同）
              <select
                value={kind === 'manifold' ? series || 200 : series}
                onChange={(e) => setSeries(Number(e.target.value) as ValveSeries | 0)}
                className={selectClass}
                aria-label="系列"
              >
                {kind === 'valve' && <option value={0}>依接管口（{seriesOf(thread)} 系列）</option>}
                {VALVE_SERIES.map((v) => (
                  <option key={v} value={v}>
                    {v} 系列（亞德客 4V{v} 大小{kind === 'manifold' ? `，P／排氣 PT${MANIFOLD_PORT[v]}` : ''}）
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === 'valve' && (
            <label className="block text-xs text-slate-500">
              功能
              <select value={fn} onChange={(e) => setFn(e.target.value as ValveFunction)} className={selectClass} aria-label="閥的功能">
                {(Object.keys(VALVE_FUNCTION_LABEL) as ValveFunction[]).map((f) => (
                  <option key={f} value={f}>
                    {VALVE_FUNCTION_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === 'valve' && (
            <label className="block text-xs text-slate-500">
              排氣口（不同時才選）
              <select value={exhaust} onChange={(e) => setExhaust(e.target.value as ThreadSize | '')} className={selectClass} aria-label="排氣口">
                <option value="">與接管口相同</option>
                {sizes()}
              </select>
            </label>
          )}
          {kind === 'manifold' && (
            <label className="block text-xs text-slate-500">
              站數
              <input type="number" min={1} max={20} value={stations} onChange={(e) => setStations(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} className={inputClass} aria-label="站數" />
            </label>
          )}
          {kind === 'cylinder' && (
            <>
              <label className="block text-xs text-slate-500">
                缸徑
                <select value={bore} onChange={(e) => setBore(Number(e.target.value))} className={selectClass} aria-label="缸徑">
                  {STANDARD_BORES.filter((b) => b >= 6 && b <= 200).map((b) => (
                    <option key={b} value={b}>
                      Ø{b}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-slate-500">
                行程（mm）
                <input type="number" min={1} max={2000} value={stroke} onChange={(e) => setStroke(Math.max(1, Math.min(2000, Number(e.target.value) || 1)))} className={inputClass} aria-label="行程" />
              </label>
              <label className="col-span-2 flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={single} onChange={(e) => setSingle(e.target.checked)} />
                單動（只有一個接管口）
              </label>
            </>
          )}
          {kind === 'frl' && (
            <label className="block text-xs text-slate-500">
              組合
              <select value={unit} onChange={(e) => setUnit(e.target.value as FrlUnit)} className={selectClass} aria-label="組合">
                {(Object.keys(FRL_LABEL) as FrlUnit[]).map((u) => (
                  <option key={u} value={u}>
                    {FRL_LABEL[u]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs text-slate-500">
            型號（選填）
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={meta.modelCode} className={inputClass} aria-label="型號" />
          </label>
          <label className="block text-xs text-slate-500">
            名稱（選填）
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={meta.name} className={inputClass} aria-label="名稱" />
          </label>
        </div>
        <p className="text-[11px] leading-4 text-slate-400">沒填型號時，示意圖上會標「{meta.modelCode}」，之後可以在示意圖改標註文字。</p>
      </form>
    </Dialog>
  )
}
