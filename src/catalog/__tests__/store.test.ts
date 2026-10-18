import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { formatSpec, parseSpec } from '../../threads'
import { exportBackupArchive, exportLibraryArchive, exportModuleArchive, importArchive } from '../archive'
import { CatalogStore } from '../db'
import { attachCadFile, createModelOnlyProduct, guessModelCode, importCadFile } from '../importer'
import { installSamples } from '../samples'
import { nodeParser, readFixture, readSample, sampleManifest, uniqueDbName } from './nodeHelpers'

const open = () => CatalogStore.open(uniqueDbName())

async function withSamples() {
  const store = await open()
  await installSamples(store, sampleManifest(), readSample, nodeParser)
  return store
}

const byModel = async (store: CatalogStore, modelCode: string) => {
  const p = (await store.listProducts()).find((x) => x.modelCode === modelCode)
  if (!p) throw new Error(`找不到 ${modelCode}`)
  return p
}

describe('匯入 CAD 檔（以 SHA-256 認出同一個檔案）', () => {
  it('第一次建立新產品，第二次認出已記住的產品', async () => {
    const store = await open()
    const bytes = await readSample('DEMO-SILENCER-R18.step')
    const first = await importCadFile(store, 'DEMO-SILENCER-R18.step', bytes, nodeParser)
    expect(first.status).toBe('new')
    expect(first.product.modelCode).toBe('DEMO-SILENCER-R18')
    expect(await store.getMesh(first.product.source.sha256)).toBeDefined()
    expect((await store.getFile(first.product.source.sha256))?.bytes.length).toBe(bytes.length)

    // 檔名不同但內容相同 → 仍是同一個產品
    const again = await importCadFile(store, '另存的檔名.stp', bytes, nodeParser)
    expect(again).toMatchObject({ status: 'existing', product: { id: first.product.id } })
    expect(await store.listProducts()).toHaveLength(1)
  })

  it('不支援的格式', async () => {
    const store = await open()
    await expect(importCadFile(store, 'part.stl', new Uint8Array(4), nodeParser)).rejects.toThrow('不支援的檔案格式')
  })

  it('型號預設取檔名', () => {
    expect(guessModelCode('C:\\cad\\PC6-01.STEP')).toBe('PC6-01')
    expect(guessModelCode('SY3120-5LZD-M5.stp')).toBe('SY3120-5LZD-M5')
  })

  it('刪除產品時一併刪除原始檔與網格', async () => {
    const store = await open()
    const { product } = await importCadFile(store, 'x.step', await readSample('DEMO-SILENCER-R18.step'), nodeParser)
    await store.deleteProduct(product.id)
    expect(await store.listProducts()).toHaveLength(0)
    expect(await store.getFile(product.source.sha256)).toBeUndefined()
    expect(await store.getMesh(product.source.sha256)).toBeUndefined()
  })
})

describe('範例零件庫', () => {
  it('安裝 12 個範例，每個埠的規格都能解析', async () => {
    const store = await withSamples()
    const products = await store.listProducts()
    expect(products).toHaveLength(12)
    const valve = await byModel(store, 'DEMO-VALVE-52-01')
    expect(valve.ports.map((p) => `${p.name}:${formatSpec(p.spec!)}`)).toEqual([
      'A:Rc1/8 母（PT）',
      'B:Rc1/8 母（PT）',
      'EA:Rc1/8 母（PT）',
      'P:Rc1/8 母（PT）',
      'EB:Rc1/8 母（PT）',
      '安裝面:安裝面「100 系列閥座」（元件側）',
    ])
    // 底面的 P／EA／EB 由安裝面封住（裝在集裝座上時由集裝座供氣、排氣）
    const mount = valve.ports.find((p) => p.name === '安裝面')!
    expect(valve.ports.filter((p) => p.sealedBy === mount.id).map((p) => p.name)).toEqual(['EA', 'P', 'EB'])
    const manifold = await byModel(store, 'DEMO-MANIFOLD-4')
    expect(manifold.ports.find((p) => p.name === '站1')?.spec).toMatchObject({ kind: 'interface', role: 'socket' })
    expect(manifold.ports.find((p) => p.name === '站1')?.rotation).toBe('fixed')
  })

  it('範例零件帶有氣動功能，埠以 id 對應', async () => {
    const store = await withSamples()
    const sc = await byModel(store, 'DEMO-SC-M5-D4')
    const id = (name: string) => sc.ports.find((p) => p.name === name)!.id
    expect(sc.pneumatic).toEqual({ type: 'flowControl', portMap: { '2': id('1'), '1': id('2') } })
    const cyl = await byModel(store, 'DEMO-CYL-16-50')
    expect(cyl.pneumatic).toMatchObject({ type: 'cylinderDouble', params: { bore: 16, stroke: 50 } })
    expect(Object.keys(cyl.pneumatic!.portMap).sort()).toEqual(['A', 'B'])
  })

  it('再次安裝不會覆蓋使用者修改過的埠', async () => {
    const store = await withSamples()
    const silencer = await byModel(store, 'DEMO-SILENCER-R18')
    const edited = { ...silencer, ports: [{ ...silencer.ports[0], name: '我改過的名稱' }] }
    await store.putProduct(edited)
    const r = await installSamples(store, sampleManifest(), readSample, nodeParser)
    expect(r).toEqual({ added: 0, existing: 12 })
    expect((await store.getProduct(silencer.id))?.ports[0].name).toBe('我改過的名稱')
  })
  it('範例改版時，舊版保留（模組可能用到）並在型號加註「舊版」', async () => {
    const store = await open()
    // 舊版的範例電磁閥：同一個檔名、不同的內容
    const old = await importCadFile(store, 'DEMO-VALVE-52-01.step', await readFixture('SUBBASE-MANIFOLD-4.step'), nodeParser)
    await store.putProduct({ ...old.product, modelCode: 'DEMO-VALVE-52-01', source: { ...old.product.source, fileName: 'DEMO-VALVE-52-01.step' } })
    await installSamples(store, sampleManifest(), readSample, nodeParser)
    expect((await store.getProduct(old.product.id))?.modelCode).toBe('DEMO-VALVE-52-01（舊版）')
    expect((await store.listProducts()).filter((p) => p.modelCode === 'DEMO-VALVE-52-01')).toHaveLength(1)
  })
})

describe('產品庫與模組的匯出／匯入', () => {
  it('匯出整個產品庫，匯入到空的產品庫後完全相同', async () => {
    const a = await withSamples()
    const archive = await exportLibraryArchive(a)
    const b = await open()
    const report = await importArchive(b, archive)
    expect(report).toMatchObject({ kind: 'library', productsAdded: 12, productsMerged: 0, conflicts: [] })
    const [pa, pb] = [await a.listProducts(), await b.listProducts()]
    const sort = (list: typeof pa) => [...list].sort((x, y) => x.id.localeCompare(y.id))
    expect(sort(pb)).toEqual(sort(pa))
    const sha = pa[0].source.sha256
    expect((await b.getMesh(sha))?.tessellation.triangleCount).toBe((await a.getMesh(sha))?.tessellation.triangleCount)
    expect((await b.getFile(sha))?.bytes).toEqual((await a.getFile(sha))?.bytes)
  })

  it('重複匯入不會產生重複產品', async () => {
    const a = await withSamples()
    const archive = await exportLibraryArchive(a)
    const b = await open()
    await importArchive(b, archive)
    const again = await importArchive(b, archive)
    expect(again).toMatchObject({ productsAdded: 0, productsMerged: 12, portsAdded: 0, conflicts: [] })
    expect(await b.listProducts()).toHaveLength(12)
  })

  it('本機與匯入檔規格不同時保留本機並列出差異；本機未設定的規格會補上', async () => {
    const a = await withSamples()
    const archive = await exportLibraryArchive(a)
    const b = await open()
    await importArchive(b, archive)

    const bush = await byModel(b, 'DEMO-BUSH-R14-RC18')
    const npt = parseSpec('NPT1/4 公')
    if (!npt.ok) throw new Error()
    const ports = bush.ports.map((p, i) => (i === 0 ? { ...p, spec: npt.spec } : { ...p, spec: undefined }))
    await b.putProduct({ ...bush, ports })

    const report = await importArchive(b, archive)
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]).toContain('本機為 NPT1/4 公')
    expect(report.specsFilled).toBe(1)
    const after = await b.getProduct(bush.id)
    expect(formatSpec(after!.ports[0].spec!)).toBe('NPT1/4 公')
    expect(formatSpec(after!.ports[1].spec!)).toBe('Rc1/8 母（PT）')
  })

  it('模組檔包含用到的產品；匯入後引用正確，重複匯入時另存一份', async () => {
    const a = await withSamples()
    const valve = await byModel(a, 'DEMO-VALVE-52-01')
    const fitting = await byModel(a, 'DEMO-FITTING-R18-D6')
    const now = Date.now()
    await a.putModule({
      id: 'mod_1',
      name: '客戶 A 閥組',
      instances: [
        { id: 'i1', productId: valve.id },
        { id: 'i2', productId: fitting.id },
      ],
      mates: [{ id: 'm1', parent: { instance: 'i1', port: valve.ports[0].id }, child: { instance: 'i2', port: fitting.ports[0].id }, angle: 0 }],
      placements: { i1: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      tubes: [{ id: 't1', a: { instance: 'i2', port: fitting.ports[1].id }, b: { instance: 'i2', port: fitting.ports[1].id }, od: 6, label: 'Ø6', length: 250 }],
      supply: { instance: 'i1', port: valve.ports[3].id, pressure: 0.5 },
      createdAt: now,
      updatedAt: now,
    })
    const archive = await exportModuleArchive(a, 'mod_1')

    const c = await open()
    const report = await importArchive(c, archive)
    expect(report).toMatchObject({ kind: 'module', productsAdded: 2, moduleId: 'mod_1' })
    const imported = await c.getModule('mod_1')
    expect(imported?.instances.map((i) => i.productId).sort()).toEqual([valve.id, fitting.id].sort())
    expect(imported?.mates[0].parent.port).toBe(valve.ports[0].id)
    // PU 管與供氣口一起帶過來
    expect(imported?.tubes).toEqual([expect.objectContaining({ id: 't1', od: 6, length: 250, a: { instance: 'i2', port: fitting.ports[1].id } })])
    expect(imported?.supply).toEqual({ instance: 'i1', port: valve.ports[3].id, pressure: 0.5 })

    const second = await importArchive(c, archive)
    expect(second.moduleId).not.toBe('mod_1')
    expect((await c.getModule(second.moduleId!))?.name).toBe('客戶 A 閥組（匯入）')
    expect(await c.listProducts()).toHaveLength(2)
  })

  it('不是匯出檔時丟出中文錯誤', async () => {
    const b = await open()
    await expect(importArchive(b, new Uint8Array([1, 2, 3]))).rejects.toThrow('檔案格式錯誤')
  })
})

describe('資料庫升級', () => {
  it('v1 的資料庫升級到 v2 後，既有產品仍在，且可以存迴路圖', async () => {
    const { openDB } = await import('idb')
    const name = uniqueDbName()
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        const products = db.createObjectStore('products', { keyPath: 'id' })
        products.createIndex('by-sha', 'source.sha256', { unique: true })
        db.createObjectStore('files', { keyPath: 'sha256' })
        db.createObjectStore('meshes', { keyPath: 'sha256' })
        db.createObjectStore('modules', { keyPath: 'id' })
      },
    })
    await v1.put('products', { id: 'old', modelCode: 'OLD-1', source: { sha256: 'x' } })
    v1.close()

    const store = await CatalogStore.open(name)
    expect((await store.listProducts()).map((p) => p.modelCode)).toEqual(['OLD-1'])
    await store.putCircuit({ id: 'c1', name: '迴路', createdAt: 1, updatedAt: 1, nodes: [], edges: [] })
    expect((await store.listCircuits()).map((c) => c.name)).toEqual(['迴路'])
    store.close()
  })
})

describe('完整備份（.pbak）', () => {
  it('產品、模組、迴路圖、搭配記錄、縮圖與設定全部還原；重複還原不會產生重複資料', async () => {
    const a = await withSamples()
    const valve = await byModel(a, 'DEMO-VALVE-52-01')
    const fitting = await byModel(a, 'DEMO-FITTING-R18-D6')
    await a.putModule({
      id: 'm1',
      name: '閥模組',
      instances: [{ id: 'i1', productId: valve.id }],
      mates: [],
      placements: {},
      createdAt: 1,
      updatedAt: 5,
    })
    await a.putCircuit({
      id: 'c1',
      name: '迴路',
      createdAt: 1,
      updatedAt: 5,
      nodes: [
        {
          id: 'n1',
          type: 'pneumatic',
          position: { x: 0, y: 0 },
          data: { componentType: 'valve52Single', rotation: 0, product: { id: valve.id, modelCode: valve.modelCode, name: '' } },
        },
      ],
      edges: [],
    })
    const statKey = `${valve.id}:${valve.ports[0].id}>${fitting.id}:${fitting.ports[0].id}`
    await a.bumpStats([statKey, statKey])
    await a.putThumb({ sha256: valve.source.sha256, png: new Uint8Array([137, 80, 78, 71]) })
    await a.putSetting('app', { company: { name: '甲公司' } })

    const backup = await exportBackupArchive(a)
    const b = await open()
    const report = await importArchive(b, backup)
    expect(report).toMatchObject({ kind: 'backup', productsAdded: 12, modulesRestored: 1, circuitsRestored: 1 })
    expect((await b.getModule('m1'))?.updatedAt).toBe(5)
    expect((await b.getCircuit('c1'))?.nodes).toHaveLength(1)
    expect((await b.listStats()).find((s) => s.key === statKey)?.count).toBe(2)
    expect((await b.getThumb(valve.source.sha256))?.png).toEqual(new Uint8Array([137, 80, 78, 71]))
    expect(await b.getSetting('app')).toEqual({ company: { name: '甲公司' } })

    const again = await importArchive(b, backup)
    expect(again).toMatchObject({ productsAdded: 0, modulesRestored: 0, circuitsRestored: 0 })
    expect(await b.listModules()).toHaveLength(1)
    expect((await b.listStats()).find((s) => s.key === statKey)?.count).toBe(2)
  })
})

describe('只有型號的產品', () => {
  it('建立後可以附加 3D 檔；檔案已屬於其他產品時拒絕', async () => {
    const store = await open()
    const p = await createModelOnlyProduct(store, { modelCode: 'VQ1101', category: 'valve', maker: 'SMC', price: 800 })
    expect(p.source.bytes).toBe(0)
    expect(await store.getProduct(p.id)).toMatchObject({ modelCode: 'VQ1101', maker: 'SMC', price: 800 })
    const q = await createModelOnlyProduct(store, { modelCode: 'VQ1201', category: 'valve' })
    expect(q.source.sha256).not.toBe(p.source.sha256)

    const bytes = await readSample('DEMO-SILENCER-R18.step')
    const attached = await attachCadFile(store, p, 'VQ1101.step', bytes, nodeParser)
    expect(attached.source.bytes).toBe(bytes.length)
    expect(await store.getMesh(attached.source.sha256)).toBeDefined()
    expect((await store.getProductBySha(attached.source.sha256))?.id).toBe(p.id)
    await expect(attachCadFile(store, q, 'x.step', bytes, nodeParser)).rejects.toThrow('已經是產品「VQ1101」')
  })

  it('只有型號的產品可以匯出、匯入（不需要 3D 資料）', async () => {
    const a = await open()
    await createModelOnlyProduct(a, { modelCode: 'NO-3D', category: 'fitting' })
    const b = await open()
    const report = await importArchive(b, await exportLibraryArchive(a))
    expect(report.productsAdded).toBe(1)
    expect((await b.listProducts())[0].modelCode).toBe('NO-3D')
  })
})
