import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { computeTransforms } from '../assembly/moduleOps'
import { tubeLabelOf } from '../assembly/tubes'
import type { IllustrationInfo, IllustrationView } from '../assembly/types'
import { Button, Dialog } from '../components/ui'
import { downloadPdf } from '../drawing/exportSheets'
import {
  DEFAULT_CALLOUT_STYLE,
  calloutMargins,
  contentBounds,
  illustrationSheet,
  labelAt,
  layoutCallouts,
  type CalloutLabel,
} from '../drawing/illustration'
import { FRONT_SIDES } from '../drawing/moduleDrawing'
import type { Pt } from '../drawing/types'
import type { Vec3 } from '../geometry/vec3'
import { useSettingsStore } from '../settings/settings'
import { today } from '../utils/date'
import { downloadFile, safeFileName } from '../utils/download'
import { FOOTER_HEIGHT, illustrationPng, measureLabel, paintIllustration, type IllustrationPaint } from './illustrationPaint'
import { disposeIllustrationRenderer, illustrationItems, renderIllustration, type IllustrationItem, type RenderedIllustration } from './illustrationRender'
import { useModuleStore } from './moduleStore'
import { viewportDirection } from './viewportCamera'

const selectClass = 'mt-0.5 h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-800'
const STYLE = DEFAULT_CALLOUT_STYLE
/** 零件圖最大尺寸（示意圖像素）；輸出 PNG 為 2 倍 */
const MAX_W = 1100
const MAX_H = 640
const RENDER_SCALE = 2

const ISO: { dir: Vec3; up: Vec3 } = { dir: [-0.8, 1, -0.7], up: [0, 0, 1] }

const VIEWS: { value: IllustrationView; label: string }[] = [
  { value: 'current', label: '目前 3D 畫面的角度' },
  ...(Object.keys(FRONT_SIDES) as (keyof typeof FRONT_SIDES)[]).map((k) => ({ value: k as IllustrationView, label: `從${FRONT_SIDES[k].label}看` })),
  { value: 'iso', label: '等角（右前上方）' },
]

const angleBetween = (a: Vec3, b: Vec3) => {
  const la = Math.hypot(...a) || 1
  const lb = Math.hypot(...b) || 1
  return Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb))))
}
const sameCamera = (a?: { dir: Vec3; up: Vec3 }, b?: { dir: Vec3; up: Vec3 }) =>
  !!a && !!b && angleBetween(a.dir, b.dir) < 0.005 && angleBetween(a.up, b.up) < 0.005

/** 視角 → 相機看的方向與畫面上方 */
function directionOf(view: IllustrationView, camera: { dir: Vec3; up: Vec3 } | undefined): { dir: Vec3; up: Vec3 } {
  if (view === 'current') return camera ?? ISO
  if (view === 'iso') return ISO
  const side = FRONT_SIDES[view]
  return { dir: [-side.front[0], -side.front[1], -side.front[2]], up: side.up }
}

interface Group {
  key: string
  text: string
  defaultText: string
  count: number
  anchors: Pt[]
}

/**
 * 產生示意圖：模組的著色 3D 圖，旁邊標上每個零件的型號，箭頭指向零件（同型號一個標註、多條箭頭）。
 * 可拖曳標註調整位置；下載 PNG、複製圖片、或輸出含標題欄的 PDF。
 */
export function IllustrationDialog({ onClose }: { onClose: () => void }) {
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const meshes = useModuleStore((s) => s.meshes)
  const settings = useSettingsStore((s) => s.settings)
  const { setIllustration, loadDocMeshes } = useModuleStore.getState()
  const info: IllustrationInfo = doc.illustration ?? {}
  const view = info.view ?? 'current'
  const color = info.color ?? 'model'
  const edges = info.edges ?? true
  const labelMode = info.label ?? 'code'
  const footer = info.footer ?? true

  // 打開時記下 3D 畫面的視角（之後在 3D 畫面轉動不影響這次的示意圖）
  const [live] = useState(() => viewportDirection())
  const camera = view === 'current' ? (live ?? info.camera) : undefined
  const positionsValid = view !== 'current' || !live || sameCamera(info.camera, live)
  useEffect(() => {
    if (view === 'current' && live && !sameCamera(useModuleStore.getState().doc.illustration?.camera, live))
      setIllustration({ camera: live, positions: undefined })
  }, [view, live, setIllustration])
  const direction = directionOf(view, camera)
  const dirKey = JSON.stringify(direction)

  const [meshesReady, setMeshesReady] = useState(false)
  useEffect(() => {
    let alive = true
    void loadDocMeshes().finally(() => alive && setMeshesReady(true))
    return () => {
      alive = false
    }
  }, [loadDocMeshes])
  useEffect(() => () => disposeIllustrationRenderer(), [])

  // 零件（只在零件、鎖合、位置、PU 管改變時重建）
  const { instances, mates, placements, tubes } = doc
  const items = useMemo(() => {
    const geometryDoc = { ...useModuleStore.getState().doc, instances, mates, placements, tubes }
    const { transforms } = computeTransforms(geometryDoc, products)
    return illustrationItems(geometryDoc, products, meshes, transforms).items
  }, [instances, mates, placements, tubes, products, meshes])
  useEffect(() => () => items.forEach((i) => i.tube && i.geometries.forEach((g) => g.dispose())), [items])

  // ---- 著色圖（WebGL） ----
  const [rendered, setRendered] = useState<{ result: RenderedIllustration; items: IllustrationItem[] } | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [rendering, setRendering] = useState(false)
  useEffect(() => {
    if (!meshesReady) return
    setRendering(true)
    const dir = JSON.parse(dirKey) as { dir: Vec3; up: Vec3 }
    // 先讓畫面顯示「產生中」再算（大模組要幾百毫秒）
    const timer = setTimeout(() => {
      try {
        const result = renderIllustration(items, { ...dir, color, edges, maxW: MAX_W, maxH: MAX_H, scale: RENDER_SCALE })
        setRendered(result ? { result, items } : undefined)
        setError(result ? undefined : items.length ? '無法產生示意圖' : '模組中的零件都沒有 3D 模型，無法畫出示意圖')
      } catch (err) {
        setError(`無法產生示意圖（${err instanceof Error ? err.message : String(err)}）`)
      } finally {
        setRendering(false)
      }
    }, 30)
    return () => clearTimeout(timer)
  }, [meshesReady, items, dirKey, color, edges])

  // ---- 標註群組：同一產品一個（PU 管依管徑） ----
  const hidden = useMemo(() => new Set(info.hidden ?? []), [info.hidden])
  const texts = info.texts
  const groups = useMemo((): Group[] => {
    const list = new Map<string, Group>()
    const ensure = (key: string, defaultText: string, count: number) => {
      let g = list.get(key)
      if (!g) {
        g = { key, defaultText, text: texts?.[key]?.trim() || defaultText, count, anchors: [] }
        list.set(key, g)
      }
      return g
    }
    const counts = new Map<string, number>()
    for (const inst of doc.instances) counts.set(inst.productId, (counts.get(inst.productId) ?? 0) + 1)
    for (const t of doc.tubes ?? []) counts.set(`tube:${tubeLabelOf(t)}`, (counts.get(`tube:${tubeLabelOf(t)}`) ?? 0) + 1)
    const textOf = (key: string): string => {
      const n = counts.get(key) ?? 0
      if (key.startsWith('tube:')) {
        const base = `PU 管 ${key.slice(5)}`
        return labelMode === 'code-qty' ? `${base} ×${n}` : base
      }
      const p = products[key]
      const code = p?.modelCode || p?.name || '（未命名）'
      if (labelMode === 'code-qty') return `${code} ×${n}`
      if (labelMode === 'code-name' && p?.name && p.name !== code) return `${code}（${p.name}）`
      return code
    }
    // 依模組中出現的順序（與零件表相同）
    for (const inst of doc.instances) ensure(inst.productId, textOf(inst.productId), counts.get(inst.productId) ?? 0)
    for (const t of doc.tubes ?? []) ensure(`tube:${tubeLabelOf(t)}`, textOf(`tube:${tubeLabelOf(t)}`), counts.get(`tube:${tubeLabelOf(t)}`) ?? 0)
    if (rendered)
      rendered.items.forEach((item, k) => {
        const a = rendered.result.anchors[k]
        if (a) list.get(item.group)?.anchors.push(a)
      })
    return [...list.values()]
  }, [doc.instances, doc.tubes, products, labelMode, texts, rendered])
  const drawnGroups = useMemo(() => new Set(rendered?.items.map((i) => i.group)), [rendered])

  // ---- 排版（座標：零件圖放在留邊之後；拖曳過的位置以零件圖左上角為原點記錄） ----
  const [drag, setDrag] = useState<{ key: string; x: number; y: number; dx: number; dy: number } | undefined>()
  const [hover, setHover] = useState<string | undefined>()
  const layout = useMemo(() => {
    if (!rendered) return undefined
    const shown = groups.filter((g) => !hidden.has(g.key) && g.anchors.length > 0)
    const measure = (t: string) => measureLabel(t, STYLE.font)
    const margins = calloutMargins(
      shown.map((g) => g.text),
      measure,
      STYLE,
    )
    const image = { x: margins.side, y: margins.top, w: rendered.result.width, h: rendered.result.height }
    const canvas = { w: image.w + margins.side * 2, h: image.h + margins.top * 2 }
    const fixed: Record<string, [number, number]> = {}
    if (positionsValid) for (const [k, p] of Object.entries(info.positions ?? {})) fixed[k] = [p[0] + image.x, p[1] + image.y]
    if (drag) fixed[drag.key] = [drag.x, drag.y]
    const labels = layoutCallouts({
      image,
      canvas,
      groups: shown.map((g) => ({ key: g.key, text: g.text, anchors: g.anchors.map((a): Pt => [a[0] + image.x, a[1] + image.y]) })),
      measure,
      style: STYLE,
      fixed,
    })
    return { image, canvas, labels }
    // info.positions 只在 positionsValid 時使用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered, groups, hidden, info.positions, positionsValid, drag])

  const footerText = useMemo(
    () => ({
      left: [doc.name, doc.customer ? `客戶：${doc.customer}` : '', today()].filter(Boolean).join('　'),
      right: settings.company.name || undefined,
    }),
    [doc.name, doc.customer, settings.company.name],
  )

  // ---- 預覽 ----
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvasRef.current
    if (!el || !layout || !rendered) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const totalH = layout.canvas.h + (footer ? FOOTER_HEIGHT : 0)
    el.width = Math.round(layout.canvas.w * dpr)
    el.height = Math.round(totalH * dpr)
    const ctx = el.getContext('2d')
    if (!ctx) return
    paintIllustration(
      ctx,
      {
        view: { x: 0, y: 0, ...layout.canvas },
        image: layout.image,
        base: rendered.result.canvas,
        labels: layout.labels,
        style: STYLE,
        footer: footer ? footerText : undefined,
        active: drag?.key ?? hover,
      },
      dpr,
    )
  }, [layout, rendered, footer, footerText, drag, hover])

  const toLocal = (e: ReactPointerEvent<HTMLCanvasElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect()
    const totalH = (layout?.canvas.h ?? 0) + (footer ? FOOTER_HEIGHT : 0)
    return [((e.clientX - r.left) / r.width) * (layout?.canvas.w ?? 0), ((e.clientY - r.top) / r.height) * totalH]
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!layout) return
    const p = toLocal(e)
    const hit = labelAt(layout.labels, p)
    if (!hit) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ key: hit.key, x: hit.x, y: hit.y, dx: p[0] - hit.x, dy: p[1] - hit.y })
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!layout) return
    const p = toLocal(e)
    if (drag) {
      const l = layout.labels.find((x) => x.key === drag.key)
      const w = l?.w ?? 0
      const h = l?.h ?? 0
      setDrag({
        ...drag,
        x: Math.max(0, Math.min(layout.canvas.w - w, p[0] - drag.dx)),
        y: Math.max(0, Math.min(layout.canvas.h - h, p[1] - drag.dy)),
      })
      return
    }
    const over = labelAt(layout.labels, p)?.key
    if (over !== hover) setHover(over)
  }
  const onPointerUp = () => {
    if (!drag || !layout) return
    const base = positionsValid ? (info.positions ?? {}) : {}
    setIllustration({ positions: { ...base, [drag.key]: [drag.x - layout.image.x, drag.y - layout.image.y] } })
    setDrag(undefined)
  }

  // ---- 附註：看不到、沒有 3D 模型的零件 ----
  const notes = useMemo(() => {
    const out: string[] = []
    if (!rendered) return out
    const unseen = groups.filter((g) => !hidden.has(g.key) && drawnGroups.has(g.key) && g.anchors.length === 0).map((g) => g.text)
    if (unseen.length) out.push(`這個角度看不到（未標註）：${unseen.join('、')}`)
    const noModel = groups.filter((g) => !g.key.startsWith('tube:') && !drawnGroups.has(g.key)).map((g) => `${g.text}${labelMode === 'code-qty' ? '' : ` ×${g.count}`}`)
    if (noModel.length) out.push(`沒有 3D 模型（未畫出）：${noModel.join('、')}`)
    return out
  }, [rendered, groups, hidden, drawnGroups, labelMode])

  // ---- 輸出 ----
  const exportPaint = (): IllustrationPaint | undefined => {
    if (!layout || !rendered) return undefined
    const b = contentBounds(layout.image, layout.labels)
    const pad = 28
    return {
      view: { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 },
      image: layout.image,
      base: rendered.result.canvas,
      labels: layout.labels,
      style: STYLE,
      footer: footer ? footerText : undefined,
    }
  }
  const fileBase = safeFileName(`${doc.name}-示意圖`)
  const [busy, setBusy] = useState<string | undefined>()
  const [done, setDone] = useState<string | undefined>()
  const run = async (label: string, task: () => Promise<string | void>) => {
    setBusy(label)
    setError(undefined)
    setDone(undefined)
    try {
      const msg = await task()
      if (msg) setDone(msg)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }
  const downloadPng = () =>
    run('產生 PNG…', async () => {
      const p = exportPaint()
      if (!p) return
      const blob = await illustrationPng(p, RENDER_SCALE)
      downloadFile(new Uint8Array(await blob.arrayBuffer()), `${fileBase}.png`, 'image/png')
      return `已下載 ${fileBase}.png`
    })
  const copyImage = () =>
    run('複製圖片…', async () => {
      const p = exportPaint()
      if (!p) return
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('這個瀏覽器不支援複製圖片，請改用「下載 PNG」')
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': illustrationPng(p, RENDER_SCALE) })])
      return '已複製圖片，可以直接貼到 Email、LINE 或 Word'
    })
  const downloadPdfFile = () =>
    run('輸出 PDF（第一次需下載中文字型，約 7 MB）…', async () => {
      const p = exportPaint()
      if (!p || !rendered) return
      const shift = (pt: Pt): Pt => [pt[0] - p.view.x, pt[1] - p.view.y]
      const sheet = illustrationSheet({
        paper: settings.paper,
        title: {
          company: settings.company,
          title: `${doc.name} 示意圖`,
          customer: doc.customer,
          drawingNo: doc.drawing?.number,
          revision: doc.drawing?.revision,
          date: today(),
          drawer: settings.drawer || undefined,
        },
        canvas: { w: p.view.w, h: p.view.h },
        image: { dataUrl: rendered.result.canvas.toDataURL('image/png'), rect: { ...p.image, x: p.image.x - p.view.x, y: p.image.y - p.view.y } },
        labels: p.labels.map((l): CalloutLabel => ({ ...l, x: l.x - p.view.x, y: l.y - p.view.y, anchors: l.anchors.map(shift) })),
        style: STYLE,
        notes,
      })
      await downloadPdf([sheet], fileBase, settings.drawer || undefined)
      return `已下載 ${fileBase}.pdf`
    })

  const set = (patch: Partial<IllustrationInfo>) => setIllustration(patch)
  const toggleGroup = (key: string, show: boolean) => {
    const next = new Set(hidden)
    if (show) next.delete(key)
    else next.add(key)
    set({ hidden: [...next] })
  }
  const setText = (key: string, text: string) => {
    const next = { ...texts }
    if (text.trim()) next[key] = text
    else delete next[key]
    set({ texts: next })
  }

  const ready = !!layout && !rendering
  const status = !meshesReady || (rendering && !rendered) ? '產生中…' : rendering ? '更新中…' : undefined

  return (
    <Dialog
      wide
      title="產生示意圖"
      onClose={onClose}
      footer={
        <>
          <span className={`mr-auto self-center text-xs ${error ? 'text-red-600' : 'text-slate-500'}`} role="status">
            {error ?? busy ?? status ?? done ?? (layout ? `${layout.labels.length} 個型號．拖曳圖上的型號可以移動位置` : '')}
          </span>
          <Button onClick={onClose}>關閉</Button>
          <Button disabled={!ready || !!busy} onClick={() => void downloadPdfFile()}>
            下載 PDF
          </Button>
          <Button disabled={!ready || !!busy} onClick={() => void copyImage()}>
            複製圖片
          </Button>
          <Button variant="primary" disabled={!ready || !!busy} onClick={() => void downloadPng()}>
            下載 PNG
          </Button>
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
        <form className="flex shrink-0 flex-col gap-2 overflow-y-auto lg:w-72" onSubmit={(e) => e.preventDefault()}>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
            <label className="block text-xs text-slate-500">
              視角
              <select
                value={view}
                onChange={(e) => {
                  const v = e.target.value as IllustrationView
                  set({ view: v, positions: undefined, ...(v === 'current' && live && { camera: live }) })
                }}
                className={selectClass}
              >
                {VIEWS.map((v) => (
                  <option key={v.value} value={v.value} disabled={v.value === 'current' && !live && !info.camera}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-slate-500">
              零件顏色
              <select value={color} onChange={(e) => set({ color: e.target.value as 'model' | 'gray' })} className={selectClass}>
                <option value="model">依 3D 檔的顏色</option>
                <option value="gray">統一灰色（型錄風格）</option>
              </select>
            </label>
            <label className="block text-xs text-slate-500">
              標註內容
              <select value={labelMode} onChange={(e) => set({ label: e.target.value as IllustrationInfo['label'] })} className={selectClass}>
                <option value="code">型號</option>
                <option value="code-qty">型號＋數量（×4）</option>
                <option value="code-name">型號＋名稱</option>
              </select>
            </label>
            <div className="flex flex-col justify-end gap-1">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={edges} onChange={(e) => set({ edges: e.target.checked })} />
                零件輪廓線
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={footer} onChange={(e) => set({ footer: e.target.checked })} />
                下方加上模組名稱、客戶、日期
              </label>
            </div>
          </div>
          <p className="text-[11px] leading-4 text-slate-400">「目前 3D 畫面的角度」：先在 3D 畫面轉到想要的角度，再按「產生示意圖」。</p>

          <fieldset className="mt-1 min-h-0 rounded-md border border-slate-200 p-2" aria-label="標註的型號">
            <legend className="px-1 text-xs text-slate-500">標註的型號（可改文字）</legend>
            <ul className="space-y-1.5">
              {groups.map((g) => {
                const drawn = drawnGroups.has(g.key)
                const unseen = drawn && rendered && g.anchors.length === 0
                return (
                  <li key={g.key} className="flex items-center gap-1.5" data-callout-group={g.defaultText}>
                    <input
                      type="checkbox"
                      aria-label={`標註 ${g.defaultText}`}
                      checked={!hidden.has(g.key)}
                      disabled={!drawn}
                      onChange={(e) => toggleGroup(g.key, e.target.checked)}
                    />
                    <input
                      defaultValue={texts?.[g.key] ?? ''}
                      placeholder={g.defaultText}
                      aria-label={`${g.defaultText} 的標註文字`}
                      onBlur={(e) => setText(g.key, e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                      className="h-7 min-w-0 flex-1 rounded border border-slate-300 px-1.5 font-mono text-xs text-slate-800"
                    />
                    <span className="w-14 shrink-0 text-right text-[11px] text-slate-500">
                      {!drawn ? '無 3D' : unseen ? '看不到' : `×${g.count}`}
                    </span>
                  </li>
                )
              })}
            </ul>
          </fieldset>
          <Button size="sm" onClick={() => set({ positions: undefined })} disabled={!Object.keys(info.positions ?? {}).length}>
            重新自動排列標註
          </Button>
        </form>

        <section className="flex min-h-[50vh] min-w-0 flex-1 flex-col gap-2 lg:min-h-0">
          {notes.length > 0 && (
            <ul className="space-y-1 text-xs">
              {notes.map((n) => (
                <li key={n} className="rounded bg-amber-50 px-2 py-1 text-amber-800">
                  {n}
                </li>
              ))}
            </ul>
          )}
          <div className="relative min-h-0 flex-1 overflow-auto rounded-md border border-slate-200 bg-slate-100 p-2" data-testid="illustration-preview">
            {layout ? (
              <canvas
                ref={canvasRef}
                role="img"
                aria-label="示意圖預覽"
                data-labels={JSON.stringify(layout.labels.map((l) => ({ key: l.key, text: l.text, x: Math.round(l.x), y: Math.round(l.y), w: Math.round(l.w), h: Math.round(l.h), arrows: l.anchors.length })))}
                data-size={`${Math.round(layout.canvas.w)}x${Math.round(layout.canvas.h + (footer ? FOOTER_HEIGHT : 0))}`}
                className={`mx-auto block bg-white shadow ${drag ? 'cursor-grabbing' : hover ? 'cursor-grab' : ''}`}
                style={{ width: layout.canvas.w, maxWidth: '100%', height: 'auto', touchAction: 'none' }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={() => !drag && setHover(undefined)}
              />
            ) : (
              <p className="p-6 text-center text-sm text-slate-500">{error ? '無法產生示意圖' : doc.instances.length ? '產生中…' : '模組中還沒有零件'}</p>
            )}
            {rendering && layout && <div className="absolute inset-0 bg-white/40" aria-hidden />}
          </div>
        </section>
      </div>
    </Dialog>
  )
}
