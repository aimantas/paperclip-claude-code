import type { Agent, Company, IssueDetail, IssueSummary, ProjectSummary } from '../types'
import { PRIORITY_ORDER, statusLabel } from './paperclip'

export const ISSUE_COLORS: Record<string, string> = {
  in_progress: '#3b82f6',
  in_review: '#a371f7',
  blocked: '#e5534b',
  todo: '#8c959f',
  backlog: '#6e7781',
  done: '#2da44e',
  cancelled: '#6e7781',
}

export const PRIORITY_COLORS: Record<string, string> = {
  critical: '#e5534b',
  high: '#f0883e',
  medium: '#d4a72c',
  low: '#8c959f',
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? ''
}

/**
 * Which company this folder belongs to: a project workspace at or above the folder first,
 * then a company or project whose name is the folder's name.
 */
export function detectCompany(
  cwd: string,
  companies: readonly Company[],
  projects: ReadonlyMap<string, readonly ProjectSummary[]>,
): { company: Company; reason: string } | undefined {
  const folder = cwd.replace(/\/+$/, '')
  let best: { company: Company; length: number; project: string } | undefined
  for (const company of companies) {
    for (const project of projects.get(company.id) ?? []) {
      for (const root of project.folders) {
        const clean = root.replace(/\/+$/, '')
        const isInside = folder === clean || folder.startsWith(`${clean}/`)
        if (isInside && (!best || clean.length > best.length)) best = { company, length: clean.length, project: project.name }
      }
    }
  }
  if (best) return { company: best.company, reason: `this folder is in project ${best.project}` }
  const name = normalize(basename(folder))
  if (name === '') return undefined
  const byName = companies.find(one => normalize(one.name) === name || normalize(one.prefix) === name)
  if (byName) return { company: byName, reason: 'it has this folder’s name' }
  for (const company of companies) {
    const project = (projects.get(company.id) ?? []).find(one => normalize(one.name) === name)
    if (project) return { company, reason: `project ${project.name} has this folder’s name` }
  }
  return undefined
}

function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function startOfWeek(now: Date): Date {
  const day = startOfDay(now)
  const sinceMonday = (day.getDay() + 6) % 7
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - sinceMonday)
}

export function doneCounts(done: readonly IssueSummary[], now: Date): { today: number; week: number } {
  const today = startOfDay(now).getTime()
  const week = startOfWeek(now).getTime()
  let todayCount = 0
  let weekCount = 0
  for (const issue of done) {
    const at = Date.parse(issue.completedAt ?? '')
    if (Number.isNaN(at)) continue
    if (at >= today) todayCount += 1
    if (at >= week) weekCount += 1
  }
  return { today: todayCount, week: weekCount }
}

export function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return 'never'
  const ms = now.getTime() - Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d ago` : iso.slice(0, 10)
}

/**
 * The next issue worth starting: unassigned or idle todo work first, by priority, oldest first;
 * then backlog. Blocked, in-review and running issues are left out.
 */
export function suggestNext(
  issues: readonly IssueSummary[],
  now: Date,
): { issue: IssueSummary; reason: string } | undefined {
  const rank = (priority: string) => {
    const at = PRIORITY_ORDER.indexOf(priority)
    return at === -1 ? PRIORITY_ORDER.length : at
  }
  for (const status of ['todo', 'backlog']) {
    const pool = issues
      .filter(one => one.status === status && !one.hasActiveRun)
      .sort((a, b) => rank(a.priority) - rank(b.priority) || a.createdAt.localeCompare(b.createdAt))
    const issue = pool[0]
    if (issue) {
      const waiting = relativeTime(issue.createdAt, now).replace(' ago', '')
      return {
        issue,
        reason: `Highest-priority ${statusLabel(status)} issue${pool.length > 1 ? ` of ${pool.length}` : ''}, ${issue.priority} priority, open ${waiting}${issue.assigneeAgentId ? '' : ', unassigned'}`,
      }
    }
  }
  return undefined
}

export function agentName(agents: readonly Agent[], id: string | null): string {
  if (!id) return 'Unassigned'
  return agents.find(one => one.id === id)?.name ?? 'Unknown agent'
}

/** The task as a prompt for a coding agent. */
export function dispatchPrompt(issue: IssueDetail, url: string, apiBase: string, tool: 'claude' | 'codex'): string {
  const description = (issue.description ?? '').trim().slice(0, 1800)
  const report =
    tool === 'claude'
      ? 'When a meaningful step lands, post a short progress comment on the issue with mcp__paperclip__comment.'
      : `When a meaningful step lands, post a short progress comment: curl -s -X POST ${apiBase}/api/issues/${issue.identifier}/comments -H 'content-type: application/json' -d '{"body":"..."}'`
  return [
    `Work on Paperclip issue ${issue.identifier}: ${issue.title}`,
    `Status ${statusLabel(issue.status)}, ${issue.priority} priority. Issue page: ${url}`,
    description ? `Description: ${description}` : 'The issue has no description; read the code and ask if the goal is unclear.',
    report,
  ].join('\n\n')
}

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The shell line that starts Codex on the task in the folder. */
export function codexLine(cwd: string, prompt: string): string {
  return `cd ${shellQuote(cwd)} && codex ${shellQuote(prompt.replace(/\s*\n\s*/g, ' '))}`
}

/** Opens a new Terminal window running the line (macOS). */
export function terminalArgv(line: string): string[] {
  return ['osascript', '-e', `tell application "Terminal" to do script ${appleScriptString(line)}`, '-e', 'tell application "Terminal" to activate']
}
