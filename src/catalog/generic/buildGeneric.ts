/**
 * 通用零件的形狀（replicad）。埠的位置由同一組尺寸算出，所以定義的埠一定與模型的孔、凸柱吻合。
 * 呼叫前要先 setOC（Web Worker 或測試中載入 OpenCascade）。
 */
import { drawPolysides, makeBox, makeCylinder, type Shape3D } from 'replicad'
import { defaultRodDiameter } from '../../engine/components/cylinderDouble'
import type { Vec3 } from '../../geometry/vec3'
import type { SamplePortDef } from '../samples'
import {
  MANIFOLD_PORT,
  cylinderPortSize,
  seriesInterfaceKey,
  seriesOf,
  threadSpecText,
  type GenericSpec,
  type ThreadSize,
  type ThreadStd,
  type ValveSeries,
} from './genericParts'

export interface BuiltPart {
  shapes: { shape: Shape3D; name: string; color: string }[]
  ports: SamplePortDef[]
}

// ---------------------------------------------------------------- 尺寸（mm）

/** 母牙孔徑（約為攻牙徑／小徑，自動找埠可以認得） */
const HOLE_D: Record<ThreadSize, number> = { M5: 4.2, M6: 5, '1/8': 8.6, '1/4': 11.4, '3/8': 14.9, '1/2': 18.6, '3/4': 24.1 }
/** 公牙外徑 */
const BOSS_D: Record<ThreadSize, number> = { M5: 5, M6: 6, '1/8': 9.73, '1/4': 13.16, '3/8': 16.66, '1/2': 20.96, '3/4': 26.44 }
const NPT_D: Partial<Record<ThreadSize, number>> = { '1/8': 10.29, '1/4': 13.72, '3/8': 17.15, '1/2': 21.34, '3/4': 26.67 }
const HEX_AF: Record<ThreadSize, number> = { M5: 8, M6: 10, '1/8': 14, '1/4': 17, '3/8': 21, '1/2': 26, '3/4': 32 }
const STEM_L: Record<ThreadSize, number> = { M5: 4, M6: 5, '1/8': 7, '1/4': 9, '3/8': 10, '1/2': 13, '3/4': 15 }
const HOLE_DEPTH: Record<ThreadSize, number> = { M5: 6, M6: 7, '1/8': 9, '1/4': 11, '3/8': 12, '1/2': 15, '3/4': 17 }
/** 電磁閥本體（不含線圈）：長、寬、高，依系列（約為亞德客 4V100～4V400 的大小） */
const VALVE_BODY: Record<ValveSeries, { L: number; W: number; H: number }> = {
  100: { L: 50, W: 18, H: 26 },
  200: { L: 62, W: 22, H: 32 },
  300: { L: 78, W: 28, H: 38 },
  400: { L: 96, W: 36, H: 48 },
}
/** 接管口裝得下的最小系列 */
const MIN_SERIES: Record<ThreadSize, ValveSeries> = { M5: 100, M6: 100, '1/8': 100, '1/4': 200, '3/8': 300, '1/2': 400, '3/4': 400 }
/** 閥的實際系列：指定的系列太小、裝不下接管口時加大 */
export const valveSeries = (thread: ThreadSize, series?: ValveSeries): ValveSeries => Math.max(series ?? seriesOf(thread), MIN_SERIES[thread]) as ValveSeries
/** 閥底面安裝面的原點：避開 P 口（偏向閥的 -Y 側），集裝座的站位用同樣的偏移 */
const mountOffset = (series: ValveSeries) => VALVE_BODY[series].W / 2 - 3
/** 三點組合本體邊長 */
const FRL_SIZE: Record<ThreadSize, number> = { M5: 26, M6: 26, '1/8': 30, '1/4': 40, '3/8': 50, '1/2': 60, '3/4': 70 }

const METAL = '#b9c1c9'
const DARK = '#2f3a45'
const BRASS = '#c9b27c'
const BLUE = '#2563eb'
const BRONZE = '#a8875a'
const BOWL = '#94a3b8'

// ---------------------------------------------------------------- 小工具

const at = (a: Vec3, dir: Vec3, k: number): Vec3 => [a[0] + dir[0] * k, a[1] + dir[1] * k, a[2] + dir[2] * k]
const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]]
const cyl = (d: number, h: number, base: Vec3, dir: Vec3 = [0, 0, 1]): Shape3D => makeCylinder(d / 2, h, base, dir)
const box = (a: Vec3, b: Vec3): Shape3D => makeBox(a, b)
/** 六角柱（沿 Z）：對邊 af，從 z0 往上 h */
const hexZ = (af: number, h: number, z0: number): Shape3D => drawPolysides(af / Math.sqrt(3), 6).sketchOnPlane('XY', z0).extrude(h) as Shape3D
/** 在 mouth 處沿 -axis 方向鑽深 depth 的孔（稍微超出表面，布林運算才乾淨） */
const drill = (shape: Shape3D, d: number, depth: number, mouth: Vec3, axis: Vec3): Shape3D =>
  shape.cut(cyl(d, depth + 0.2, at(mouth, axis, 0.2), neg(axis)))
const bossD = (size: ThreadSize, std: ThreadStd = 'PT') => (std === 'NPT' ? (NPT_D[size] ?? BOSS_D[size]) : BOSS_D[size])
const r1 = (n: number) => Math.round(n * 1000) / 1000
const port = (name: string, spec: string, shape: 'hole' | 'boss', origin: Vec3, axis: Vec3, role?: SamplePortDef['role'], ref?: Vec3): SamplePortDef => ({
  name,
  spec,
  shape,
  origin: origin.map(r1) as Vec3,
  axis,
  ...(role && { role }),
  ...(ref && { ref }),
})

/** 公牙（沿 -Z，根部在原點）＋中間的通氣孔 */
function stem(size: ThreadSize, std: ThreadStd | undefined): Shape3D {
  const L = STEM_L[size]
  return cyl(bossD(size, std), L, [0, 0, -L])
}

/** 快插口：從 from 沿 dir 伸出一段本體，末端是插管孔與釋放套筒 */
function socketArm(shape: Shape3D, from: Vec3, dir: Vec3, len: number, tube: number) {
  const bodyD = Math.max(tube + 6, 10)
  const depth = Math.max(10, 2.2 * tube)
  const end = at(from, dir, len)
  let s = shape.fuse(cyl(bodyD, len, from, dir))
  s = drill(s, tube, depth, end, dir)
  // 插管孔底到中心的通氣孔
  s = s.cut(cyl(Math.max(2, tube * 0.5), Math.max(0.4, len - depth + 0.3), from, dir))
  const sleeve = cyl(bodyD + 1, 3, end, dir).cut(cyl(tube + 2, 3.4, at(end, dir, -0.2), dir))
  return { shape: s, sleeve, end }
}

// ---------------------------------------------------------------- 各種零件

export function buildGeneric(spec: GenericSpec): BuiltPart {
  switch (spec.kind) {
    case 'fitting':
      return fitting(spec)
    case 'silencer': {
      const af = HEX_AF[spec.thread]
      const hexH = Math.max(4, af * 0.35)
      const bodyD = Math.max(af, bossD(spec.thread, spec.std) + 4)
      const bodyH = 2.5 * bossD(spec.thread, spec.std)
      const metal = stem(spec.thread, spec.std).fuse(hexZ(af, hexH, 0))
      const body = cyl(bodyD, bodyH, [0, 0, hexH]).fuse(cyl(bodyD - 2, 2, [0, 0, hexH + bodyH]))
      return {
        shapes: [
          { shape: metal, name: 'BODY', color: METAL },
          { shape: body, name: 'SILENCER', color: BRONZE },
        ],
        ports: [port('1', threadSpecText(spec.thread, 'male', spec.std), 'boss', [0, 0, 0], [0, 0, -1])],
      }
    }
    case 'plug': {
      const af = HEX_AF[spec.thread]
      const shape = stem(spec.thread, spec.std).fuse(hexZ(af, af * 0.5, 0))
      return { shapes: [{ shape, name: 'PLUG', color: BRASS }], ports: [port('1', threadSpecText(spec.thread, 'male', spec.std), 'boss', [0, 0, 0], [0, 0, -1])] }
    }
    case 'bushing': {
      const af = Math.max(HEX_AF[spec.thread], HOLE_D[spec.inner] + 6)
      const hexH = Math.max(af * 0.45, HOLE_DEPTH[spec.inner] + 2)
      let shape = stem(spec.thread, spec.std).fuse(hexZ(af, hexH, 0))
      shape = drill(shape, HOLE_D[spec.inner], HOLE_DEPTH[spec.inner], [0, 0, hexH], [0, 0, 1])
      const pd = Math.min(bossD(spec.thread, spec.std) * 0.5, HOLE_D[spec.inner] - 2)
      shape = shape.cut(cyl(pd, STEM_L[spec.thread] + hexH - HOLE_DEPTH[spec.inner] + 0.4, [0, 0, -STEM_L[spec.thread] - 0.2]))
      return {
        shapes: [{ shape, name: 'BUSHING', color: BRASS }],
        ports: [
          port('1', threadSpecText(spec.thread, 'male', spec.std), 'boss', [0, 0, 0], [0, 0, -1]),
          port('2', threadSpecText(spec.inner, 'female', spec.std), 'hole', [0, 0, hexH], [0, 0, 1]),
        ],
      }
    }
    case 'speedController': {
      // L 型速度控制接頭（例如亞德客 JSC）：下面外牙、側面快插、上面調整鈕
      const af = HEX_AF[spec.thread]
      const hexH = Math.max(4, af * 0.45)
      const bodyD = Math.max(spec.tube + 6, af * 0.85)
      const bodyH = bodyD * 1.4
      const armZ = hexH + bodyH * 0.42
      let shape = stem(spec.thread, spec.std).fuse(hexZ(af, hexH, 0)).fuse(cyl(bodyD, bodyH, [0, 0, hexH]))
      const ports: SamplePortDef[] = [port('1', threadSpecText(spec.thread, 'male', spec.std), 'boss', [0, 0, 0], [0, 0, -1])]
      const a = socketArm(shape, [0, 0, armZ], [1, 0, 0], bodyD / 2 + Math.max(10, 2.3 * spec.tube), spec.tube)
      shape = a.shape.cut(cyl(Math.min(bossD(spec.thread, spec.std) * 0.45, spec.tube - 1.5), STEM_L[spec.thread] + armZ + 0.2, [0, 0, -STEM_L[spec.thread] - 0.2]))
      ports.push(port('2', `Ø${spec.tube} 快插`, 'hole', a.end, [1, 0, 0]))
      const top = hexH + bodyH
      const knob = hexZ(bodyD * 0.62, 3, top).fuse(drawPolysides(bodyD * 0.3, 12).sketchOnPlane('XY', top + 3).extrude(6) as Shape3D)
      return {
        shapes: [
          { shape, name: 'BODY', color: METAL },
          { shape: a.sleeve, name: 'RELEASE-SLEEVE', color: BLUE },
          { shape: knob, name: 'KNOB', color: DARK },
        ],
        ports,
      }
    }
    case 'valve':
      return valve(spec)
    case 'manifold':
      return manifold(spec)
    case 'cylinder':
      return cylinder(spec)
    case 'frl':
      return frl(spec)
    case 'gauge': {
      const af = spec.thread === 'M5' || spec.thread === 'M6' ? 8 : 12 + (spec.thread === '1/8' ? 0 : 2)
      const dial = spec.thread === '1/8' || spec.thread.startsWith('M') ? 40 : 50
      const metal = stem(spec.thread, spec.std).fuse(hexZ(af, 6, 0)).fuse(cyl(6, 4, [0, 0, 6]))
      const zc = 10 + dial / 2
      const face = cyl(dial, 22, [0, 11, zc], [0, -1, 0])
      return {
        shapes: [
          { shape: metal, name: 'STEM', color: BRASS },
          { shape: face, name: 'DIAL', color: DARK },
        ],
        ports: [port('1', threadSpecText(spec.thread, 'male', spec.std), 'boss', [0, 0, 0], [0, 0, -1])],
      }
    }
  }
}

function fitting(spec: Extract<GenericSpec, { kind: 'fitting' }>): BuiltPart {
  const tube = spec.tube
  const bodyD = Math.max(tube + 6, 10)
  const ports: SamplePortDef[] = []
  const sleeves: Shape3D[] = []
  const socketName = () => String(ports.length + 1)
  const arm = (shape: Shape3D, from: Vec3, dir: Vec3, len: number) => {
    const a = socketArm(shape, from, dir, len, tube)
    sleeves.push(a.sleeve)
    ports.push(port(socketName(), `Ø${tube} 快插`, 'hole', a.end, dir))
    return a.shape
  }
  let shape: Shape3D
  if (spec.thread) {
    const size = spec.thread
    const af = HEX_AF[size]
    const hexH = Math.max(5, af * 0.5)
    ports.push(port('1', threadSpecText(size, 'male', spec.std), 'boss', [0, 0, 0], [0, 0, -1]))
    shape = stem(size, spec.std).fuse(hexZ(af, hexH, 0))
    const pd = Math.min(bossD(size, spec.std) * 0.5, tube - 1.5)
    if (spec.form === 'straight') {
      const len = Math.max(14, 2.2 * tube + 4)
      shape = arm(shape, [0, 0, hexH], [0, 0, 1], len)
      shape = shape.cut(cyl(pd, STEM_L[size] + hexH + 0.4, [0, 0, -STEM_L[size] - 0.2]))
    } else {
      const s = Math.max(bodyD, af * 0.9) + 2
      shape = shape.fuse(box([-s / 2, -s / 2, hexH], [s / 2, s / 2, hexH + s]))
      const c: Vec3 = [0, 0, hexH + s / 2]
      const len = s / 2 + Math.max(10, 2.3 * tube)
      shape = arm(shape, c, [1, 0, 0], len)
      if (spec.form === 'tee') shape = arm(shape, c, [-1, 0, 0], len)
      shape = shape.cut(cyl(pd, STEM_L[size] + hexH + s / 2 + 0.2, [0, 0, -STEM_L[size] - 0.2]))
    }
  } else {
    const len = 3 + Math.max(10, 2.3 * tube)
    if (spec.form === 'straight') {
      shape = cyl(bodyD + 2, 6, [0, 0, -3])
      shape = arm(shape, [0, 0, 0], [0, 0, 1], len)
      shape = arm(shape, [0, 0, 0], [0, 0, -1], len)
    } else {
      const s = bodyD + 2
      shape = box([-s / 2, -s / 2, -s / 2], [s / 2, s / 2, s / 2])
      const l = s / 2 + Math.max(10, 2.3 * tube)
      shape = arm(shape, [0, 0, 0], [1, 0, 0], l)
      shape = arm(shape, [0, 0, 0], spec.form === 'tee' ? [-1, 0, 0] : [0, 0, 1], l)
      if (spec.form === 'tee') shape = arm(shape, [0, 0, 0], [0, 0, 1], l)
    }
  }
  return {
    shapes: [{ shape, name: 'BODY', color: METAL }, ...sleeves.map((s, i) => ({ shape: s, name: `RELEASE-SLEEVE-${i + 1}`, color: BLUE }))],
    ports,
  }
}

/**
 * 電磁閥（仿亞德客 4V／3V）：A、B 在上面；P、EA、EB（3 口閥為 P、R）在底面；線圈在 +X 端（雙電控兩端）。
 * 底面同時是裝集裝座的安裝面：裝上時底面的埠由集裝座供氣、排氣（sealedBy）。
 */
function valve(spec: Extract<GenericSpec, { kind: 'valve' }>): BuiltPart {
  const series = valveSeries(spec.thread, spec.series)
  const { L, W, H } = VALVE_BODY[series]
  const main = spec.thread
  const ex = spec.exhaust ?? spec.thread
  let body = box([-L / 2, -W / 2, 0], [L / 2, W / 2, H])
  const ports: SamplePortDef[] = []
  const thread = (size: ThreadSize) => threadSpecText(size, 'female', spec.std)
  const top = (name: string, x: number, size: ThreadSize) => {
    body = drill(body, HOLE_D[size], HOLE_DEPTH[size], [x, 0, H], [0, 0, 1])
    ports.push(port(name, thread(size), 'hole', [x, 0, H], [0, 0, 1]))
  }
  const bottom = (name: string, x: number, size: ThreadSize) => {
    body = drill(body, HOLE_D[size], HOLE_DEPTH[size], [x, 0, 0], [0, 0, -1])
    ports.push({ ...port(name, thread(size), 'hole', [x, 0, 0], [0, 0, -1]), sealedBy: '安裝面' })
  }
  if (spec.fn === '32NC') {
    top('A', 0, main)
    bottom('P', -0.13 * L, main)
    bottom('R', 0.13 * L, ex)
  } else {
    top('A', -0.13 * L, main)
    top('B', 0.13 * L, main)
    bottom('EA', -0.26 * L, ex)
    bottom('P', 0, main)
    bottom('EB', 0.26 * L, ex)
  }
  // 固定螺絲孔（裝集裝座用，貫穿）
  for (const x of [-(L / 2 - 0.08 * L), L / 2 - 0.08 * L]) body = body.cut(cyl(3.4, H + 0.4, [x, 0, -0.2]))
  ports.push(port('安裝面', `安裝面：${seriesInterfaceKey(series)}`, 'hole', [0, -mountOffset(series), 0], [0, 0, -1], 'plug', [1, 0, 0]))

  const shapes: BuiltPart['shapes'] = [{ shape: body, name: 'BODY', color: METAL }]
  const coilL = 0.55 * L
  const coil = (sign: 1 | -1, name: string) => {
    const x0 = sign > 0 ? L / 2 : -L / 2 - coilL
    shapes.push({ shape: box([x0, -W / 2 + 0.3, 0.1 * H], [x0 + coilL, W / 2 - 0.3, 1.12 * H]), name, color: DARK })
    // 接線盒（DIN 插頭）
    const cx = x0 + coilL / 2
    shapes.push({ shape: box([cx - 0.3 * W, -0.3 * W, 1.12 * H], [cx + 0.3 * W, 0.3 * W, 1.12 * H + 0.35 * H]), name: `${name}-CONNECTOR`, color: '#4b5563' })
  }
  if (spec.fn === '52Pilot') {
    for (const sign of [1, -1] as const) shapes.push({ shape: cyl(0.45 * H, 6, [(sign * L) / 2, 0, H / 2], [sign, 0, 0]), name: sign > 0 ? 'PILOT-14' : 'PILOT-12', color: DARK })
  } else {
    coil(1, 'SOLENOID')
    if (spec.fn === '52Single' || spec.fn === '32NC') shapes.push({ shape: cyl(0.25 * W, 2, [-L / 2, 0, H * 0.55], [-1, 0, 0]), name: 'MANUAL', color: '#f59e0b' })
    else coil(-1, 'SOLENOID-2')
  }
  return { shapes, ports }
}

/**
 * 集裝座（仿亞德客 100M～400M）：上面一排站位（閥橫跨在上面），內部有供氣與兩條排氣通道，
 * P、EA、EB 從端面接出；A、B 在閥上，集裝座的兩側沒有出氣口。
 */
function manifold(spec: Extract<GenericSpec, { kind: 'manifold' }>): BuiltPart {
  const series = spec.series ?? seriesOf(spec.thread)
  const { L, W } = VALVE_BODY[series]
  const size = MANIFOLD_PORT[series]
  const pitch = W + 2
  const H = Math.max(22, 2.2 * HOLE_D[size])
  const margin = HOLE_DEPTH[size] + 5
  const length = margin + spec.stations * pitch + 6
  const yEx = 0.26 * L
  const lastX = margin + (spec.stations - 0.5) * pitch
  let base = box([0, -L / 2, 0], [length, L / 2, H])
  const ports: SamplePortDef[] = []
  const thread = threadSpecText(size, 'female', spec.std)
  // 端面的 P、EA、EB，接到內部的通道
  for (const [name, y] of [
    ['EA', -yEx],
    ['P', 0],
    ['EB', yEx],
  ] as const) {
    base = drill(base, HOLE_D[size], HOLE_DEPTH[size], [0, y, H / 2], [-1, 0, 0])
    base = base.cut(cyl(HOLE_D[size] * 0.7, lastX + 2, [0.5, y, H / 2], [1, 0, 0]))
    ports.push(port(name, thread, 'hole', [0, y, H / 2], [-1, 0, 0]))
  }
  const key = `安裝面：${seriesInterfaceKey(series)}`
  const slot = { w: Math.min(HOLE_D[size] * 0.6, pitch * 0.4), l: Math.min(HOLE_D[size] * 0.9, 0.2 * L) }
  for (let i = 0; i < spec.stations; i++) {
    const x = margin + pitch / 2 + i * pitch
    // 每一站：通往三條通道的長孔開口（實物多為長圓孔）、兩個固定閥的螺絲孔
    for (const y of [-yEx, 0, yEx]) base = base.cut(box([x - slot.w / 2, y - slot.l / 2, H / 2], [x + slot.w / 2, y + slot.l / 2, H + 0.2]))
    for (const y of [-(L / 2 - 0.08 * L), L / 2 - 0.08 * L]) base = drill(base, 3.3, 8, [x, y, H], [0, 0, 1])
    ports.push(port(`站${i + 1}`, key, 'hole', [x + mountOffset(series), 0, H], [0, 0, 1], 'socket', [0, 1, 0]))
  }
  return { shapes: [{ shape: base, name: 'MANIFOLD', color: '#9aa5b1' }], ports }
}

function cylinder(spec: Extract<GenericSpec, { kind: 'cylinder' }>): BuiltPart {
  const size = cylinderPortSize(spec.bore)
  const s = Math.max(22, spec.bore + 12)
  const Lb = spec.stroke + 25 + spec.bore * 0.9
  const rod = defaultRodDiameter(spec.bore)
  let body = box([0, -s / 2, -s / 2], [Lb, s / 2, s / 2]).fuse(cyl(rod + 4, 3, [Lb, 0, 0], [1, 0, 0]))
  const ports: SamplePortDef[] = []
  const xA = HOLE_D[size] / 2 + 5
  const holes: [string, number][] = spec.single ? [['A', xA]] : [['A', xA], ['B', Lb - xA]]
  for (const [name, x] of holes) {
    body = drill(body, HOLE_D[size], HOLE_DEPTH[size], [x, 0, s / 2], [0, 0, 1])
    ports.push(port(name, threadSpecText(size, 'female', spec.std), 'hole', [x, 0, s / 2], [0, 0, 1]))
  }
  const rodLen = Math.max(20, rod * 3)
  const rodShape = cyl(rod, rodLen, [Lb + 3, 0, 0], [1, 0, 0]).fuse(cyl(rod * 0.8, rod, [Lb + 3 + rodLen, 0, 0], [1, 0, 0]))
  return {
    shapes: [
      { shape: body, name: 'BODY', color: METAL },
      { shape: rodShape, name: 'ROD', color: '#e5e7eb' },
    ],
    ports,
  }
}

function frl(spec: Extract<GenericSpec, { kind: 'frl' }>): BuiltPart {
  const size = spec.thread
  const s = FRL_SIZE[size]
  const gaugeSize: ThreadSize = size === 'M5' || size === 'M6' ? 'M5' : '1/8'
  const units = spec.unit === 'combo' ? (['filterRegulator', 'lubricator'] as const) : ([spec.unit] as const)
  const shapes: BuiltPart['shapes'] = []
  const ports: SamplePortDef[] = []
  let head: Shape3D | undefined
  const x0 = -(units.length * s) / 2
  units.forEach((unit, i) => {
    const cx = x0 + s / 2 + i * s
    const h = box([cx - s / 2, -s / 2, 0], [cx + s / 2, s / 2, s])
    head = head ? head.fuse(h) : h
    if (unit !== 'regulator') shapes.push({ shape: cyl(0.75 * s, 1.4 * s, [cx, 0, -1.4 * s]), name: `BOWL-${i + 1}`, color: BOWL })
    if (unit === 'regulator' || unit === 'filterRegulator') {
      shapes.push({ shape: cyl(0.8 * s, 0.8 * s, [cx, 0, s]).fuse(cyl(0.45 * s, 0.35 * s, [cx, 0, 1.8 * s])), name: `BONNET-${i + 1}`, color: DARK })
      head = drill(head, HOLE_D[gaugeSize], HOLE_DEPTH[gaugeSize] + 1, [cx, -s / 2, s / 2], [0, -1, 0])
      ports.push(port('壓力錶', threadSpecText(gaugeSize, 'female', spec.std), 'hole', [cx, -s / 2, s / 2], [0, -1, 0]))
    }
  })
  const left: Vec3 = [x0, 0, s / 2]
  const right: Vec3 = [-x0, 0, s / 2]
  head = drill(head!, HOLE_D[size], HOLE_DEPTH[size] + 1, left, [-1, 0, 0])
  head = drill(head, HOLE_D[size], HOLE_DEPTH[size] + 1, right, [1, 0, 0])
  ports.unshift(
    port('IN', threadSpecText(size, 'female', spec.std), 'hole', left, [-1, 0, 0]),
    port('OUT', threadSpecText(size, 'female', spec.std), 'hole', right, [1, 0, 0]),
  )
  return { shapes: [{ shape: head, name: 'HEAD', color: METAL }, ...shapes], ports }
}
