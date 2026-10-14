/**
 * 通用零件的形狀（replicad）。埠的位置由同一組尺寸算出，所以定義的埠一定與模型的孔、凸柱吻合。
 * 呼叫前要先 setOC（Web Worker 或測試中載入 OpenCascade）。
 */
import { drawPolysides, makeBox, makeCylinder, type Shape3D } from 'replicad'
import { defaultRodDiameter } from '../../engine/components/cylinderDouble'
import type { Vec3 } from '../../geometry/vec3'
import type { SamplePortDef } from '../samples'
import { baseInterfaceKey, cylinderPortSize, nextSize, threadSpecText, type GenericSpec, type ThreadSize, type ThreadStd } from './genericParts'

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
/** 管接式電磁閥本體：長、寬、高 */
const VALVE_DIM: Record<ThreadSize, [number, number, number]> = {
  M5: [48, 18, 24],
  M6: [48, 18, 24],
  '1/8': [70, 22, 34],
  '1/4': [90, 28, 42],
  '3/8': [110, 34, 50],
  '1/2': [130, 40, 60],
  '3/4': [150, 48, 70],
}
/** 集裝座站距 */
const PITCH: Record<ThreadSize, number> = { M5: 16, M6: 16, '1/8': 20, '1/4': 26, '3/8': 32, '1/2': 40, '3/4': 48 }
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
const port = (name: string, spec: string, shape: 'hole' | 'boss', origin: Vec3, axis: Vec3, role?: SamplePortDef['role']): SamplePortDef => ({
  name,
  spec,
  shape,
  origin: origin.map(r1) as Vec3,
  axis,
  ...(role && { role }),
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
      const af = HEX_AF[spec.thread]
      const hexH = af * 0.5
      const bodyD = spec.tube + 6
      const bodyH = Math.max(14, 2.2 * spec.tube + 6)
      let shape = stem(spec.thread, spec.std).fuse(hexZ(af, hexH, 0)).fuse(cyl(bodyD, bodyH, [0, 0, hexH]))
      const top = hexH + bodyH
      const depth = Math.max(10, 2.2 * spec.tube)
      shape = drill(shape, spec.tube, depth, [0, 0, top], [0, 0, 1])
      shape = shape.cut(cyl(Math.min(bossD(spec.thread, spec.std) * 0.45, spec.tube - 1.5), STEM_L[spec.thread] + top - depth + 0.4, [0, 0, -STEM_L[spec.thread] - 0.2]))
      const knob = cyl(6, 6, [0, bodyD / 2 - 1, hexH + bodyH * 0.45], [0, 1, 0])
      return {
        shapes: [
          { shape, name: 'BODY', color: METAL },
          { shape: knob, name: 'KNOB', color: DARK },
        ],
        ports: [
          port('1', threadSpecText(spec.thread, 'male', spec.std), 'boss', [0, 0, 0], [0, 0, -1]),
          port('2', `Ø${spec.tube} 快插`, 'hole', [0, 0, top], [0, 0, 1]),
        ],
      }
    }
    case 'valve':
      return spec.mount === 'base' ? baseValve(spec) : bodyValve(spec)
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

function bodyValve(spec: Extract<GenericSpec, { kind: 'valve' }>): BuiltPart {
  const [L, W, H] = VALVE_DIM[spec.thread]
  const main = spec.thread
  const ex = spec.exhaust ?? spec.thread
  let body = box([-L / 2, -W / 2, 0], [L / 2, W / 2, H])
  const ports: SamplePortDef[] = []
  const top = (name: string, x: number, size: ThreadSize) => {
    body = drill(body, HOLE_D[size], HOLE_DEPTH[size] + 1, [x, 0, H], [0, 0, 1])
    ports.push(port(name, threadSpecText(size, 'female', spec.std), 'hole', [x, 0, H], [0, 0, 1]))
  }
  const front = (name: string, x: number, size: ThreadSize) => {
    body = drill(body, HOLE_D[size], HOLE_DEPTH[size] + 1, [x, -W / 2, H / 2], [0, -1, 0])
    ports.push(port(name, threadSpecText(size, 'female', spec.std), 'hole', [x, -W / 2, H / 2], [0, -1, 0]))
  }
  if (spec.fn === '32NC') {
    top('A', 0, main)
    front('P', -0.18 * L, main)
    front('R', 0.18 * L, ex)
  } else {
    top('A', -0.143 * L, main)
    top('B', 0.143 * L, main)
    front('EA', -0.257 * L, ex)
    front('P', 0, main)
    front('EB', 0.257 * L, ex)
  }
  const shapes: BuiltPart['shapes'] = [{ shape: body, name: 'BODY', color: METAL }]
  const sl = 0.38 * L
  const solenoid = (sign: 1 | -1) => {
    const x0 = sign > 0 ? L / 2 : -L / 2 - sl
    const coil = box([x0, -W / 2 + 1, 0.08 * H], [x0 + sl, W / 2 - 1, 0.92 * H]).fuse(cyl(0.18 * H, 4, [x0 + sl / 2, 0, 0.92 * H]))
    shapes.push({ shape: coil, name: sign > 0 ? 'SOLENOID' : 'SOLENOID-2', color: DARK })
  }
  if (spec.fn === '52Pilot') {
    shapes.push({ shape: cyl(0.4 * H, 4, [L / 2, 0, H / 2], [1, 0, 0]), name: 'PILOT', color: DARK })
  } else {
    solenoid(1)
    if (spec.fn !== '52Single' && spec.fn !== '32NC') solenoid(-1)
  }
  return { shapes, ports }
}

/** 集裝座的寬、高 */
const manifoldSize = (size: ThreadSize) => ({ W: Math.max(40, 4.6 * HOLE_D[size]), H: Math.max(20, 2.3 * HOLE_D[size]) })

function baseValve(spec: Extract<GenericSpec, { kind: 'valve' }>): BuiltPart {
  const pitch = PITCH[spec.thread]
  const { W } = manifoldSize(spec.thread)
  const half = pitch / 2 - 1
  const Hv = Math.round(W * 0.75)
  let body = box([-half, -(W / 2 - 1), 0], [half, W / 2 - 1, Hv])
  body = drill(body, 5, 5, [0, 0, 0], [0, 0, -1])
  body = drill(body, 3.5, 5, [0, -0.2 * W, 0], [0, 0, -1])
  body = drill(body, 3.5, 5, [0, 0.2 * W, 0], [0, 0, -1])
  const coil = box([-(half - 1), -(W / 2 - 3), Hv], [half - 1, -1, Hv + 18])
  const shapes: BuiltPart['shapes'] = [
    { shape: body, name: 'BODY', color: METAL },
    { shape: coil, name: 'SOLENOID', color: DARK },
  ]
  if (spec.fn !== '52Single' && spec.fn !== '32NC' && spec.fn !== '52Pilot') shapes.push({ shape: box([-(half - 1), 1, Hv], [half - 1, W / 2 - 3, Hv + 18]), name: 'SOLENOID-2', color: DARK })
  return { shapes, ports: [port('安裝面', `安裝面：${baseInterfaceKey(spec.thread, spec.std)}`, 'hole', [0, 0, 0], [0, 0, -1], 'plug')] }
}

function manifold(spec: Extract<GenericSpec, { kind: 'manifold' }>): BuiltPart {
  const size = spec.thread
  const supply = nextSize(size)
  const pitch = PITCH[size]
  const { W, H } = manifoldSize(size)
  const margin = HOLE_DEPTH[supply] + 3
  const length = spec.stations * pitch + 2 * margin
  let base = box([0, -W / 2, 0], [length, W / 2, H])
  const ports: SamplePortDef[] = []
  const key = `安裝面：${baseInterfaceKey(size, spec.std)}`
  for (let i = 0; i < spec.stations; i++) {
    const x = margin + pitch / 2 + i * pitch
    base = drill(base, 5, 6, [x, 0, H], [0, 0, 1])
    base = drill(base, 3.5, 5, [x, -0.2 * W, H], [0, 0, 1])
    base = drill(base, 3.5, 5, [x, 0.2 * W, H], [0, 0, 1])
    base = drill(base, HOLE_D[size], HOLE_DEPTH[size] + 1, [x, -W / 2, H / 2], [0, -1, 0])
    base = drill(base, HOLE_D[size], HOLE_DEPTH[size] + 1, [x, W / 2, H / 2], [0, 1, 0])
    ports.push(port(`站${i + 1}`, key, 'hole', [x, 0, H], [0, 0, 1], 'socket'))
    ports.push(port(`A${i + 1}`, threadSpecText(size, 'female', spec.std), 'hole', [x, -W / 2, H / 2], [0, -1, 0]))
    ports.push(port(`B${i + 1}`, threadSpecText(size, 'female', spec.std), 'hole', [x, W / 2, H / 2], [0, 1, 0]))
  }
  base = drill(base, HOLE_D[supply], HOLE_DEPTH[supply] + 1, [0, 0, H / 2], [-1, 0, 0])
  ports.push(port('P', threadSpecText(supply, 'female', spec.std), 'hole', [0, 0, H / 2], [-1, 0, 0]))
  for (const [name, y] of [
    ['EA', -0.22 * W],
    ['EB', 0.22 * W],
  ] as const) {
    base = drill(base, HOLE_D[size], HOLE_DEPTH[size] + 1, [length, y, H / 2], [1, 0, 0])
    ports.push(port(name, threadSpecText(size, 'female', spec.std), 'hole', [length, y, H / 2], [1, 0, 0]))
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
