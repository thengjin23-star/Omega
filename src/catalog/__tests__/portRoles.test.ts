import { describe, expect, it } from 'vitest'
import { parseSpec } from '../../threads'
import { portRole } from '../portRoles'

const spec = (text: string) => {
  const r = parseSpec(text, { gender: 'female', interfaceRole: 'socket' })
  if (!r.ok) throw new Error(r.error)
  return r.spec
}

describe('埠的用途', () => {
  it('依名稱：進氣、工作口、排氣、先導', () => {
    expect(['P', '1', 'IN'].map((name) => portRole({ name, spec: spec('Rc1/8') }))).toEqual(['supply', 'supply', 'supply'])
    expect(['A', 'B', '2', '4', 'A3', 'b2'].map((name) => portRole({ name, spec: spec('Rc1/8') }))).toEqual(Array(6).fill('work'))
    expect(['EA', 'EB', 'R', 'S', '3', '5', 'R1'].map((name) => portRole({ name, spec: spec('Rc1/8') }))).toEqual(Array(7).fill('exhaust'))
    expect(['12', '14'].map((name) => portRole({ name, spec: spec('M5') }))).toEqual(['pilot', 'pilot'])
    expect(portRole({ name: '管口', spec: spec('Rc1/4') })).toBe('other')
  })

  it('依規格：安裝面、插管、未設定', () => {
    expect(portRole({ name: '站1', spec: spec('安裝面：100 系列閥座') })).toBe('mount')
    expect(portRole({ name: '2', spec: spec('Ø6 快插') })).toBe('tube')
    expect(portRole({ name: 'P', spec: undefined })).toBe('unset')
  })
})
