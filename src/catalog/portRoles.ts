import type { ProductPort } from './types'

/**
 * 埠的用途（依名稱與規格）：畫面上用顏色區分。名稱是推測或使用者輸入的，
 * 用途也就跟著是推測；真正接氣路時仍以零件的氣動功能（埠對應）為準。
 */
export type PortRole = 'supply' | 'work' | 'exhaust' | 'pilot' | 'mount' | 'tube' | 'other' | 'unset'

const NAMES: [PortRole, RegExp][] = [
  ['supply', /^(P|1|IN|PA|SUP|SUPPLY|進氣|供氣)$/],
  ['work', /^(A|B|2|4|OUT|A\d+|B\d+|出口)$/],
  ['exhaust', /^(EA|EB|R|S|3|5|R\d|E|EXH|EX|排氣)$/],
  ['pilot', /^(12|14|10|X|Y|Z|PILOT|先導)$/],
]

export function portRole(port: Pick<ProductPort, 'name' | 'spec'>): PortRole {
  if (!port.spec) return 'unset'
  if (port.spec.kind === 'interface') return 'mount'
  if (port.spec.kind === 'tube') return 'tube'
  const name = port.name.trim().toUpperCase().replace(/\s+/g, '')
  return NAMES.find(([, re]) => re.test(name))?.[0] ?? 'other'
}

export const PORT_ROLE_COLOR: Record<PortRole, string> = {
  supply: '#dc2626',
  work: '#2563eb',
  exhaust: '#a16207',
  pilot: '#9333ea',
  mount: '#0d9488',
  tube: '#0891b2',
  other: '#334155',
  unset: '#f59e0b',
}

export const PORT_ROLE_LABEL: Record<PortRole, string> = {
  supply: '進氣',
  work: '工作口',
  exhaust: '排氣',
  pilot: '先導',
  mount: '安裝面',
  tube: '插管',
  other: '其他螺紋',
  unset: '未設定規格',
}
