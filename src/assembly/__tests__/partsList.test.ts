import { describe, expect, it } from 'vitest'
import type { Product } from '../../catalog/types'
import { normalizeCode, normalizePortName, parsePartsList, productIndex } from '../partsList'

const product = (modelCode: string): Product =>
  ({ id: modelCode, modelCode, name: '', category: 'other', source: { fileName: '', sha256: modelCode, format: 'step', bytes: 1 }, ports: [], createdAt: 0, updatedAt: 0 }) as Product

const LIBRARY = ['4SV200M5F', '4SV21008BD', '4SV230C08BD', 'PL802D', 'PLL802D', 'PL1002D', 'PL1202D', 'BSL01', 'GSC1/4008Z', 'SC32X100'].map(product)
const index = productIndex(LIBRARY)
const parse = (text: string) => parsePartsList(text, index.isCode)

describe('parsePartsList', () => {
  it('一行一個型號，各種數量寫法', () => {
    const r = parse(['4SV200M5F', '4SV21008BD ×4', 'PL802D x8', 'PLL802D*2', 'BSL01 2個', '3 x GSC1/4008Z', 'PL1002D 1pcs', '# 註解', '', 'PL1202D ×1  // 右側'].join('\n'))
    expect(r.errors).toEqual([])
    expect(r.entries.map((e) => [e.code, e.qty])).toEqual([
      ['4SV200M5F', 1],
      ['4SV21008BD', 4],
      ['PL802D', 8],
      ['PLL802D', 2],
      ['BSL01', 2],
      ['GSC1/4008Z', 3],
      ['PL1002D', 1],
      ['PL1202D', 1],
    ])
    expect(r.entries[1].line).toBe(2)
  })

  it('型號本身以 X 數字結尾時不拆成數量', () => {
    expect(parse('SC32X100').entries[0]).toMatchObject({ code: 'SC32X100', qty: 1 })
    expect(parse('SC32X100 ×2').entries[0]).toMatchObject({ code: 'SC32X100', qty: 2 })
    // 不在產品庫的型號：緊接的 x 數字不拆（交給「找不到型號」提醒）
    expect(parse('ABC12X50').entries[0]).toMatchObject({ code: 'ABC12X50', qty: 1 })
    expect(parse('PL802DX8').entries[0]).toMatchObject({ code: 'PL802D', qty: 8 })
  })

  it('一行多個（、；）與指定埠（→、@、接在）', () => {
    const r = parse('PL802D ×8 → A、B；BSL01×2 @ EA EB\nPLL802D ×2 接在 4SV230C08BD 的 A、B 埠\nPL1002D、PL1202D')
    expect(r.entries.map((e) => [e.code, e.qty, e.hint])).toEqual([
      ['PL802D', 8, { ports: ['A', 'B'] }],
      ['BSL01', 2, { ports: ['EA', 'EB'] }],
      ['PLL802D', 2, { target: '4SV230C08BD', ports: ['A', 'B'] }],
      ['PL1002D', 1, undefined],
      ['PL1202D', 1, undefined],
    ])
  })

  it('從 Excel 複製（Tab）或 CSV：型號欄與數量欄', () => {
    const r = parse('項次\t型號\t名稱\t數量\n1\t4SV21008BD\t電磁閥\t4\n2,PL802D,直角接頭,8')
    expect(r.entries.map((e) => [e.code, e.qty])).toEqual([
      ['4SV21008BD', 4],
      ['PL802D', 8],
    ])
  })

  it('全形字與大小寫', () => {
    expect(normalizeCode('ｐｌ８０２ｄ　')).toBe('PL802D')
    expect(parse('ｐｌ８０２ｄ ×８').entries[0]).toMatchObject({ code: 'pl802d', qty: 8 })
    expect(index.find('ｐｌ８０２ｄ')?.modelCode).toBe('PL802D')
    expect(normalizePortName('a 埠')).toBe('A')
  })
})

describe('productIndex', () => {
  it('寬鬆比對（忽略 - / 符號）與相近型號', () => {
    expect(index.find('GSC1-4008Z')?.modelCode).toBe('GSC1/4008Z')
    expect(index.find('pl-802d')?.modelCode).toBe('PL802D')
    expect(index.find('PL803D')).toBeUndefined()
    expect(index.similar('PL803D').map((p) => p.modelCode)).toContain('PL802D')
    expect(index.similar('4SV21008B').map((p) => p.modelCode)[0]).toBe('4SV21008BD')
    expect(index.similar('ZZZZ')).toEqual([])
  })
})
