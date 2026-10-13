import { useMemo } from 'react'
import { Box3, Matrix4, Vector3 } from 'three'
import { create } from 'zustand'
import { findAdapters, insertAdapter, type AdapterOption } from '../assembly/adapters'
import { mateStatKeys, suggestPartners, type Suggestion } from '../assembly/memory'
import { bomToCsv, buildBom } from '../assembly/bom'
import * as ops from '../assembly/moduleOps'
import { copyAttachments } from '../assembly/copyAttachments'
import { isTubeSocket } from '../assembly/tubes'
import type { DrawingInfo, IllustrationInfo, ModuleDoc, ModuleInstance, ModuleTube, PortRef } from '../assembly/types'
import { deriveModuleCircuit, type ModuleCircuit } from '../assembly/moduleCircuit'
import { ensureModuleSignals } from '../assembly/moduleSignals'
import {
  createInitialState,
  interact,
  runSequence,
  SEQUENCER_IDLE,
  SIGNAL_PARAM_NAMESPACE,
  step,
  stepSequence,
  stopSequence,
  type InteractAction,
  type ParamValue,
  type Sequence,
  type SequencerState,
  type SequencerTick,
  type SimState,
} from '../engine'
import { EMPTY_SEQUENCE, sanitizeSequence } from '../store/circuitDoc'
import { advanceRun, applySequencerTick } from '../store/sequenceRun'
import { sanitizeSizing, type SizingSettings } from '../sizing/sizing'
import { traceFromCircuit, type Trace } from '../store/trace'
import { exportLibraryArchive, exportModuleArchive, importArchive, LIBRARY_EXT, MODULE_EXT } from '../catalog/archive'
import { detectCadFormat } from '../catalog/cad'
import { parseCadInWorker } from '../catalog/cadClient'
import type { CatalogStore } from '../catalog/db'
import { analyzeFace, proposePort, type OpenTester, type PortProposal } from '../catalog/faceAnalysis'
import { attachCadFile, importCadFile } from '../catalog/importer'
import { getCatalog, useLibraryStore } from '../catalog/library'
import { createOpenTester } from '../catalog/openTester'
import { makeFrame } from '../catalog/ports'
import { installSamples, type SampleManifest } from '../catalog/samples'
import { faceOfTriangle, type Tessellation } from '../catalog/tessellation'
import { hasModel, productLabel, type Product, type ProductPort } from '../catalog/types'
import { add, scale, type Vec3 } from '../geometry/vec3'
import { checkMate, type PortSpec } from '../threads'
import { downloadFile, safeFileName } from '../utils/download'
import { renderThumbnail } from './thumbnail'

export type Mode = 'select' | 'define-port' | 'measure' | 'tube' | 'simulate'

/** 3D 模擬：由模組推出的迴路與目前的模擬狀態 */
export interface ModuleSim {
  mc: ModuleCircuit
  state: SimState
  paused: boolean
}

export interface DraftPort {
  instance: string
  productId: string
  proposal: PortProposal
}

export interface Message {
  kind: 'info' | 'error'
  text: string
}

interface ModuleSummary {
  id: string
  name: string
  customer?: string
  updatedAt: number
  parts: number
}

interface State {
  status: 'loading' | 'ready' | 'error'
  error?: string
  products: Record<string, Product>
  /** 搭配記錄：key → 次數（見 assembly/memory.ts） */
  stats: Record<string, number>
  /** 以原始檔 sha256 為 key 的網格 */
  meshes: Record<string, Tessellation>
  doc: ModuleDoc
  past: ModuleDoc[]
  future: ModuleDoc[]
  modules: ModuleSummary[]
  saved: boolean

  selected?: string
  mode: Mode
  /** 連接流程：已點選的第一個埠 */
  connectFrom?: PortRef
  /** 兩個埠都選好，等待確認 */
  pendingMate?: { parent: PortRef; child: PortRef }
  draftPort?: DraftPort
  /** 正在編輯的既有埠 */
  editingPort?: { productId: string; portId: string }
  busy?: string
  message?: Message
  /** 要求 3D 畫面縮放（數字改變時觸發）；fitTarget 有值時只對準該零件 */
  fitRequest: number
  fitTarget?: string
  /** 窄螢幕（平板直向、手機）時，側邊面板以抽屜方式開關 */
  drawer?: 'library' | 'inspector'
  /** 量測模式：已點選的點（世界座標，最多 2 個） */
  measure: Vec3[]
  /** 在 3D 畫面顯示外形尺寸線 */
  showDims: boolean
  /** 「產生圖面」對話框 */
  drawingOpen: boolean
  /** 接 PU 管：已點選的第一個快插接頭 */
  tubeFrom?: PortRef
  /** 選取的 PU 管 */
  selectedTube?: string
  /** 3D 模擬（mode = 'simulate' 時） */
  sim?: ModuleSim
  /** 程序控制的執行狀態（3D 模擬中） */
  seq: SequencerState
  /** 位移－步驟圖的記錄（3D 模擬中） */
  trace?: Trace
  /** 程序控制面板 */
  sequenceOpen: boolean

  init(): Promise<void>
  importFiles(files: readonly File[]): Promise<void>
  installSampleLibrary(): Promise<void>
  addProductToModule(productId: string): Promise<void>
  /** 替只有型號的產品附加 3D 檔，並加入目前的模組 */
  attachModel(productId: string, file: File): Promise<void>
  /** 連接流程中：加入產品並把它的某個埠接到已點選的埠（一步復原） */
  addAndConnect(productId: string, portId: string): Promise<void>
  /** 把選取零件所有空著的埠，接上以前最常搭配的零件（一步復原） */
  autoFill(instanceId: string): Promise<void>
  /** 把接在這個零件上的零件，照樣接到其他相同零件的同一個埠 */
  applyToSameParts(instanceId: string): void
  /** 更換零件的產品，盡量保留原本的鎖合 */
  replaceInstanceProduct(instanceId: string, productId: string): Promise<void>
  /** 複製選取的零件（不含鎖合） */
  duplicateSelected(): Promise<void>
  removeSelected(): void
  deleteProduct(productId: string): Promise<void>
  updateProduct(product: Product): Promise<void>
  savePort(productId: string, port: ProductPort): Promise<void>
  deletePort(productId: string, portId: string): Promise<void>
  arrayCopyPort(productId: string, portId: string, direction: Vec3, pitch: number, count: number): Promise<void>
  flipPort(productId: string, portId: string): Promise<void>
  rotatePortRef(productId: string, portId: string): Promise<void>

  select(instance?: string): void
  setMode(mode: Mode): void
  pickFace(instance: string, partIndex: number, triangle: number, clickLocal: Vec3): void
  closePortEditor(): void
  editPort(productId: string, portId: string): void
  clickPort(ref: PortRef): void
  cancelConnect(): void
  confirmMate(): void
  insertAdapterOption(option: AdapterOption): void
  rotateMate(mateId: string, delta: number): void
  disconnectMate(mateId: string): void

  undo(): void
  redo(): void
  newModule(): void
  openModule(id: string): Promise<void>
  deleteModule(id: string): Promise<void>
  renameModule(patch: { name?: string; customer?: string }): void
  exportModuleFile(): Promise<void>
  exportLibraryFile(): Promise<void>
  downloadBomCsv(): void
  requestFit(target?: string): void
  dismissMessage(): void
  toggleDrawer(drawer: 'library' | 'inspector'): void
  /** 量測：加入一個點（第三個點會開始新的量測） */
  addMeasurePoint(point: Vec3): void
  /** 量測：以埠的中心為點 */
  addMeasurePortPoint(ref: PortRef): void
  clearMeasure(): void
  toggleDims(): void
  openDrawing(open: boolean): void
  selectTube(tubeId?: string): void
  setTubeLength(tubeId: string, length: number | undefined): void
  deleteTube(tubeId: string): void
  /** 設定（或取消）模擬用的供氣口 */
  setSupply(ref: PortRef | undefined, pressure?: number): void
  startSimulation(): void
  stopSimulation(): void
  resetSimulation(): void
  toggleSimulationPause(): void
  /** 推進模擬 dt 秒（由 requestAnimationFrame 迴圈呼叫） */
  tickSimulation(dt: number): void
  /** 模擬中操作元件：點閥切換、按住按鈕閥 */
  simulationInteract(nodeId: string, action?: InteractAction): void
  /** 圖面設定（圖號、版次、選項）：記在模組裡，不列入復原歷史 */
  setDrawingInfo(patch: Partial<DrawingInfo>): void
  /** 示意圖設定（不列入復原） */
  setIllustration(patch: Partial<IllustrationInfo>): void
  /** 修改零件在模組中的參數（訊號名稱、負載…）；值為 undefined 時移除該參數 */
  setInstanceParams(instanceId: string, patch: Readonly<Record<string, ParamValue | undefined>>): void
  /** 補上缺少的訊號名稱（氣缸代號、線圈輸出），不列入復原歷史 */
  ensureSignals(): void
  /** 選型計算的設定（每分鐘循環數、計算壓力）；值為 undefined 時移除，不列入復原歷史 */
  setSizing(patch: Partial<SizingSettings>): void
  /** 程序控制：步驟（執行中不能修改；不列入復原歷史） */
  setSequence(sequence: Sequence): void
  /** 自動執行（還沒開始模擬時先開始） */
  seqAuto(): void
  /** 單步 */
  seqStep(): void
  seqStop(): void
  /** 復歸：停止程序、輸出全部 OFF、氣缸回到初始位置 */
  seqHome(): void
  setContinuous(on: boolean): void
  toggleSequencePanel(open?: boolean): void
  /** 確保目前模組所有零件的網格都已載入 */
  loadDocMeshes(): Promise<void>
}

let catalog: CatalogStore | undefined
/** init 只執行一次（React StrictMode 會呼叫兩次 effect） */
let initPromise: Promise<void> | undefined
const testers = new Map<string, OpenTester>()
const LAST_MODULE_KEY = 'pneumatic-module:last'
const HISTORY_LIMIT = 100

const summarize = (m: ModuleDoc): ModuleSummary => ({
  id: m.id,
  name: m.name,
  customer: m.customer,
  updatedAt: m.updatedAt,
  parts: m.instances.length,
})

const readFile = (file: File) => file.arrayBuffer().then((b) => new Uint8Array(b))

function remember(id: string) {
  try {
    localStorage.setItem(LAST_MODULE_KEY, id)
  } catch {
    /* 無痕模式等情況：略過 */
  }
}

/** 名稱結尾的數字加一：站1 → 站2、A1 → A2；沒有數字就補上 */
function nextName(name: string, k: number): string {
  const m = /^(.*?)(\d+)$/.exec(name)
  return m ? `${m[1]}${Number(m[2]) + k}` : `${name}${k + 1}`
}

export const useModuleStore = create<State>()((set, get) => {
  /** 修改模組（記錄復原歷史並排程自動存檔）；模擬中改了供氣壓力等設定時更新模擬 */
  const commit = (doc: ModuleDoc) => {
    const { doc: prev, past } = get()
    set({ doc, past: [...past, prev].slice(-HISTORY_LIMIT), future: [], saved: false })
    scheduleSave()
    if (get().mode === 'simulate') {
      // 模擬中加入的零件也要有訊號名稱
      const named = ensureModuleSignals(doc, get().products)
      if (named !== doc) set({ doc: named })
      updateSimulation(named)
    }
  }

  const freshSimulation = (doc: ModuleDoc): ModuleSim => {
    const mc = deriveModuleCircuit(doc, get().products)
    return { mc, state: step(mc.circuit, createInitialState(mc.circuit), 0), paused: false }
  }

  /** 位移－步驟圖的記錄：氣缸以型號說明 */
  const traceOf = (sim: ModuleSim): Trace => {
    const { doc, products } = get()
    return traceFromCircuit(sim.mc.circuit, sim.state, (id) => {
      const inst = doc.instances.find((i) => i.id === sim.mc.nodeInstance[id])
      const product = inst && products[inst.productId]
      return product ? product.modelCode || productLabel(product) : undefined
    })
  }

  /** 重新開始模擬（程序停在尚未開始、重新記錄） */
  const restartSimulation = (sim: ModuleSim) => {
    set({ sim, seq: { ...SEQUENCER_IDLE, continuous: get().seq.continuous }, trace: traceOf(sim) })
  }

  /** 元件沒有增減（例如只改了供氣壓力）時保留閥位、活塞位置與程序，否則重新開始 */
  const updateSimulation = (doc: ModuleDoc) => {
    const sim = get().sim
    const mc = deriveModuleCircuit(doc, get().products)
    const before = sim?.mc.circuit.nodes
    const same = !!before && before.length === mc.circuit.nodes.length && mc.circuit.nodes.every((n, i) => before[i].id === n.id && before[i].type === n.type)
    if (same) set({ sim: { ...sim!, mc, state: step(mc.circuit, sim!.state, 0) } })
    else restartSimulation({ mc, state: step(mc.circuit, createInitialState(mc.circuit), 0), paused: false })
  }

  /** 補上缺少的訊號名稱：不列入復原歷史，但要存檔 */
  const ensureSignals = () => {
    const { doc, products } = get()
    const named = ensureModuleSignals(doc, products)
    if (named === doc) return
    set({ doc: named, saved: false })
    scheduleSave()
  }

  /** 套用程序控制的操作結果（自動、單步） */
  const applySequencer = (r: SequencerTick) => {
    const { sim, seq, trace, doc } = get()
    if (!sim) return
    const next = applySequencerTick(sim.mc.circuit, doc.sequence ?? EMPTY_SEQUENCE, { sim: sim.state, seq, trace }, r)
    set({ sim: { ...sim, state: next.sim }, seq: next.seq, ...(next.trace && { trace: next.trace }) })
  }

  /** 程序控制要開始執行：還沒開始模擬時先開始，暫停中則繼續 */
  const ensureRunning = () => {
    const sim = get().sim
    if (!sim) get().startSimulation()
    else if (sim.paused) set({ sim: { ...sim, paused: false } })
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      const { doc } = get()
      if (!catalog) return
      await catalog.putModule(doc)
      remember(doc.id)
      set((s) => ({ saved: true, modules: upsertSummary(s.modules, doc) }))
    }, 400)
  }

  const upsertSummary = (list: ModuleSummary[], doc: ModuleDoc) =>
    [summarize(doc), ...list.filter((m) => m.id !== doc.id)].sort((a, b) => b.updatedAt - a.updatedAt)

  const info = (text: string) => set({ message: { kind: 'info', text } })
  const fail = (err: unknown) =>
    set({ busy: undefined, message: { kind: 'error', text: err instanceof Error ? err.message : String(err) } })

  /** 接 PU 管模式：點選兩個快插接頭 */
  const clickTubePort = (ref: PortRef) => {
    const { doc, products, tubeFrom } = get()
    const port = ops.getPort(doc, products, ref)
    if (!isTubeSocket(port)) {
      info('PU 管只能接在快插接頭的插管端（規格為「Ø6 快插」這類）')
      return
    }
    if (ops.usedPorts(doc).has(`${ref.instance}:${ref.port}`)) {
      info('這個快插接頭已經接了零件或管子')
      return
    }
    if (!tubeFrom || (tubeFrom.instance === ref.instance && tubeFrom.port === ref.port)) {
      set({ tubeFrom: tubeFrom ? undefined : ref })
      return
    }
    const estimate = estimateLengthBetween(tubeFrom, ref)
    const r = ops.addTube(doc, products, tubeFrom, ref, estimate)
    if ('error' in r) {
      set({ tubeFrom: undefined, message: { kind: 'error', text: ops.ADD_TUBE_ERROR_TEXT[r.error] } })
      return
    }
    commit(r.doc)
    const tube = r.doc.tubes!.find((t) => t.id === r.tubeId)!
    set({ tubeFrom: undefined, selectedTube: r.tubeId, selected: undefined })
    info(`已接上 PU 管 ${tube.label ?? ''}（建議長度 ${tube.length ?? '—'} mm，可在右側修改）`)
  }

  /** 兩個埠之間的 PU 管建議長度（依目前位置） */
  const estimateLengthBetween = (a: PortRef, b: PortRef): number | undefined => {
    const { doc, products } = get()
    const od = ops.getPort(doc, products, a)?.spec
    return od?.kind === 'tube' ? ops.estimateTubeLengthOf(doc, products, { a, b, od: od.od }) : undefined
  }

  /** 直接寫入資料庫之後（匯入檔案、安裝範例），重新讀取共用產品庫並通知其他分頁 */
  const refreshProducts = () => useLibraryStore.getState().reload(true)

  /** 確保產品的網格已載入（快取 → 資料庫 → 重新解析原始檔） */
  const ensureMesh = async (product: Product): Promise<Tessellation | undefined> => {
    const sha = product.source.sha256
    const cached = get().meshes[sha]
    if (cached || !catalog) return cached
    let mesh = (await catalog.getMesh(sha))?.tessellation
    if (!mesh) {
      const file = await catalog.getFile(sha)
      if (!file) return undefined
      set({ busy: `解析 ${product.source.fileName}…` })
      mesh = await parseCadInWorker(file.bytes, product.source.format)
      await catalog.putMesh({ sha256: sha, tessellation: mesh })
      set({ busy: undefined })
    }
    set((s) => ({ meshes: { ...s.meshes, [sha]: mesh } }))
    return mesh
  }

  const ensureDocMeshes = async (doc: ModuleDoc) => {
    const { products } = get()
    const ids = [...new Set(doc.instances.map((i) => i.productId))]
    for (const id of ids) if (products[id]) await ensureMesh(products[id])
  }

  /**
   * 為還沒有縮圖的產品產生縮圖（依序、每張之間讓出主執行緒，不影響操作）。
   * 網格直接從資料庫讀，不放進記憶體中的快取。
   */
  let thumbQueue = Promise.resolve()
  const generateThumbs = (products: readonly Product[]) => {
    thumbQueue = thumbQueue.then(async () => {
      for (const product of products) {
        const sha = product.source.sha256
        if (!hasModel(product) || useLibraryStore.getState().thumbs[sha]) continue
        try {
          const mesh = get().meshes[sha] ?? (await catalog?.getMesh(sha))?.tessellation
          if (!mesh) continue
          const png = await renderThumbnail(mesh)
          if (png) await useLibraryStore.getState().saveThumb(sha, png)
        } catch {
          /* 縮圖失敗不影響其他功能 */
        }
        await new Promise((r) => setTimeout(r, 30))
      }
    })
    return thumbQueue
  }

  /** 新零件放在目前模組的右側、底面貼齊 z = 0 */
  const placementBeside = (mesh: Tessellation): number[] => {
    const { doc, products, meshes } = get()
    const { transforms } = ops.computeTransforms(doc, products)
    const all = new Box3()
    for (const inst of doc.instances) {
      const m = meshes[products[inst.productId]?.source.sha256 ?? '']
      if (!m) continue
      const box = new Box3(new Vector3(...m.bbox.min), new Vector3(...m.bbox.max))
      all.union(box.applyMatrix4(new Matrix4().fromArray(transforms[inst.id])))
    }
    const [min, max] = [mesh.bbox.min, mesh.bbox.max]
    const x = all.isEmpty() ? -(min[0] + max[0]) / 2 : all.max.x + 30 - min[0]
    const y = -(min[1] + max[1]) / 2
    const z = -min[2]
    return new Matrix4().makeTranslation(x, y, z).toArray()
  }

  const addInstanceOf = async (product: Product, params?: ModuleInstance['params']) => {
    if (!hasModel(product)) throw new Error(`「${productLabel(product)}」還沒有 3D 檔：在產品庫點它，再選擇要附加的 STEP 檔`)
    const mesh = await ensureMesh(product)
    if (!mesh) throw new Error(`「${productLabel(product)}」缺少 3D 資料`)
    const wasEmpty = get().doc.instances.length === 0
    const added = ops.addInstance(get().doc, product.id, placementBeside(mesh))
    const { instanceId } = added
    const next = params ? { ...added.doc, instances: added.doc.instances.map((i) => (i.id === instanceId ? { ...i, params } : i)) } : added.doc
    commit(next)
    // 窄螢幕：加入零件後收起產品庫抽屜，讓使用者看到剛加入的零件
    set((s) => ({ selected: instanceId, drawer: undefined, ...(wasEmpty && { fitRequest: s.fitRequest + 1, fitTarget: undefined }) }))
  }

  const testerFor = (product: Product, mesh: Tessellation) => {
    const sha = product.source.sha256
    let tester = testers.get(sha)
    if (!tester) {
      tester = createOpenTester(mesh)
      testers.set(sha, tester)
    }
    return tester
  }

  const persistProduct = async (product: Product) => {
    await useLibraryStore.getState().saveProduct(product)
  }

  const openDoc = async (raw: ModuleDoc) => {
    // 舊版或外部匯入的程序、選型資料先整理過
    const doc: ModuleDoc = {
      ...raw,
      ...(raw.sequence && { sequence: sanitizeSequence(raw.sequence) }),
      ...(raw.sizing && { sizing: sanitizeSizing(raw.sizing) }),
    }
    set({
      doc,
      past: [],
      future: [],
      selected: undefined,
      selectedTube: undefined,
      connectFrom: undefined,
      pendingMate: undefined,
      tubeFrom: undefined,
      saved: true,
      ...(get().mode === 'simulate' || get().mode === 'tube'
        ? { mode: 'select' as const, sim: undefined, seq: { ...SEQUENCER_IDLE, continuous: get().seq.continuous }, trace: undefined }
        : {}),
    })
    remember(doc.id)
    await ensureDocMeshes(doc)
    set((s) => ({ fitRequest: s.fitRequest + 1, fitTarget: undefined }))
  }

  const specOf = (ref: PortRef): PortSpec | undefined => ops.getPort(get().doc, get().products, ref)?.spec

  /** 記下這次鎖合（「記住搭配」），之後建議零件時排在前面 */
  const recordMate = async (doc: ModuleDoc, a: PortRef, b: PortRef) => {
    const { products } = get()
    const side = (ref: PortRef) => {
      const productId = doc.instances.find((i) => i.id === ref.instance)?.productId
      const product = productId ? products[productId] : undefined
      return product && { product: product.id, port: ref.port, spec: ops.getPort(doc, products, ref)?.spec }
    }
    const sa = side(a)
    const sb = side(b)
    if (!sa || !sb || !catalog) return
    try {
      const updated = await catalog.bumpStats(mateStatKeys(sa, sb))
      set((s) => ({ stats: { ...s.stats, ...Object.fromEntries(updated.map((u) => [u.key, u.count])) } }))
    } catch {
      /* 記錄失敗不影響鎖合 */
    }
  }

  const initialize = async () => {
    try {
      catalog = await getCatalog()
      // 產品庫由兩個分頁共用：這裡的 products 是共用 store 的鏡像（同步更新）
      await useLibraryStore.getState().load()
      set({ products: useLibraryStore.getState().products })
      useLibraryStore.subscribe((lib) => {
        if (lib.products !== get().products) set({ products: lib.products })
      })
      const modules = (await catalog.listModules()).map(summarize).sort((a, b) => b.updatedAt - a.updatedAt)
      const stats = await catalog.listStats()
      set({ modules, stats: Object.fromEntries(stats.map((x) => [x.key, x.count])) })
      let lastId: string | null = null
      try {
        lastId = localStorage.getItem(LAST_MODULE_KEY)
      } catch {
        /* 略過 */
      }
      const last = lastId ? await catalog.getModule(lastId) : undefined
      if (last) await openDoc(last)
      set({ status: 'ready' })
      // 舊版建立的產品沒有縮圖：開啟後在背景補上
      setTimeout(() => void generateThumbs(Object.values(get().products)), 1500)
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }


  return {
    status: 'loading',
    products: {},
    stats: {},
    meshes: {},
    doc: ops.createModule(),
    past: [],
    future: [],
    modules: [],
    saved: true,
    mode: 'select',
    fitRequest: 0,
    measure: [],
    showDims: false,
    drawingOpen: false,
    seq: SEQUENCER_IDLE,
    sequenceOpen: false,

    init() {
      initPromise ??= initialize()
      return initPromise
    },

    async importFiles(files) {
      for (const file of files) {
        const name = file.name.toLowerCase()
        try {
          if (name.endsWith(LIBRARY_EXT) || name.endsWith(MODULE_EXT)) {
            set({ busy: `匯入 ${file.name}…` })
            const report = await importArchive(catalog!, await readFile(file))
            await refreshProducts()
            set({ modules: (await catalog!.listModules()).map(summarize).sort((a, b) => b.updatedAt - a.updatedAt) })
            if (report.moduleId) await get().openModule(report.moduleId)
            const parts = [
              `新增 ${report.productsAdded} 個產品`,
              report.productsMerged ? `合併 ${report.productsMerged} 個` : '',
              report.portsAdded ? `補上 ${report.portsAdded} 個埠` : '',
              report.specsFilled ? `補上 ${report.specsFilled} 個規格` : '',
            ].filter(Boolean)
            set({
              busy: undefined,
              message: {
                kind: report.conflicts.length ? 'error' : 'info',
                text: `已匯入：${parts.join('、')}${report.conflicts.length ? `。有 ${report.conflicts.length} 項差異保留本機設定：${report.conflicts.join('；')}` : ''}`,
              },
            })
            continue
          }
          if (!detectCadFormat(file.name)) throw new Error(`不支援的檔案：${file.name}（請使用 STEP、IGES，或 .plib／.pmod）`)
          set({ busy: `解析 ${file.name}…（第一次使用需下載 3D 解析元件）` })
          const { product, status } = await importCadFile(catalog!, file.name, await readFile(file), parseCadInWorker)
          await refreshProducts()
          await addInstanceOf(get().products[product.id])
          void generateThumbs([get().products[product.id]])
          set({ busy: undefined })
          info(
            status === 'new'
              ? `已加入新產品「${product.modelCode}」。在右側按「新增埠」，再點選零件上的孔或面來定義埠。`
              : `已認出「${productLabel(product)}」，沿用 ${product.ports.length} 個已定義的埠。`,
          )
        } catch (err) {
          fail(err)
        }
      }
    },

    async installSampleLibrary() {
      try {
        set({ busy: '安裝範例零件（第一次使用需下載 3D 解析元件）…' })
        const base = `${import.meta.env.BASE_URL}samples/`
        const manifest = (await (await fetch(`${base}manifest.json`)).json()) as SampleManifest
        const r = await installSamples(
          catalog!,
          manifest,
          async (file) => new Uint8Array(await (await fetch(base + file)).arrayBuffer()),
          parseCadInWorker,
        )
        await refreshProducts()
        set({ busy: undefined })
        info(`範例零件：新增 ${r.added} 個、已存在 ${r.existing} 個。點選左側清單即可加入模組。`)
        void generateThumbs(Object.values(get().products))
      } catch (err) {
        fail(err)
      }
    },

    async addProductToModule(productId) {
      try {
        await addInstanceOf(get().products[productId])
      } catch (err) {
        fail(err)
      }
    },

    async attachModel(productId, file) {
      try {
        const product = get().products[productId]
        set({ busy: `解析 ${file.name}…` })
        const next = await attachCadFile(catalog!, product, file.name, await readFile(file), parseCadInWorker)
        await refreshProducts()
        set({ busy: undefined })
        await addInstanceOf(get().products[next.id])
        void generateThumbs([get().products[next.id]])
        info(`已替「${productLabel(next)}」附加 3D 檔。在右側按「新增埠」定義埠。`)
      } catch (err) {
        fail(err)
      }
    },

    async addAndConnect(productId, portId) {
      const from = get().connectFrom
      const product = get().products[productId]
      if (!from || !product) return
      try {
        const mesh = await ensureMesh(product)
        if (!mesh) throw new Error(`「${productLabel(product)}」缺少 3D 資料`)
        const added = ops.addInstance(get().doc, product.id, placementBeside(mesh))
        const child = { instance: added.instanceId, port: portId }
        const r = ops.connect(added.doc, get().products, from, child)
        if ('error' in r) {
          commit(added.doc)
          set({ connectFrom: undefined, selected: added.instanceId, message: { kind: 'error', text: ops.CONNECT_ERROR_TEXT[r.error] } })
          return
        }
        commit(r.doc)
        void recordMate(r.doc, from, child)
        set({ connectFrom: undefined, selected: added.instanceId })
        const result = checkMate(specOf(from), specOf(child))
        info(result.level === 'warn' ? `已鎖合「${product.modelCode}」。注意：${result.summary}` : `已接上「${product.modelCode}」`)
      } catch (err) {
        fail(err)
      }
    },

    async autoFill(instanceId) {
      const { doc, products, stats } = get()
      const inst = doc.instances.find((i) => i.id === instanceId)
      const product = inst && products[inst.productId]
      if (!inst || !product) return
      const used = ops.usedPorts(doc)
      let next = doc
      const added: string[] = []
      let noRecord = 0
      try {
        for (const port of product.ports) {
          if (used.has(`${instanceId}:${port.id}`)) continue
          // 只用「以前接過」的搭配（分數 > 0），避免亂接
          const best = suggestPartners({ product, port }, Object.values(products), stats).find((x) => x.score > 0)
          if (!best) {
            noRecord++
            continue
          }
          const mesh = await ensureMesh(best.product)
          if (!mesh) continue
          const addedInst = ops.addInstance(next, best.product.id, placementBeside(mesh))
          const r = ops.connect(addedInst.doc, products, { instance: instanceId, port: port.id }, { instance: addedInst.instanceId, port: best.port.id })
          if ('error' in r) continue
          next = r.doc
          added.push(best.product.modelCode)
        }
        if (!added.length) {
          info(noRecord ? '這個零件空著的埠都還沒有搭配記錄：先手動接過一次，之後就能自動配上。' : '這個零件沒有空著的埠。')
          return
        }
        commit(next)
        for (const m of next.mates.filter((x) => !doc.mates.some((y) => y.id === x.id))) void recordMate(next, m.parent, m.child)
        info(`已自動配上 ${added.length} 個零件：${added.join('、')}${noRecord ? `；另有 ${noRecord} 個埠沒有搭配記錄` : ''}`)
      } catch (err) {
        fail(err)
      }
    },

    applyToSameParts(instanceId) {
      const { doc, products } = get()
      const product = products[doc.instances.find((i) => i.id === instanceId)?.productId ?? '']
      if (!product) return
      const r = copyAttachments(doc, products, instanceId)
      if (!r.added) {
        info(
          !r.branches
            ? '這個零件上還沒有接零件（接頭、消音器…）：先接好一個，再套用到其他相同零件。'
            : '其他相同零件對應的埠都已經接了零件。',
        )
        return
      }
      commit(r.doc)
      for (const m of r.doc.mates.filter((x) => !doc.mates.some((y) => y.id === x.id))) void recordMate(r.doc, m.parent, m.child)
      info(`已套用到其他 ${r.targets} 個「${product.modelCode}」：加入 ${r.added} 個零件${r.skipped ? `；${r.skipped} 個埠已經有零件，略過` : ''}`)
    },

    async replaceInstanceProduct(instanceId, productId) {
      const product = get().products[productId]
      if (!product) return
      try {
        await ensureMesh(product)
        const r = ops.replaceProduct(get().doc, get().products, instanceId, productId)
        commit(r.doc)
        set({ selected: instanceId })
        info(
          `已換成「${product.modelCode}」${r.kept ? `，保留 ${r.kept} 個鎖合` : ''}${r.dropped.length ? `；新產品沒有對應的埠而拆開：${r.dropped.join('、')}` : ''}`,
        )
      } catch (err) {
        fail(err)
      }
    },

    async duplicateSelected() {
      const { selected, doc, products } = get()
      const inst = doc.instances.find((i) => i.id === selected)
      const product = inst && products[inst.productId]
      if (!product) return
      try {
        // 負載等參數一起複製；訊號名稱不複製（避免重複），開始模擬時會自動指定
        const params = Object.fromEntries(Object.entries(inst.params ?? {}).filter(([k]) => !SIGNAL_PARAM_NAMESPACE[k] && k !== 'trigger'))
        await addInstanceOf(product, Object.keys(params).length ? params : undefined)
      } catch (err) {
        fail(err)
      }
    },

    removeSelected() {
      const { selected, selectedTube, doc, products } = get()
      if (selectedTube) {
        commit(ops.removeTube(doc, selectedTube))
        set({ selectedTube: undefined })
        return
      }
      if (!selected) return
      commit(ops.removeInstance(doc, products, selected))
      set({ selected: undefined, connectFrom: undefined })
    },

    async deleteProduct(productId) {
      if (!catalog) return
      const using = await catalog.modulesUsingProduct(productId)
      const inCurrent = get().doc.instances.some((i) => i.productId === productId)
      if (using.length || inCurrent) {
        const names = [...new Set([...using.map((m) => m.name), ...(inCurrent ? [get().doc.name] : [])])]
        set({ message: { kind: 'error', text: `無法刪除：以下模組仍在使用這個產品：${names.join('、')}` } })
        return
      }
      await useLibraryStore.getState().removeProduct(productId)
    },

    async updateProduct(product) {
      await persistProduct(product)
    },

    async savePort(productId, port) {
      const product = get().products[productId]
      const exists = product.ports.some((p) => p.id === port.id)
      const ports = exists ? product.ports.map((p) => (p.id === port.id ? port : p)) : [...product.ports, port]
      await persistProduct({ ...product, ports })
      set({ draftPort: undefined, editingPort: undefined, mode: 'select' })
    },

    async deletePort(productId, portId) {
      const product = get().products[productId]
      // 拆開目前模組中使用這個埠的鎖合
      const { doc, products } = get()
      let next = doc
      for (const m of doc.mates) {
        const uses = [m.parent, m.child].some(
          (r) => r.port === portId && doc.instances.find((i) => i.id === r.instance)?.productId === productId,
        )
        if (uses) next = ops.disconnect(next, products, m.id)
      }
      if (next !== doc) commit(next)
      await persistProduct({ ...product, ports: product.ports.filter((p) => p.id !== portId) })
      set({ editingPort: undefined })
    },

    async arrayCopyPort(productId, portId, direction, pitch, count) {
      const product = get().products[productId]
      const source = product.ports.find((p) => p.id === portId)
      if (!source || count < 2) return
      const copies: ProductPort[] = []
      for (let k = 1; k < count; k++) {
        const origin = add(source.frame.origin, scale(direction, pitch * k))
        copies.push({
          ...source,
          id: `${source.id}_${k}_${Date.now().toString(36)}`,
          name: nextName(source.name, k),
          frame: makeFrame(origin, source.frame.axis, source.frame.ref),
        })
      }
      await persistProduct({ ...product, ports: [...product.ports, ...copies] })
      info(`已複製出 ${copies.length} 個埠`)
    },

    async flipPort(productId, portId) {
      const product = get().products[productId]
      const ports = product.ports.map((p) =>
        p.id === portId ? { ...p, frame: makeFrame(p.frame.origin, scale(p.frame.axis, -1), p.frame.ref) } : p,
      )
      await persistProduct({ ...product, ports })
    },

    async rotatePortRef(productId, portId) {
      const product = get().products[productId]
      const ports = product.ports.map((p) => {
        if (p.id !== portId) return p
        const [a, r] = [p.frame.axis, p.frame.ref]
        const rotated: Vec3 = [a[1] * r[2] - a[2] * r[1], a[2] * r[0] - a[0] * r[2], a[0] * r[1] - a[1] * r[0]]
        return { ...p, frame: makeFrame(p.frame.origin, a, rotated) }
      })
      await persistProduct({ ...product, ports })
    },

    select(instance) {
      set({ selected: instance, selectedTube: undefined })
    },

    setMode(mode) {
      if (mode === 'simulate') {
        get().startSimulation()
        return
      }
      const leaving = get().mode === 'simulate'
      set({
        mode,
        connectFrom: undefined,
        draftPort: undefined,
        measure: [],
        tubeFrom: undefined,
        sim: undefined,
        ...(leaving && { seq: { ...SEQUENCER_IDLE, continuous: get().seq.continuous }, trace: undefined }),
      })
    },

    startSimulation() {
      // 程序控制需要氣缸代號與線圈輸出：缺少的先補上
      ensureSignals()
      set({
        mode: 'simulate',
        connectFrom: undefined,
        pendingMate: undefined,
        draftPort: undefined,
        measure: [],
        tubeFrom: undefined,
        selected: undefined,
        selectedTube: undefined,
      })
      restartSimulation(freshSimulation(get().doc))
    },

    stopSimulation() {
      set({ mode: 'select', sim: undefined, seq: { ...SEQUENCER_IDLE, continuous: get().seq.continuous }, trace: undefined })
    },

    resetSimulation() {
      if (get().sim) restartSimulation(freshSimulation(get().doc))
    },

    toggleSimulationPause() {
      const sim = get().sim
      if (sim) set({ sim: { ...sim, paused: !sim.paused } })
    },

    tickSimulation(dt) {
      const { sim, seq, trace, doc } = get()
      if (!sim || sim.paused) return
      const r = advanceRun(sim.mc.circuit, doc.sequence ?? EMPTY_SEQUENCE, { sim: sim.state, seq, trace }, dt)
      set({ sim: { ...sim, state: r.sim }, seq: r.seq, ...(r.trace && { trace: r.trace }) })
    },

    simulationInteract(nodeId, action = 'toggle') {
      const sim = get().sim
      if (!sim) return
      set({ sim: { ...sim, state: interact(sim.mc.circuit, sim.state, nodeId, undefined, action) } })
    },

    pickFace(instance, partIndex, triangle, clickLocal) {
      const { doc, products, meshes } = get()
      const inst = doc.instances.find((i) => i.id === instance)
      const product = inst && products[inst.productId]
      const mesh = product && meshes[product.source.sha256]
      const part = mesh?.parts[partIndex]
      if (!product || !mesh || !part) return
      const face = faceOfTriangle(part, triangle)
      if (face < 0) return
      const proposal = proposePort(analyzeFace(part, face), testerFor(product, mesh), clickLocal)
      set({ draftPort: { instance, productId: product.id, proposal }, selected: instance })
    },

    closePortEditor() {
      set({ draftPort: undefined, editingPort: undefined })
    },

    editPort(productId, portId) {
      set({ editingPort: { productId, portId }, draftPort: undefined })
    },

    clickPort(ref) {
      if (get().mode === 'tube') {
        clickTubePort(ref)
        return
      }
      const { connectFrom, doc } = get()
      if (ops.usedPorts(doc).has(`${ref.instance}:${ref.port}`)) {
        info('這個埠已經接了零件；要改接請先在「檢查」頁拆開')
        return
      }
      if (!connectFrom) {
        set({ connectFrom: ref, selected: ref.instance })
        return
      }
      if (connectFrom.instance === ref.instance && connectFrom.port === ref.port) {
        set({ connectFrom: undefined })
        return
      }
      set({ pendingMate: { parent: connectFrom, child: ref }, connectFrom: undefined })
    },

    cancelConnect() {
      set({ connectFrom: undefined, pendingMate: undefined })
    },

    confirmMate() {
      const { pendingMate, doc, products } = get()
      if (!pendingMate) return
      const r = ops.connect(doc, products, pendingMate.parent, pendingMate.child)
      if ('error' in r) {
        set({ pendingMate: undefined, message: { kind: 'error', text: ops.CONNECT_ERROR_TEXT[r.error] } })
        return
      }
      commit(r.doc)
      void recordMate(r.doc, pendingMate.parent, pendingMate.child)
      const result = checkMate(specOf(pendingMate.parent), specOf(pendingMate.child))
      set({ pendingMate: undefined, selected: pendingMate.child.instance })
      if (result.level === 'unknown') info('已鎖合。這組連接尚未檢查規格，設定兩端的埠規格後會自動檢查。')
    },

    insertAdapterOption(option) {
      const { pendingMate, doc, products } = get()
      if (!pendingMate) return
      const r = insertAdapter(doc, products, pendingMate.parent, pendingMate.child, option)
      if ('error' in r) {
        set({ pendingMate: undefined, message: { kind: 'error', text: ops.CONNECT_ERROR_TEXT[r.error as ops.ConnectError] ?? r.error } })
        return
      }
      commit(r.doc)
      for (const m of r.doc.mates.filter((x) => x.parent.instance === r.instanceId || x.child.instance === r.instanceId)) {
        void recordMate(r.doc, m.parent, m.child)
      }
      set({ pendingMate: undefined, selected: r.instanceId })
      info(`已插入轉接頭「${option.product.modelCode}」`)
    },

    rotateMate(mateId, delta) {
      const { doc } = get()
      const mate = doc.mates.find((m) => m.id === mateId)
      if (mate) commit(ops.setMateAngle(doc, mateId, mate.angle + delta))
    },

    disconnectMate(mateId) {
      commit(ops.disconnect(get().doc, get().products, mateId))
    },

    undo() {
      const { past, doc, future, mode } = get()
      if (!past.length || mode === 'simulate') return
      set({ doc: past[past.length - 1], past: past.slice(0, -1), future: [doc, ...future], connectFrom: undefined })
      scheduleSave()
    },

    redo() {
      const { past, doc, future, mode } = get()
      if (!future.length || mode === 'simulate') return
      set({ doc: future[0], past: [...past, doc], future: future.slice(1), connectFrom: undefined })
      scheduleSave()
    },

    newModule() {
      void openDoc(ops.createModule())
    },

    async openModule(id) {
      const doc = await catalog?.getModule(id)
      if (doc) await openDoc(doc)
    },

    async deleteModule(id) {
      await catalog?.deleteModule(id)
      set((s) => ({ modules: s.modules.filter((m) => m.id !== id) }))
      if (get().doc.id === id) void openDoc(ops.createModule())
    },

    renameModule(patch) {
      commit({ ...get().doc, ...patch, updatedAt: Date.now() })
    },

    async exportModuleFile() {
      try {
        const { doc } = get()
        await catalog!.putModule(doc)
        const bytes = await exportModuleArchive(catalog!, doc.id)
        downloadFile(bytes, `${safeFileName(doc.name)}${MODULE_EXT}`, 'application/zip')
      } catch (err) {
        fail(err)
      }
    },

    async exportLibraryFile() {
      try {
        set({ busy: '匯出產品庫…' })
        const bytes = await exportLibraryArchive(catalog!)
        const d = new Date()
        const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
        downloadFile(bytes, `產品庫-${stamp}${LIBRARY_EXT}`, 'application/zip')
        set({ busy: undefined })
      } catch (err) {
        fail(err)
      }
    },

    downloadBomCsv() {
      const { doc, products } = get()
      downloadFile(bomToCsv(doc, buildBom(doc, products)), `${safeFileName(doc.name)}-BOM.csv`, 'text/csv;charset=utf-8')
    },

    requestFit(target) {
      set((s) => ({ fitRequest: s.fitRequest + 1, fitTarget: target }))
    },

    dismissMessage() {
      set({ message: undefined })
    },

    toggleDrawer(drawer) {
      set((s) => ({ drawer: s.drawer === drawer ? undefined : drawer }))
    },

    addMeasurePoint(point) {
      set((s) => ({ measure: s.measure.length >= 2 ? [point] : [...s.measure, point] }))
    },

    addMeasurePortPoint(ref) {
      const { doc, products } = get()
      const port = ops.getPort(doc, products, ref)
      const t = ops.computeTransforms(doc, products).transforms[ref.instance]
      if (!port || !t) return
      const p = new Vector3(...port.frame.origin).applyMatrix4(new Matrix4().fromArray(t))
      get().addMeasurePoint([p.x, p.y, p.z])
    },

    clearMeasure() {
      set({ measure: [] })
    },

    toggleDims() {
      set((s) => ({ showDims: !s.showDims }))
    },

    openDrawing(open) {
      set({ drawingOpen: open })
    },

    selectTube(tubeId) {
      set({ selectedTube: tubeId, selected: tubeId ? undefined : get().selected })
    },

    setTubeLength(tubeId, length) {
      commit(ops.updateTube(get().doc, tubeId, { length }))
    },

    deleteTube(tubeId) {
      commit(ops.removeTube(get().doc, tubeId))
      if (get().selectedTube === tubeId) set({ selectedTube: undefined })
    },

    setSupply(ref, pressure) {
      const { doc } = get()
      commit(ops.setSupply(doc, ref && { ...ref, ...(pressure !== undefined ? { pressure } : doc.supply?.pressure !== undefined && { pressure: doc.supply.pressure }) }))
    },

    setDrawingInfo(patch) {
      const { doc } = get()
      set({ doc: { ...doc, drawing: { ...doc.drawing, ...patch }, updatedAt: Date.now() }, saved: false })
      scheduleSave()
    },

    setIllustration(patch) {
      const { doc } = get()
      set({ doc: { ...doc, illustration: { ...doc.illustration, ...patch }, updatedAt: Date.now() }, saved: false })
      scheduleSave()
    },

    setInstanceParams(instanceId, patch) {
      const { doc } = get()
      const inst = doc.instances.find((i) => i.id === instanceId)
      if (!inst) return
      const params: Record<string, ParamValue> = { ...inst.params }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete params[key]
        else params[key] = value
      }
      const next: ModuleInstance = Object.keys(params).length ? { ...inst, params } : { id: inst.id, productId: inst.productId }
      commit({ ...doc, instances: doc.instances.map((i) => (i.id === instanceId ? next : i)), updatedAt: Date.now() })
    },

    ensureSignals,

    setSizing(patch) {
      const { doc } = get()
      const sizing = sanitizeSizing({ ...doc.sizing, ...patch })
      const next: ModuleDoc = { ...doc, updatedAt: Date.now() }
      if (sizing) next.sizing = sizing
      else delete next.sizing
      set({ doc: next, saved: false })
      scheduleSave()
    },

    setSequence(sequence) {
      if (get().seq.mode !== 'off') return
      const { doc } = get()
      set({ doc: { ...doc, sequence, updatedAt: Date.now() }, saved: false })
      scheduleSave()
    },

    seqAuto() {
      const sequence = get().doc.sequence
      if (!sequence?.steps.length) return
      ensureRunning()
      applySequencer(runSequence(sequence, get().seq, get().seq.continuous))
    },

    seqStep() {
      const sequence = get().doc.sequence
      if (!sequence?.steps.length) return
      ensureRunning()
      applySequencer(stepSequence(sequence, get().seq, get().sim?.state.signals ?? {}))
    },

    seqStop() {
      set({ seq: stopSequence(get().seq) })
    },

    seqHome() {
      const sim = get().sim
      if (!sim) return
      restartSimulation({ ...sim, state: step(sim.mc.circuit, createInitialState(sim.mc.circuit), 0) })
    },

    setContinuous(on) {
      set({ seq: { ...get().seq, continuous: on } })
    },

    toggleSequencePanel(open = !get().sequenceOpen) {
      if (!open) {
        set({ sequenceOpen: false })
        return
      }
      ensureSignals()
      // 面板佔掉 3D 畫面下方：重新縮放，讓整個模組都看得到
      set((s) => ({ sequenceOpen: true, fitRequest: s.fitRequest + 1, fitTarget: undefined }))
    },

    loadDocMeshes() {
      return ensureDocMeshes(get().doc)
    },
  }
})

/** PU 管兩端埠的世界座標（原點與朝外的軸向）；埠不存在時回傳 undefined */
export const tubeFrames = (
  doc: ModuleDoc,
  products: ops.ProductMap,
  tube: Pick<ModuleTube, 'a' | 'b'>,
  transforms = ops.computeTransforms(doc, products).transforms,
) => ops.tubeFrames(doc, products, tube, transforms)

/** 目前模組中所有零件的世界矩陣 */
export function useTransforms(): ops.TransformResult {
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  return useMemo(() => ops.computeTransforms(doc, products), [doc, products])
}

/** 連接流程中，與第一個埠搭配的檢查結果 */
export function compatibilityWith(from: PortRef | undefined, ref: PortRef): ReturnType<typeof checkMate> | undefined {
  if (!from) return undefined
  const { doc, products } = useModuleStore.getState()
  return checkMate(ops.getPort(doc, products, from)?.spec, ops.getPort(doc, products, ref)?.spec)
}

export { findAdapters }

/** 連接流程中，可以接到 from 的產品（依常用程度排序） */
export function useSuggestions(): { from?: PortRef; list: Suggestion[] } {
  const from = useModuleStore((s) => s.connectFrom)
  const doc = useModuleStore((s) => s.doc)
  const products = useModuleStore((s) => s.products)
  const stats = useModuleStore((s) => s.stats)
  return useMemo(() => {
    if (!from) return { list: [] }
    const inst = doc.instances.find((i) => i.id === from.instance)
    const product = inst && products[inst.productId]
    const port = product?.ports.find((p) => p.id === from.port)
    if (!product || !port) return { from, list: [] }
    return { from, list: suggestPartners({ product, port }, Object.values(products), stats) }
  }, [from, doc, products, stats])
}
