/**
 * 產生範例零件的 STEP 檔與 manifest.json（public/samples/）。
 *
 * 零件形狀為簡化的示意模型，但埠的尺寸貼近實物（例如 Rc1/8 孔 Ø8.6、R1/8 凸柱 Ø9.73），
 * 埠的位置與方向由同一組參數算出，因此 manifest 裡預先定義的埠一定與模型吻合。
 *
 * 用法：node scripts/make-sample-parts.mjs [--only=新零件.step]
 * （需要 devDependencies 中的 replicad 與 replicad-opencascadejs）
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'public', 'samples')
const require = createRequire(import.meta.url)
const ocWasm = require.resolve('replicad-opencascadejs/wasm')
const ocFactory = require('replicad-opencascadejs')
const oc = await (ocFactory.default ?? ocFactory)({ locateFile: () => ocWasm })
const { setOC, makeBox, makeCylinder, drawPolysides, exportSTEP } = await import('replicad')
setOC(oc)

// ---------- 小工具 ----------
const box = (x0, y0, z0, x1, y1, z1) => makeBox([x0, y0, z0], [x1, y1, z1])
const cyl = (d, h, base, dir = [0, 0, 1]) => makeCylinder(d / 2, h, base, dir)
/** 六角柱：對邊 af，從 z0 往上 h */
const hex = (af, h, z0) => drawPolysides(af / Math.sqrt(3), 6).sketchOnPlane('XY', z0).extrude(h)
/** 在 mouth 處沿 -axis 方向鑽深 depth 的孔（稍微超出表面，確保布林運算乾淨） */
const drill = (shape, d, depth, mouth, axis) => {
  const eps = 0.2
  const base = mouth.map((m, i) => m + axis[i] * eps)
  const dir = axis.map((a) => -a)
  return shape.cut(cyl(d, depth + eps, base, dir))
}

const METAL = '#b9c1c9'
const DARK = '#2f3a45'
const BRASS = '#c9b27c'
const BLUE = '#2563eb'

const HOLE = { rc18: 8.6, rc14: 11.4, m5: 4.2 }
const BOSS = { r18: 9.73, r14: 13.16, npt18: 10.29, m5: 5 }

const parts = []
function part(file, meta, shapes, ports) {
  const blob = exportSTEP(shapes.map(([shape, name, color]) => ({ shape, name, color })))
  const r3 = (v) => v.map((n) => Math.round(n * 1000) / 1000)
  const rounded = ports.map((p) => ({ ...p, origin: r3(p.origin), axis: r3(p.axis), ...(p.ref && { ref: r3(p.ref) }) }))
  parts.push({ file, blob, meta: { file, ...meta, ports: rounded } })
}

// ---------- 1. 5/2 電磁閥（仿亞德客 4V110-06：A／B 在上面，P／EA／EB 在底面） ----------
// 尺寸、埠與安裝面和通用零件的 100 系列相同（src/catalog/generic/buildGeneric.ts 的 valve()、manifold()），
// 所以範例閥與通用閥都能裝在範例或通用的 100 系列集裝座上
const V100 = { L: 50, W: 18, H: 26 }
const MOUNT_100 = '安裝面：100 系列閥座'
/** 安裝面原點偏離 P 口（閥的 -Y 側）；集裝座的站位用同樣的偏移 */
const MOUNT_OFFSET_100 = V100.W / 2 - 3
{
  const { L, W, H } = V100
  let body = box(-L / 2, -W / 2, 0, L / 2, W / 2, H)
  const ports = []
  for (const [name, x] of [['A', -0.13 * L], ['B', 0.13 * L]]) {
    body = drill(body, HOLE.rc18, 9, [x, 0, H], [0, 0, 1])
    ports.push({ name, spec: 'Rc1/8', shape: 'hole', origin: [x, 0, H], axis: [0, 0, 1] })
  }
  // 底面的 P 與排氣口：閥裝在集裝座上時由安裝面封住（由集裝座供氣、排氣）；單獨使用時直接接接頭、消音器
  for (const [name, x] of [['EA', -0.26 * L], ['P', 0], ['EB', 0.26 * L]]) {
    body = drill(body, HOLE.rc18, 9, [x, 0, 0], [0, 0, -1])
    ports.push({ name, spec: 'Rc1/8', shape: 'hole', origin: [x, 0, 0], axis: [0, 0, -1], sealedBy: '安裝面' })
  }
  for (const x of [-(L / 2 - 0.08 * L), L / 2 - 0.08 * L]) body = body.cut(cyl(3.4, H + 0.4, [x, 0, -0.2]))
  ports.push({ name: '安裝面', spec: MOUNT_100, role: 'plug', shape: 'hole', origin: [0, -MOUNT_OFFSET_100, 0], axis: [0, 0, -1], ref: [1, 0, 0] })
  // 線圈（+X 端）與接線盒、手動按鈕（-X 端）
  const coilL = 0.55 * L
  const cx = L / 2 + coilL / 2
  const solenoid = box(L / 2, -W / 2 + 0.3, 0.1 * H, L / 2 + coilL, W / 2 - 0.3, 1.12 * H)
  const connector = box(cx - 0.3 * W, -0.3 * W, 1.12 * H, cx + 0.3 * W, 0.3 * W, 1.47 * H)
  const manual = cyl(0.25 * W, 2, [-L / 2, 0, 0.55 * H], [-1, 0, 0])
  part(
    'DEMO-VALVE-52-01.step',
    { modelCode: 'DEMO-VALVE-52-01', name: '範例 5/2 單電控電磁閥 Rc1/8（A／B 在上、P／排氣在底面）', category: 'valve', pneumatic: { type: 'valve52Single' } },
    [
      [body, 'BODY', METAL],
      [solenoid, 'SOLENOID', DARK],
      [connector, 'SOLENOID-CONNECTOR', '#4b5563'],
      [manual, 'MANUAL', '#f59e0b'],
    ],
    ports,
  )
}

// ---------- 2～4. 直通快插接頭、NPT 接頭、消音器 ----------
function straightFitting(bossD, bossLen, hexAf, hexH, bodyD, socketD) {
  const bodyTop = hexH + 18
  let shape = cyl(bossD, bossLen, [0, 0, -bossLen]).fuse(hex(hexAf, hexH, 0)).fuse(cyl(bodyD, 18, [0, 0, hexH]))
  shape = drill(shape, socketD, 14, [0, 0, bodyTop], [0, 0, 1])
  shape = shape.cut(cyl(4, bossLen + bodyTop - 14 + 0.4, [0, 0, -bossLen - 0.2]))
  const sleeve = cyl(bodyD + 1, 3, [0, 0, bodyTop]).cut(cyl(socketD + 2, 3.4, [0, 0, bodyTop - 0.2]))
  return { shape, sleeve, top: bodyTop + 3 }
}
{
  const f = straightFitting(BOSS.r18, 7, 14, 7, 12, 6)
  part(
    'DEMO-FITTING-R18-D6.step',
    { modelCode: 'DEMO-FITTING-R18-D6', name: '範例直通快插接頭 R1/8 × Ø6', category: 'fitting', pneumatic: { type: 'fitting' } },
    [
      [f.shape, 'BODY', METAL],
      [f.sleeve, 'RELEASE-SLEEVE', BLUE],
    ],
    [
      { name: '1', spec: 'R1/8', shape: 'boss', origin: [0, 0, 0], axis: [0, 0, -1] },
      { name: '2', spec: 'Ø6 快插', shape: 'hole', origin: [0, 0, f.top - 3], axis: [0, 0, 1] },
    ],
  )
}
{
  // Ø4：接速度控制閥（M5 × Ø4）用
  const f = straightFitting(BOSS.r18, 7, 14, 7, 10, 4)
  part(
    'DEMO-FITTING-R18-D4.step',
    { modelCode: 'DEMO-FITTING-R18-D4', name: '範例直通快插接頭 R1/8 × Ø4', category: 'fitting', pneumatic: { type: 'fitting' } },
    [
      [f.shape, 'BODY', METAL],
      [f.sleeve, 'RELEASE-SLEEVE', BLUE],
    ],
    [
      { name: '1', spec: 'R1/8', shape: 'boss', origin: [0, 0, 0], axis: [0, 0, -1] },
      { name: '2', spec: 'Ø4 快插', shape: 'hole', origin: [0, 0, f.top - 3], axis: [0, 0, 1] },
    ],
  )
}
{
  const f = straightFitting(BOSS.npt18, 7, 14, 7, 12, 6)
  part(
    'DEMO-FITTING-NPT18-D6.step',
    { modelCode: 'DEMO-FITTING-NPT18-D6', name: '範例快插接頭 NPT1/8 × Ø6', category: 'fitting', pneumatic: { type: 'fitting' } },
    [
      [f.shape, 'BODY', BRASS],
      [f.sleeve, 'RELEASE-SLEEVE', BLUE],
    ],
    [
      { name: '1', spec: 'NPT1/8 公', shape: 'boss', origin: [0, 0, 0], axis: [0, 0, -1] },
      { name: '2', spec: 'Ø6 快插', shape: 'hole', origin: [0, 0, f.top - 3], axis: [0, 0, 1] },
    ],
  )
}
{
  const shape = cyl(BOSS.r18, 7, [0, 0, -7]).fuse(hex(14, 5, 0)).fuse(cyl(14, 25, [0, 0, 5]))
  part(
    'DEMO-SILENCER-R18.step',
    { modelCode: 'DEMO-SILENCER-R18', name: '範例消音器 R1/8', category: 'silencer', pneumatic: { type: 'silencer', ports: { E: '1' } } },
    [[shape, 'SILENCER', '#8a939c']],
    [{ name: '1', spec: 'R1/8', shape: 'boss', origin: [0, 0, 0], axis: [0, 0, -1] }],
  )
}

// ---------- 5. 氣缸 Ø16 × 50（M5） ----------
{
  let body = box(0, -12, -12, 90, 12, 12).fuse(cyl(10, 3, [90, 0, 0], [1, 0, 0]))
  const ports = []
  for (const [name, x] of [['A', 8], ['B', 82]]) {
    body = drill(body, HOLE.m5, 6, [x, 0, 12], [0, 0, 1])
    ports.push({ name, spec: 'M5', shape: 'hole', origin: [x, 0, 12], axis: [0, 0, 1] })
  }
  const rod = cyl(6, 25, [93, 0, 0], [1, 0, 0]).fuse(cyl(5, 8, [118, 0, 0], [1, 0, 0]))
  part(
    'DEMO-CYL-16-50.step',
    { modelCode: 'DEMO-CYL-16-50', name: '範例氣缸 Ø16 × 50（M5）', category: 'cylinder', pneumatic: { type: 'cylinderDouble', params: { bore: 16, stroke: 50 } } },
    [
      [body, 'BODY', METAL],
      [rod, 'ROD', '#e5e7eb'],
    ],
    ports,
  )
}

// ---------- 6. 速度控制閥 M5 × Ø4 ----------
{
  let shape = cyl(BOSS.m5, 4, [0, 0, -4]).fuse(hex(8, 4, 0)).fuse(cyl(10, 14, [0, 0, 4]))
  shape = drill(shape, 4, 10, [0, 0, 18], [0, 0, 1])
  shape = shape.cut(cyl(2, 12.4, [0, 0, -4.2]))
  const knob = cyl(6, 5, [0, 5, 12], [0, 1, 0])
  part(
    'DEMO-SC-M5-D4.step',
    { modelCode: 'DEMO-SC-M5-D4', name: '範例速度控制閥 M5 × Ø4', category: 'speedController', pneumatic: { type: 'flowControl', ports: { 2: '1', 1: '2' } } },
    [
      [shape, 'BODY', METAL],
      [knob, 'KNOB', DARK],
    ],
    [
      { name: '1', spec: 'M5', shape: 'boss', origin: [0, 0, 0], axis: [0, 0, -1] },
      { name: '2', spec: 'Ø4 快插', shape: 'hole', origin: [0, 0, 18], axis: [0, 0, 1] },
    ],
  )
}

// ---------- 7. 轉接頭 R1/4 × Rc1/8 ----------
{
  let shape = cyl(BOSS.r14, 9, [0, 0, -9]).fuse(hex(17, 8, 0))
  shape = drill(shape, HOLE.rc18, 9, [0, 0, 8], [0, 0, 1])
  shape = shape.cut(cyl(6, 8.4, [0, 0, -9.2]))
  part(
    'DEMO-BUSH-R14-RC18.step',
    { modelCode: 'DEMO-BUSH-R14-RC18', name: '範例轉接頭 R1/4 × Rc1/8', category: 'fitting', pneumatic: { type: 'fitting' } },
    [[shape, 'BUSHING', BRASS]],
    [
      { name: '1', spec: 'R1/4', shape: 'boss', origin: [0, 0, 0], axis: [0, 0, -1] },
      { name: '2', spec: 'Rc1/8', shape: 'hole', origin: [0, 0, 8], axis: [0, 0, 1] },
    ],
  )
}

// ---------- 8. 集裝座 4 站（仿亞德客 100M-4F：P／EA／EB 在端面，閥橫跨在上面，A／B 在閥上） ----------
{
  const { L, W } = V100
  const pitch = W + 2
  const H = 22
  const margin = 14
  const length = margin + 4 * pitch + 6
  const yEx = 0.26 * L
  const lastX = margin + 3.5 * pitch
  let base = box(0, -L / 2, 0, length, L / 2, H)
  const ports = []
  // 端面的 P、EA、EB，接到內部的供氣與排氣通道
  for (const [name, y] of [['EA', -yEx], ['P', 0], ['EB', yEx]]) {
    base = drill(base, HOLE.rc18, 9, [0, y, H / 2], [-1, 0, 0])
    base = base.cut(cyl(HOLE.rc18 * 0.7, lastX + 2, [0.5, y, H / 2], [1, 0, 0]))
    ports.push({ name, spec: 'Rc1/8', shape: 'hole', origin: [0, y, H / 2], axis: [-1, 0, 0] })
  }
  const slot = { w: HOLE.rc18 * 0.6, l: HOLE.rc18 * 0.9 }
  for (let i = 0; i < 4; i++) {
    const x = margin + pitch / 2 + i * pitch
    // 每一站：通往三條通道的長孔開口、兩個固定閥的螺絲孔
    for (const y of [-yEx, 0, yEx]) base = base.cut(box(x - slot.w / 2, y - slot.l / 2, H / 2, x + slot.w / 2, y + slot.l / 2, H + 0.2))
    for (const y of [-(L / 2 - 0.08 * L), L / 2 - 0.08 * L]) base = drill(base, 3.3, 8, [x, y, H], [0, 0, 1])
    ports.push({ name: `站${i + 1}`, spec: MOUNT_100, role: 'socket', shape: 'hole', origin: [x + MOUNT_OFFSET_100, 0, H], axis: [0, 0, 1], ref: [0, 1, 0] })
  }
  part(
    'DEMO-MANIFOLD-4.step',
    { modelCode: 'DEMO-MANIFOLD-4', name: '範例集裝座 4 站（100 系列，P／EA／EB Rc1/8 在端面）', category: 'manifold', pneumatic: { type: 'manifold' } },
    [[base, 'MANIFOLD', '#9aa5b1']],
    ports,
  )
}

// ---------- 9～11. 模組式三點組合（40 系列） ----------
const FRL_KEY = '安裝面：FRL-40 模組面'
function frlHead() {
  let head = box(-20, -20, 0, 20, 20, 40)
  head = drill(head, HOLE.rc14, 8, [-20, 0, 20], [-1, 0, 0])
  head = drill(head, HOLE.rc14, 8, [20, 0, 20], [1, 0, 0])
  return head
}
const frlSides = [
  { name: 'IN', spec: FRL_KEY, role: 'mutual', shape: 'hole', origin: [-20, 0, 20], axis: [-1, 0, 0] },
  { name: 'OUT', spec: FRL_KEY, role: 'mutual', shape: 'hole', origin: [20, 0, 20], axis: [1, 0, 0] },
]
{
  const bowl = cyl(30, 60, [0, 0, -60])
  part(
    'DEMO-FRL-F40.step',
    { modelCode: 'DEMO-FRL-F40', name: '範例過濾器（模組式 40）', category: 'frl', pneumatic: { type: 'filter' } },
    [
      [frlHead(), 'HEAD', METAL],
      [bowl, 'BOWL', '#94a3b8'],
    ],
    frlSides,
  )
}
{
  let head = frlHead()
  head = drill(head, HOLE.rc18, 8, [0, -20, 20], [0, -1, 0])
  const bonnet = cyl(32, 35, [0, 0, 40]).fuse(cyl(20, 15, [0, 0, 75]))
  part(
    'DEMO-FRL-R40.step',
    { modelCode: 'DEMO-FRL-R40', name: '範例調壓閥（模組式 40）', category: 'frl', pneumatic: { type: 'regulator', params: { setting: 0.5 } } },
    [
      [head, 'HEAD', METAL],
      [bonnet, 'BONNET', DARK],
    ],
    [...frlSides, { name: '壓力錶', spec: 'Rc1/8', shape: 'hole', origin: [0, -20, 20], axis: [0, -1, 0] }],
  )
}
{
  // 接管座：左側 Rc1/4 母牙（接管用），右側為模組面（與 FRL 本體對接）
  let block = box(-6, -20, 0, 6, 20, 40)
  block = block.cut(cyl(HOLE.rc14, 12.4, [-6.2, 0, 20], [1, 0, 0]))
  part(
    'DEMO-FRL-PB40.step',
    { modelCode: 'DEMO-FRL-PB40', name: '範例 FRL 接管座 Rc1/4（模組式 40）', category: 'frl', pneumatic: { type: 'fitting' } },
    [[block, 'PORT-BLOCK', METAL]],
    [
      { name: '管口', spec: 'Rc1/4', shape: 'hole', origin: [-6, 0, 20], axis: [-1, 0, 0] },
      { name: '模組面', spec: FRL_KEY, role: 'mutual', shape: 'hole', origin: [6, 0, 20], axis: [1, 0, 0] },
    ],
  )
}

// ---------- 輸出 ----------
// --only=檔名,檔名：只寫出指定的 STEP 檔（STEP 檔頭含時間，重寫會改變既有範例的 sha256）
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',')
for (const p of parts) {
  if (only && !only.includes(p.file)) continue
  writeFileSync(join(outDir, p.file), Buffer.from(await p.blob.arrayBuffer()))
}
const manifest = { version: 1, parts: parts.map((p) => p.meta) }
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`wrote ${parts.length} parts to ${outDir}`)
