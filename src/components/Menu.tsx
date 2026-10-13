import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDownIcon } from './icons'

export type MenuItem =
  | { label: string; onSelect: () => void; disabled?: boolean; hint?: string; shortcut?: string }
  | { divider: true }
  | { heading: string }

const GAP = 4
const MARGIN = 8
const HIDDEN: CSSProperties = { visibility: 'hidden', top: 0, left: 0 }

/**
 * 深色工具列上的下拉選單。
 * 工具列在窄螢幕可以橫向捲動（overflow），會裁掉裡面的下拉選單，所以選單放在 body，位置對齊按鈕。
 */
export function Menu({ label, icon, items, align = 'left' }: { label: string; icon?: ReactNode; items: MenuItem[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  // 量按鈕與選單的大小，放在按鈕下方、不超出視窗（先隱藏，量好再顯示）
  const place = useCallback(() => {
    const el = menu.current
    const b = button.current?.getBoundingClientRect()
    if (!el || !b) return
    const width = el.getBoundingClientRect().width
    const top = b.bottom + GAP
    const preferred = align === 'right' ? b.right - width : b.left
    const left = Math.max(MARGIN, Math.min(preferred, window.innerWidth - width - MARGIN))
    el.style.top = `${top}px`
    el.style.left = `${left}px`
    el.style.maxHeight = `${Math.max(120, window.innerHeight - top - MARGIN)}px`
    el.style.visibility = 'visible'
  }, [align])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Node && (button.current?.contains(t) || menu.current?.contains(t)))) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    // 工具列捲動、視窗大小改變時跟著按鈕移動（選單本身捲動不用）
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && menu.current?.contains(e.target))) place()
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  return (
    <div className="relative shrink-0">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 items-center gap-1 rounded-md px-2.5 text-sm font-medium whitespace-nowrap text-slate-100 transition hover:bg-white/10 ${open ? 'bg-white/10' : ''}`}
      >
        {icon}
        <span className="hidden sm:inline">{label}</span>
        <ChevronDownIcon />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={label}
            style={HIDDEN}
            className="fixed z-[60] max-h-[70vh] min-w-56 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 text-sm text-slate-700 shadow-lg"
          >
            {items.map((item, i) => {
              if ('divider' in item) return <div key={i} className="my-1 border-t border-slate-100" />
              if ('heading' in item)
                return (
                  <div key={i} className="px-3 pt-2 pb-1 text-xs font-semibold text-slate-400">
                    {item.heading}
                  </div>
                )
              return (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false)
                    item.onSelect()
                  }}
                  className="flex w-full items-start justify-between gap-4 px-3 py-1.5 text-left hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span>
                    <span className="block">{item.label}</span>
                    {item.hint && <span className="block text-xs text-slate-400">{item.hint}</span>}
                  </span>
                  {item.shortcut && <span className="shrink-0 text-xs text-slate-400">{item.shortcut}</span>}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </div>
  )
}
