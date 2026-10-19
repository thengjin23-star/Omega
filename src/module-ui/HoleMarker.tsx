import { useMemo } from 'react'
import { Quaternion, Vector3 } from 'three'
import type { DetectedPort, PortCandidate } from '../catalog/autoPorts'
import { OverlayHtml } from './OverlayHtml'
import { useModuleStore } from './moduleStore'

const Y = new Vector3(0, 1, 0)

/**
 * 不確定是不是埠的孔、以及太小不會是埠的孔（固定螺絲孔、定位孔）：選取零件時以灰色圓圈標出，
 * 幫忙判斷安裝方向。hole 有值（可能是埠）時，點標籤可以加入為埠。
 */
export function HoleMarker({ productId, candidate: c, hole }: { productId: string; candidate: PortCandidate; hole?: DetectedPort }) {
  const quaternion = useMemo(() => new Quaternion().setFromUnitVectors(Y, new Vector3(...c.axis)), [c.axis])
  const r = Math.max(1.2, c.diameter / 2)
  const d = Math.round(c.diameter * 10) / 10
  const label = c.through ? `貫穿孔 Ø${d}（固定孔？）` : `孔 Ø${d}（${hole ? '埠？' : '定位孔？'}）`
  return (
    <group position={c.origin} quaternion={quaternion}>
      <mesh position={[0, 0.3, 0]} renderOrder={2}>
        <torusGeometry args={[r + 0.4, 0.35, 8, 32]} />
        <meshBasicMaterial color="#64748b" transparent opacity={0.85} />
      </mesh>
      <OverlayHtml position={[0, 3, 0]} center zIndexRange={[15, 0]}>
        {hole ? (
          <button
            type="button"
            data-hole={label}
            className="rounded-full border border-dashed border-slate-400 bg-white/90 px-1.5 py-px text-[10px] leading-4 whitespace-nowrap text-slate-500 hover:border-blue-500 hover:text-blue-700"
            title={`不確定是不是埠（${label}）。如果是氣路的口，點一下加入為埠（之後可以編輯名稱與規格）`}
            onClick={(e) => {
              e.stopPropagation()
              void useModuleStore.getState().addDetectedPorts(productId, [hole])
            }}
          >
            ＋ {label}
          </button>
        ) : (
          <span
            data-hole={label}
            className="pointer-events-none rounded-full border border-dashed border-slate-300 bg-white/80 px-1.5 py-px text-[10px] leading-4 whitespace-nowrap text-slate-400"
            title="太小，不會是氣路的口：多半是固定螺絲孔或定位孔，可以用來判斷安裝方向"
          >
            {label}
          </span>
        )}
      </OverlayHtml>
    </group>
  )
}
