import type { Dashboard, OrgNode, RunDay } from '../types'

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"

export const STATUS_COLORS: Record<string, string> = {
  running: '#2da44e',
  active: '#3b82f6',
  idle: '#3b82f6',
  pending_approval: '#d29922',
  paused: '#8c959f',
  error: '#e5534b',
  terminated: '#8c959f',
}

const ADAPTERS: Record<string, string> = {
  claude_local: 'Claude Code',
  codex_local: 'Codex',
  cursor_local: 'Cursor',
  cursor_cloud: 'Cursor Cloud',
  gemini_local: 'Gemini CLI',
  grok_local: 'Grok',
  kimi_local: 'Kimi',
  opencode_local: 'OpenCode',
  pi_local: 'Pi',
  openclaw_gateway: 'OpenClaw',
  hermes_local: 'Hermes',
  process: 'Process',
  http: 'HTTP',
}

export function adapterLabel(adapter: string): string {
  return ADAPTERS[adapter] ?? adapter.replace(/_/g, ' ')
}

/** What a card says under the name: the job title (or a specific role), the state and the adapter. */
export function agentSubtitle(node: OrgNode): string {
  const job = node.title && node.title !== node.name ? node.title : node.role && node.role !== 'agent' ? node.role.toUpperCase() : ''
  return [job, node.status.replace(/_/g, ' '), node.adapterType ? adapterLabel(node.adapterType) : ''].filter(Boolean).join(' · ')
}

export function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? '#8c959f'
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function clip(text: string, room: number): string {
  return text.length > room ? `${text.slice(0, Math.max(1, room - 1))}…` : text
}

export function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function spendLine(costs: Dashboard['costs']): string {
  if (costs.monthBudgetCents <= 0) return 'No monthly budget set'
  return `of ${money(costs.monthBudgetCents)} budget · ${Math.round(costs.monthUtilizationPercent)}% used`
}

export function countNodes(nodes: readonly OrgNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.reports), 0)
}

const STYLE = `<style>
.card{fill:#ffffff;stroke:rgba(31,35,40,.14)}
.board{fill:#f6f5f0;stroke:rgba(31,35,40,.14)}
.name{fill:#1f2328;font:600 13px ${FONT}}
.sub{fill:#656d76;font:12px ${FONT}}
.badge{fill:rgba(31,35,40,.06)}
.badge-text{fill:#656d76;font:600 11px ${FONT}}
.line{stroke:rgba(31,35,40,.22);stroke-width:1.5;fill:none}
.axis{fill:#656d76;font:11px ${FONT}}
.grid{stroke:rgba(31,35,40,.10);stroke-width:1}
.empty{fill:#656d76;font:12px ${FONT}}
.other{fill:rgba(31,35,40,.18)}
@media (prefers-color-scheme: dark){
.card{fill:rgba(255,255,255,.045);stroke:rgba(255,255,255,.12)}
.board{fill:rgba(255,255,255,.08);stroke:rgba(255,255,255,.14)}
.name{fill:#f0f0f0}
.sub,.badge-text,.axis,.empty{fill:#a1a1aa}
.badge{fill:rgba(255,255,255,.08)}
.line{stroke:rgba(255,255,255,.22)}
.grid{stroke:rgba(255,255,255,.10)}
.other{fill:rgba(255,255,255,.22)}
}
</style>`

/** Fourteen days of agent runs as stacked bars: succeeded, failed, other. */
export function activitySvg(days: readonly RunDay[], width: number): string {
  const height = 112
  const chartTop = 18
  const chartBottom = height - 22
  const left = 4
  const right = width - 4
  const max = Math.max(1, ...days.map(day => day.total))
  const slot = days.length > 0 ? (right - left) / days.length : 0
  const barWidth = Math.max(4, Math.min(22, slot - 6))
  const scale = (value: number) => (value / max) * (chartBottom - chartTop)
  const total = days.reduce((sum, day) => sum + day.total, 0)
  const failed = days.reduce((sum, day) => sum + day.failed, 0)
  const parts: string[] = [
    `<line class="grid" x1="${left}" x2="${right}" y1="${chartBottom + 0.5}" y2="${chartBottom + 0.5}"/>`,
    `<line class="grid" x1="${left}" x2="${right}" y1="${chartTop + 0.5}" y2="${chartTop + 0.5}" stroke-dasharray="3 4"/>`,
    `<text class="axis" x="${left}" y="${chartTop - 6}">${max} ${max === 1 ? 'run' : 'runs'}</text>`,
    `<text class="axis" x="${right}" y="${chartTop - 6}" text-anchor="end">${total} in 14 days${failed ? ` · ${failed} failed` : ''}</text>`,
  ]
  days.forEach((day, index) => {
    const x = left + index * slot + (slot - barWidth) / 2
    const other = Math.max(0, day.total - day.succeeded - day.failed)
    let y = chartBottom
    const tooltip = `${day.date}: ${day.total} runs, ${day.succeeded} succeeded, ${day.failed} failed`
    parts.push(`<g><title>${escapeXml(tooltip)}</title>`)
    parts.push(`<rect x="${x}" y="${chartTop}" width="${barWidth}" height="${chartBottom - chartTop}" fill="transparent"/>`)
    for (const [value, fill, cls] of [
      [day.succeeded, '#2da44e', ''],
      [day.failed, '#e5534b', ''],
      [other, '', 'other'],
    ] as const) {
      if (value <= 0) continue
      const h = Math.max(2, scale(value))
      y -= h
      parts.push(`<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="2"${fill ? ` fill="${fill}"` : ` class="${cls}"`}/>`)
    }
    if (day.total === 0) parts.push(`<rect class="other" x="${x}" y="${chartBottom - 2}" width="${barWidth}" height="2" rx="1"/>`)
    parts.push(`</g>`)
  })
  const first = days[0]?.date.slice(5) ?? ''
  const last = days[days.length - 1]?.date.slice(5) ?? ''
  parts.push(`<text class="axis" x="${left}" y="${height - 4}">${first}</text>`)
  parts.push(`<text class="axis" x="${right}" y="${height - 4}" text-anchor="end">${last}</text>`)
  if (total === 0) {
    parts.push(`<text class="empty" x="${width / 2}" y="${(chartTop + chartBottom) / 2 + 4}" text-anchor="middle">No agent runs in the last 14 days</text>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${STYLE}${parts.join('')}</svg>`
}

/** The org chart as text, for surfaces without Svg. */
export function orgText(nodes: readonly OrgNode[], companyName: string): string[] {
  const lines = [`Board · ${companyName}`]
  const walk = (list: readonly OrgNode[], prefix: string) => {
    list.forEach((node, index) => {
      const isLast = index === list.length - 1
      const detail = [node.title && node.title !== node.name ? node.title : '', node.status.replace(/_/g, ' ')]
        .filter(Boolean)
        .join(' · ')
      lines.push(`${prefix}${isLast ? '└─' : '├─'} ${node.name} (${detail})`)
      walk(node.reports, `${prefix}${isLast ? '   ' : '│  '}`)
    })
  }
  walk(nodes, '')
  if (nodes.length === 0) lines.push('└─ no agents yet')
  return lines
}

/** Fourteen days of runs as a one-line sparkline. */
export function sparkline(days: readonly RunDay[]): string {
  const bars = '▁▂▃▄▅▆▇█'
  const max = Math.max(0, ...days.map(day => day.total))
  if (max === 0) return '▁'.repeat(days.length)
  return days.map(day => bars[Math.min(7, Math.round((day.total / max) * 7))]).join('')
}
