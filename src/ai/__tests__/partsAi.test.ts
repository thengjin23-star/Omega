import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePartsList, productIndex } from '../../assembly/partsList'
import { PRODUCTS } from '../../assembly/__tests__/sampleModules'
import { geminiJson, GeminiError, pickDefaultModel } from '../gemini'
import { genericFromAi, libraryDigest, planFromAi, planToList, toGenericSpec, type AiPart, type AiResult } from '../partsAi'

const part = (p: Partial<AiPart>): AiPart => ({ ref: 'p1', label: '零件', qty: 1, kind: 'fitting', confidence: 'high', ...p })

describe('toGenericSpec：AI 的零件 → 通用零件（檢查與補值）', () => {
  it('接頭：管徑取最接近的標準尺寸；沒有螺紋是管對管', () => {
    expect(toGenericSpec(part({ kind: 'fitting', thread: '1/8', tube: 6 }))!.spec).toEqual({ kind: 'fitting', form: 'straight', thread: '1/8', std: 'PT', tube: 6 })
    expect(toGenericSpec(part({ kind: 'fitting', form: 'elbow', thread: '1/4', tube: 7, std: 'G' }))!.spec).toMatchObject({ form: 'elbow', tube: 6, std: 'G' })
    expect(toGenericSpec(part({ kind: 'fitting', form: 'tee', tube: 8 }))!.spec).toEqual({ kind: 'fitting', form: 'tee', tube: 8 })
  })

  it('缺的尺寸補常用值，並說明', () => {
    const r = toGenericSpec(part({ kind: 'cylinder' }))!
    expect(r.spec).toEqual({ kind: 'cylinder', bore: 32, stroke: 50 })
    expect(r.defaults).toEqual(['缸徑未指定，暫用 Ø32', '行程未指定，暫用 50 mm'])
    expect(toGenericSpec(part({ kind: 'cylinder', bore: 30, stroke: 75 }))!.spec).toMatchObject({ bore: 32, stroke: 75 })
    expect(toGenericSpec(part({ kind: 'manifold', thread: '1/8' }))!.defaults).toEqual(['站數未指定，暫用 4 站'])
  })

  it('閥：底板式沒有排氣口尺寸；不合法的值不採用', () => {
    expect(toGenericSpec(part({ kind: 'valve', valveFunction: '52Double', thread: '1/4', exhaust: '1/8' }))!.spec).toEqual({
      kind: 'valve',
      fn: '52Double',
      thread: '1/4',
      std: 'PT',
      exhaust: '1/8',
    })
    expect(toGenericSpec(part({ kind: 'valve', thread: '1/4', exhaust: '1/8', series: 300 }))!.spec).toEqual({
      kind: 'valve',
      fn: '52Single',
      thread: '1/4',
      std: 'PT',
      exhaust: '1/8',
      series: 300,
    })
    expect(toGenericSpec(part({ kind: 'valve', thread: '1/8', series: 250 }))!.spec).toEqual({ kind: 'valve', fn: '52Single', thread: '1/8', std: 'PT' })
    expect(toGenericSpec(part({ kind: 'manifold', stations: 6, thread: '1/4' }))!.spec).toEqual({ kind: 'manifold', stations: 6, series: 200, std: 'PT' })
    expect(toGenericSpec(part({ kind: 'silencer', thread: '2/3' as never }))!.spec).toEqual({ kind: 'silencer', thread: '1/8', std: 'PT' })
    expect(toGenericSpec(part({ kind: 'other' }))).toBeUndefined()
  })
})

describe('planFromAi', () => {
  const result: AiResult = {
    moduleName: '閥島',
    notes: ['沒說牙型，假設 PT'],
    parts: [
      part({ ref: 'p1', label: '集裝座 4 站', kind: 'manifold', stations: 4, thread: '1/8' }),
      part({ ref: 'p2', label: '底板閥', kind: 'valve', mount: 'base', thread: '1/8', qty: 4, connectTo: 'p1' }),
      part({ ref: 'p3', label: '接頭 Ø6', libraryCode: 'demo-fitting-r18-d6', qty: 8, connectTo: 'p1', ports: ['A', 'B'] }),
      part({ ref: 'p4', label: '亂掰的型號', libraryCode: 'NOT-IN-LIBRARY', kind: 'silencer', thread: '1/8', qty: 2, connectTo: 'p9' }),
      part({ ref: 'p5', label: '不知道', kind: 'other' }),
    ],
  }
  const rows = planFromAi(result, Object.values(PRODUCTS))

  it('產品庫的型號要真的存在（大小寫不拘）；編出來的型號改用通用 3D', () => {
    expect(rows[2].product?.modelCode).toBe('DEMO-FITTING-R18-D6')
    expect(rows[3].product).toBeUndefined()
    expect(rows[3].spec).toEqual({ kind: 'silencer', thread: '1/8', std: 'PT' })
  })

  it('connectTo 要指向清單裡的零件；無法判斷的列出原因', () => {
    expect(rows[1].connectTo).toBe('p1')
    expect(rows[3].connectTo).toBeUndefined()
    expect(rows[4].notes).toEqual(['無法判斷種類與尺寸，不會加入'])
  })

  it('轉成型號清單（型號含空白、指定零件與埠），清單解析得回來', () => {
    const codes = ['通用 集裝座 4 站 PT1/8', '通用 底板閥 5/2單 PT1/8', 'DEMO-FITTING-R18-D6', '通用 消音器 PT1/8']
    const list = planToList(rows.slice(0, 4).map((r, i) => ({ ...r, modelCode: codes[i] })))
    expect(list.split('\n')[2]).toBe('DEMO-FITTING-R18-D6 ×8 → 通用 集裝座 4 站 PT1/8 的 A、B  # 接頭 Ø6')
    const known = new Set(codes.map((c) => c.replace(/\s+/g, '').toUpperCase()))
    const isCode = (c: string) => known.has(c.replace(/\s+/g, '').toUpperCase())
    const parsed = parsePartsList(list, isCode)
    expect(parsed.errors).toEqual([])
    expect(parsed.entries.map((e) => [e.code, e.qty, e.hint])).toEqual([
      ['通用 集裝座 4 站 PT1/8', 1, undefined],
      ['通用 底板閥 5/2單 PT1/8', 4, { target: '通用 集裝座 4 站 PT1/8', ports: [] }],
      ['DEMO-FITTING-R18-D6', 8, { target: '通用 集裝座 4 站 PT1/8', ports: ['A', 'B'] }],
      ['通用 消音器 PT1/8', 2, undefined],
    ])
  })

  it('產品庫清單給 AI 看：型號、名稱、分類與埠', () => {
    const digest = libraryDigest(Object.values(PRODUCTS))
    expect(digest).toContain('- DEMO-VALVE-52-01｜')
    expect(digest).toMatch(/DEMO-SILENCER-R18｜.*｜消音器｜埠：1 R1\/8/)
  })
})

describe('閥島的系列', () => {
  it('集裝座跟著裝在上面的閥（依接管口決定系列）', () => {
    const rows = planFromAi(
      {
        notes: [],
        parts: [
          part({ ref: 'p1', label: '集裝座', kind: 'manifold', stations: 4, series: 100 }),
          part({ ref: 'p2', label: '電磁閥 3/8', kind: 'valve', thread: '3/8', qty: 4, connectTo: 'p1' }),
        ],
      },
      [],
    )
    expect(rows[0].spec).toMatchObject({ kind: 'manifold', series: 300 })
  })
})

describe('genericFromAi：判斷不認得的型號', () => {
  it('只採用問的型號、有把握的答案', () => {
    const r = genericFromAi(
      {
        notes: [],
        parts: [
          part({ code: 'kq2h06-01s', label: '直通快插接頭 R1/8 × Ø6', thread: '1/8', tube: 6, maker: 'SMC' }),
          part({ ref: 'p2', code: 'SY3120-5LZD', label: '電磁閥', kind: 'valve', thread: 'M5', confidence: 'low' }),
          part({ ref: 'p3', code: 'OTHER', label: '別的', kind: 'silencer', thread: '1/8' }),
        ],
      },
      ['KQ2H06-01S', 'SY3120-5LZD'],
    )
    expect([...r.keys()]).toEqual(['KQ2H06-01S'])
    expect(r.get('KQ2H06-01S')).toEqual({ spec: { kind: 'fitting', form: 'straight', thread: '1/8', std: 'PT', tube: 6 }, name: '直通快插接頭 R1/8 × Ø6', maker: 'SMC' })
  })
})

describe('Gemini', () => {
  afterEach(() => vi.unstubAllGlobals())
  const respond = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
  const req = { apiKey: 'k', model: 'gemini-2.5-flash', system: 's', prompt: 'p', schema: { type: 'OBJECT' as const, properties: {} } }

  it('解析 JSON 回答（略過思考內容）', async () => {
    respond(200, { candidates: [{ content: { parts: [{ text: '想一下', thought: true }, { text: '{"parts":[],"notes":["ok"]}' }] }, finishReason: 'STOP' }] })
    expect(await geminiJson(req)).toEqual({ parts: [], notes: ['ok'] })
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
    expect((call[1] as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'k' })
    expect(JSON.parse((call[1] as RequestInit).body as string).generationConfig).toMatchObject({ responseMimeType: 'application/json' })
  })

  it('錯誤訊息轉成中文', async () => {
    respond(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } })
    await expect(geminiJson(req)).rejects.toThrow(/API 金鑰無效/)
    respond(429, { error: { message: 'quota' } })
    await expect(geminiJson(req)).rejects.toThrow(/額度/)
    respond(404, { error: { message: 'models/x is not found' } })
    const err = (await geminiJson(req).catch((e: unknown) => e)) as GeminiError
    expect(err).toBeInstanceOf(GeminiError)
    expect(err.status).toBe(404)
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(geminiJson(req)).rejects.toThrow(/無法連線/)
  })

  it('預設模型：最新的 Flash 正式版', () => {
    const m = (ids: string[]) => ids.map((id) => ({ id, displayName: id }))
    expect(pickDefaultModel(m(['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.0-flash-preview']))).toBe('gemini-2.5-flash')
    expect(pickDefaultModel(m(['gemini-3-flash', 'gemini-2.5-flash']))).toBe('gemini-3-flash')
    expect(pickDefaultModel(m(['gemini-flash-latest', 'gemini-2.5-pro']))).toBe('gemini-flash-latest')
    expect(pickDefaultModel(m(['gemini-2.5-flash-lite', 'gemini-3.1-flash-preview']))).toBe('gemini-3.1-flash-preview')
  })
})

describe('清單解析：型號含空白時的指定零件', () => {
  it('「型號 的 埠」與整段型號', () => {
    const index = productIndex(Object.values(PRODUCTS))
    const codes = new Set(['通用 集裝座 4 站 PT1/8'])
    const isCode = (c: string) => codes.has(c) || index.isCode(c)
    const r = parsePartsList('DEMO-SILENCER-R18 ×2 接在 通用 集裝座 4 站 PT1/8 的 EA、EB\nDEMO-FITTING-R18-D6 → 通用 集裝座 4 站 PT1/8', isCode)
    expect(r.entries.map((e) => e.hint)).toEqual([
      { target: '通用 集裝座 4 站 PT1/8', ports: ['EA', 'EB'] },
      { target: '通用 集裝座 4 站 PT1/8', ports: [] },
    ])
  })
})
