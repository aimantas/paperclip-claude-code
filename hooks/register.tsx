import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Agent,
  Board,
  Company,
  Confirm,
  Dashboard,
  Detail,
  IssueDetail,
  IssueSummary,
  Notice,
  OrgNode,
  ProjectSummary,
  RunSummary,
  Tab,
} from '../types'
import {
  ISSUE_COLORS,
  PRIORITY_COLORS,
  agentName,
  codexLine,
  detectCompany,
  dispatchPrompt,
  doneCounts,
  relativeTime,
  suggestNext,
  terminalArgv,
} from './insights'
import {
  HELP,
  OPEN_STATUSES,
  PaperclipClient,
  describeIssue,
  isIdentifier,
  issueUrl,
  parseCommand,
  pinnedSection,
  resolveCompany,
  statusLabel,
} from './paperclip'
import { activitySvg, adapterLabel, agentSubtitle, clip, countNodes, money, orgText, sparkline, spendLine, statusColor } from './visuals'

const PANE = 'paperclip'
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'org', label: 'Org chart' },
  { id: 'issues', label: 'Issues' },
]
const TONES = { success: '#2da44e', error: '#e5534b', info: '#3b82f6' } as const
const HOVER = 'rgba(127,127,127,0.14)'
const GREY = '#8c959f'

const EMPTY_BOARD: Board = { state: 'idle', companies: [], issues: [], done: [], org: [], agents: [], projects: [] }
const board = atom({ plugin: 'paperclip', key: 'board' } as const, EMPTY_BOARD)
const pinned = atom({ plugin: 'paperclip', key: 'pinned' } as const, null)
const tab = atom({ plugin: 'paperclip', key: 'tab' } as const, 'overview' as Tab)
const detail = atom({ plugin: 'paperclip', key: 'detail' } as const, null as Detail)
const issueDetail = atom({ plugin: 'paperclip', key: 'issueDetail' } as const, null as IssueDetail | null)
const agentRuns = atom({ plugin: 'paperclip', key: 'agentRuns' } as const, [] as RunSummary[])
const query = atom({ plugin: 'paperclip', key: 'query' } as const, '')
const notice = atom({ plugin: 'paperclip', key: 'notice' } as const, null as Notice)
const confirm = atom({ plugin: 'paperclip', key: 'confirm' } as const, null as Confirm)
const dispatchAgent = atom({ plugin: 'paperclip', key: 'dispatchAgent' } as const, '')

type $ = EngineInterface

const config = {
  baseUrl: 'http://127.0.0.1:3100',
  apiKey: '',
  company: '',
  refreshSeconds: 60,
  cwd: '',
  pinKey: 'pinned',
}
let projectIndex: { key: string; projects: Map<string, ProjectSummary[]> } | null = null

function base() {
  return config.baseUrl.replace(/\/+$/, '')
}

function companyUrl(company: Company | undefined, path: string) {
  return company ? `${base()}/${company.prefix}/${path}` : base()
}

function client($: $) {
  return new PaperclipClient((url, init) => $.http.fetch(url, init), config)
}

async function showStatus($: $) {
  const pin = await read($, pinned)
  const current = await read($, board)
  if (pin) $.ui.status(`${pin.identifier} · ${statusLabel(pin.status)}`)
  else if (current.state === 'error') $.ui.status('Paperclip offline')
  else if (current.company) $.ui.status(`${current.company.prefix} · ${current.issues.length} open`)
  else $.ui.status(undefined)
}

async function say($: $, text: string, tone: 'success' | 'error' | 'info') {
  await update($, notice, () => ({ text, tone }))
}

/** Picks the company: chosen for this folder, settings, matched to the folder, last used, the only one. */
async function chooseActive($: $, companies: Company[]): Promise<{ company?: Company; source?: string }> {
  const byId = (id: unknown) => (typeof id === 'string' ? companies.find(one => one.id === id) : undefined)
  const chosen = byId(await $.store.get(`company:${config.cwd}`))
  if (chosen) return { company: chosen, source: 'chosen for this folder' }
  const configured = config.company ? resolveCompany(companies, config.company) : undefined
  if (configured) return { company: configured, source: 'from settings' }
  if (config.cwd) {
    const key = companies.map(one => one.id).join(',')
    if (projectIndex?.key !== key) {
      const api = client($)
      const lists = await Promise.all(companies.map(one => api.projects(one.id).catch(() => [])))
      projectIndex = { key, projects: new Map(companies.map((one, i) => [one.id, lists[i] ?? []])) }
    }
    const detected = detectCompany(config.cwd, companies, projectIndex.projects)
    if (detected) return { company: detected.company, source: `matched: ${detected.reason}` }
  }
  const last = byId(await $.store.get('company'))
  if (last) return { company: last, source: 'last used' }
  if (companies.length === 1) return { company: companies[0], source: 'only company' }
  return {}
}

async function refresh($: $) {
  await update($, board, (current): Board => ({ ...current, state: 'loading' }))
  try {
    const api = client($)
    const companies = await api.companies()
    const { company, source } = await chooseActive($, companies)
    let issues: IssueSummary[] = []
    let done: IssueSummary[] = []
    let structure: { tree: OrgNode[]; agents: Agent[] } = { tree: [], agents: [] }
    let dashboard: Dashboard | undefined
    let projects: ProjectSummary[] = []
    if (company) {
      // Open issues are required; the rest is extra detail an older Paperclip may not serve.
      ;[issues, done, structure, dashboard, projects] = await Promise.all([
        api.openIssues(company.id),
        api.doneIssues(company.id).catch(() => []),
        api.org(company.id).catch(() => ({ tree: [], agents: [] })),
        api.dashboard(company.id).catch(() => undefined),
        api.projects(company.id).catch(() => []),
      ])
    }
    const refreshedAt = new Date(await $.clock.now()).toISOString()
    const next: Board = {
      state: 'ready',
      companies,
      company,
      companySource: source,
      issues,
      done,
      org: structure.tree,
      agents: structure.agents,
      dashboard,
      projects,
      refreshedAt,
    }
    await update($, board, () => next)
    const pin = await read($, pinned)
    const fresh = pin && issues.find(one => one.identifier === pin.identifier)
    if (fresh) await setPinned($, fresh)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, board, (current): Board => ({ ...current, state: 'error', message }))
  }
  await showStatus($)
}

async function chooseCompany($: $, companyId: string) {
  await $.store.set(`company:${config.cwd}`, companyId)
  await $.store.set('company', companyId)
  await update($, detail, () => null)
  await update($, confirm, () => null)
  await refresh($)
}

async function setPinned($: $, issue: IssueSummary | null) {
  await update($, pinned, () => issue)
  if (issue) await $.store.set(config.pinKey, issue)
  else await $.store.delete(config.pinKey)
  await showStatus($)
}

async function pinIssue($: $, identifier: string) {
  const found = await client($).issue(identifier)
  const { description: _description, comments: _comments, ...summary } = found
  await setPinned($, summary)
  return found
}

async function pinnedOrGiven($: $, given: unknown): Promise<string> {
  if (typeof given === 'string' && isIdentifier(given)) return given.toUpperCase()
  const pin = await read($, pinned)
  if (pin) return pin.identifier
  throw new Error('No issue given and none is pinned. Pass an identifier such as AIM-12.')
}

async function restore($: $, isWaiting: boolean) {
  const saved = await $.store.get(config.pinKey)
  if (saved && typeof saved === 'object') await update($, pinned, () => saved as IssueSummary)
  if (isWaiting) await refresh($)
  else void refresh($)
}

async function openPane($: $, next: Tab) {
  await update($, tab, () => next)
  await update($, detail, () => null)
  await $.ui.open({ id: PANE, title: 'Paperclip' })
  await refresh($)
}

async function openIssue($: $, identifier: string) {
  await update($, detail, (): Detail => ({ kind: 'issue', identifier }))
  await update($, issueDetail, () => null)
  await update($, confirm, () => null)
  try {
    const found = await client($).issue(identifier, 3)
    await update($, issueDetail, () => found)
    const current = await read($, board)
    const preferred =
      found.assigneeAgentId ??
      current.agents.find(one => one.status !== 'paused' && !one.reportsTo)?.id ??
      current.agents[0]?.id ??
      ''
    await update($, dispatchAgent, () => preferred)
  } catch (error) {
    await say($, error instanceof Error ? error.message : String(error), 'error')
  }
}

async function openAgent($: $, id: string) {
  await update($, detail, (): Detail => ({ kind: 'agent', id }))
  await update($, agentRuns, () => [])
  const current = await read($, board)
  if (!current.company) return
  try {
    const runs = await client($).agentRuns(current.company.id, id)
    await update($, agentRuns, () => runs)
  } catch {
    // Runs are a nicety: the agent view still shows without them.
  }
}

async function goBack($: $) {
  await update($, detail, () => null)
  await update($, confirm, () => null)
}

async function openUrl($: $, url: string) {
  for (const argv of [['open', url], ['xdg-open', url]]) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 10000 })
      if (ran.exitCode === 0) return
    } catch {
      // Try the next opener.
    }
  }
  await $.ui.copy({ text: url })
  await say($, `Could not open a browser here. Copied ${url}`, 'info')
}

async function sendToClaude($: $, identifier: string) {
  const current = await read($, board)
  const found = await pinIssue($, identifier)
  const url = current.company ? issueUrl(config.baseUrl, current.company, identifier) : base()
  await $.prompt.submit({ text: dispatchPrompt(found, url, base(), 'claude') })
  await say($, `Sent ${identifier} to Claude Code in this session and pinned it. It starts when Claude is free.`, 'success')
}

async function sendToCodex($: $, identifier: string) {
  const current = await read($, board)
  const found = await client($).issue(identifier, 3)
  const url = current.company ? issueUrl(config.baseUrl, current.company, identifier) : base()
  const line = codexLine(config.cwd || '.', dispatchPrompt(found, url, base(), 'codex'))
  try {
    const ran = await $.process.run(terminalArgv(line), { timeoutMs: 15000 })
    if (ran.exitCode !== 0) throw new Error(ran.stderr)
    await say($, `Opened Codex on ${identifier} in a new Terminal window.`, 'success')
  } catch {
    await $.ui.copy({ text: line })
    await say($, `Could not open Terminal. Copied the Codex command for ${identifier}; paste it in a shell.`, 'info')
  }
}

async function askDispatch($: $, identifier: string) {
  const agentId = await read($, dispatchAgent)
  if (!agentId) {
    await say($, 'Choose an agent first.', 'error')
    return
  }
  await update($, confirm, () => ({ identifier, agentId }))
}

async function confirmDispatch($: $) {
  const pending = await read($, confirm)
  if (!pending) return
  await update($, confirm, () => null)
  const current = await read($, board)
  const name = agentName(current.agents, pending.agentId)
  try {
    const result = await client($).dispatch(pending.identifier, pending.agentId)
    await say(
      $,
      result.isStarted
        ? `Assigned ${pending.identifier} to ${name} and woke the agent (${result.detail}).`
        : `Assigned ${pending.identifier} to ${name}, but no run started: ${result.detail}.`,
      result.isStarted ? 'success' : 'info',
    )
  } catch (error) {
    await say($, `Dispatch failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
  await refresh($)
  const open = await read($, detail)
  if (open?.kind === 'issue') await openIssue($, open.identifier)
}

function companySummary(current: Board, now: Date): string {
  if (!current.company) return 'No Paperclip company is chosen.'
  const lines = [`${current.company.name} (${current.company.prefix})`]
  const counts = (status: string) => current.issues.filter(one => one.status === status).length
  const done = doneCounts(current.done, now)
  lines.push(
    `Issues: ${current.issues.length} open (${counts('in_progress')} in progress, ${counts('in_review')} in review, ${counts('blocked')} blocked); ${done.today} done today, ${done.week} this week.`,
  )
  const next = suggestNext(current.issues, now)
  if (next) lines.push(`Suggested next: ${next.issue.identifier} ${next.issue.title} (${next.reason}).`)
  const d = current.dashboard
  if (d) {
    lines.push(
      `Agents: ${d.agents.running} running, ${d.agents.active} active, ${d.agents.paused} paused, ${d.agents.error} in error.`,
      `Spend this month: ${money(d.costs.monthSpendCents)} (${spendLine(d.costs)}). Pending approvals: ${d.pendingApprovals}.`,
      `Runs in the last 14 days: ${d.runActivity.reduce((sum, day) => sum + day.total, 0)}.`,
    )
  }
  if (current.projects.length) lines.push(`Projects: ${current.projects.map(p => `${p.name} (${p.status})`).join('; ')}.`)
  lines.push('', 'Org chart:', ...orgText(current.org, current.company.name))
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  config.baseUrl = String(options.baseUrl || 'http://127.0.0.1:3100')
  config.apiKey = String(options.apiKey ?? '')
  config.company = String(options.company ?? '')
  config.refreshSeconds = Number(options.refreshSeconds ?? 60)

  on('session.start', async ($, e, next) => {
    config.cwd = await $.session.cwd()
    config.pinKey = `pinned:${config.cwd}`
    await $.command.register({
      name: 'paperclip',
      description: 'Paperclip: company overview, org chart and issues; send an issue to Claude Code, Codex or an agent',
      argumentHint: '[org | issues | ISSUE-ID | comment <text> | status <status> | unpin]',
    })
    await $.tool.register({
      name: 'show',
      description:
        'Open the Paperclip pane in Claude Code so the person can see it: the company overview, the org chart of its agents, the issue list, or one issue. Use it when they ask to see the board, the team, the org chart or an issue.',
      inputSchema: {
        type: 'object',
        properties: {
          tab: { type: 'string', enum: ['overview', 'org', 'issues'], description: 'Which tab to show.' },
          company: { type: 'string', description: 'Switch to this company first: its issue prefix, name or id.' },
          issue: { type: 'string', description: 'Open this issue, e.g. AIM-12.' },
        },
      },
    })
    await $.tool.register({
      name: 'company',
      description:
        "Summarise the Paperclip company this session uses: issue counts, done today and this week, the suggested next issue, agents by state, this month's spend against budget, run activity, projects, and the org chart (who reports to whom).",
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'issues',
      description:
        'List the open Paperclip issues (in progress, in review, blocked, todo, backlog) of the company this session uses: identifier, title, status and priority.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: [...OPEN_STATUSES], description: 'Only issues with this status.' },
        },
      },
    })
    await $.tool.register({
      name: 'issue',
      description:
        'Read one Paperclip issue: title, status, priority, description and the latest comments. Without an identifier it reads the issue pinned to this session.',
      inputSchema: {
        type: 'object',
        properties: { identifier: { type: 'string', description: 'Issue identifier, e.g. AIM-12.' } },
      },
    })
    await $.tool.register({
      name: 'comment',
      description:
        'Post a comment on a Paperclip issue. Everyone on the board sees it. Use it for short progress notes on the pinned issue. Without an identifier it comments on the pinned issue.',
      inputSchema: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: 'Issue identifier, e.g. AIM-12.' },
          body: { type: 'string', description: 'The comment, in Markdown.' },
        },
        required: ['body'],
      },
    })

    await restore($, false)
    if (config.refreshSeconds > 0) $.clock.every(config.refreshSeconds * 1000, () => void refresh($))

    return next(e)
  })

  // A /clear starts a new session id with empty state and no session.start: restore the pin.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await restore($, true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'paperclip' }, async ($, e) => {
    const command = parseCommand(e.args)
    try {
      switch (command.kind) {
        case 'open': {
          await openPane($, command.tab)
          const current = await read($, board)
          if (current.state === 'error') return { text: current.message ?? 'Paperclip is not reachable.' }
          if (!current.company) return { text: 'Pick a company in the Paperclip pane.' }
          const agents = countNodes(current.org)
          return {
            text: `${current.company.name}: ${current.issues.length} open issues, ${agents} ${agents === 1 ? 'agent' : 'agents'}.`,
          }
        }
        case 'refresh': {
          await refresh($)
          const current = await read($, board)
          return { text: current.state === 'error' ? current.message ?? 'Refresh failed.' : 'Board refreshed.' }
        }
        case 'pin': {
          const found = await pinIssue($, command.identifier)
          return {
            text: `Pinned ${found.identifier}: ${found.title} (${statusLabel(found.status)}).`,
            context: [describeIssue(found)],
          }
        }
        case 'unpin': {
          const pin = await read($, pinned)
          await setPinned($, null)
          return { text: pin ? `Unpinned ${pin.identifier}.` : 'No issue was pinned.' }
        }
        case 'comment': {
          const identifier = await pinnedOrGiven($, undefined)
          await client($).comment(identifier, command.body)
          return { text: `Commented on ${identifier}.` }
        }
        case 'status': {
          const identifier = await pinnedOrGiven($, undefined)
          const updated = await client($).setStatus(identifier, command.status)
          const pin = await read($, pinned)
          if (pin?.identifier === identifier) await setPinned($, { ...pin, status: updated.status })
          return { text: `${identifier} is now ${statusLabel(updated.status)}.` }
        }
        case 'help':
          return { text: [command.reason, HELP].filter(Boolean).join('\n\n') }
      }
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error) }
    }
  })

  on('tool.call', { tool: 'mcp__paperclip__show' }, async ($, e) => {
    const wanted = e.tab === 'org' || e.tab === 'issues' ? e.tab : 'overview'
    if (typeof e.company === 'string' && e.company.trim() !== '') {
      const companies = await client($).companies()
      const match = resolveCompany(companies, e.company)
      if (!match) return { deny: `No Paperclip company matches "${e.company}". Companies: ${companies.map(one => one.prefix).join(', ')}.` }
      await $.store.set(`company:${config.cwd}`, match.id)
    }
    const issue = typeof e.issue === 'string' && isIdentifier(e.issue) ? e.issue.toUpperCase() : undefined
    await openPane($, issue ? 'issues' : wanted)
    const current = await read($, board)
    if (current.state === 'error') return { deny: current.message ?? 'Paperclip is not reachable.' }
    if (issue) {
      await openIssue($, issue)
      return { result: `Opened ${issue} in the Paperclip pane.` }
    }
    const where = wanted === 'org' ? 'the org chart' : wanted
    return { result: `Opened the Paperclip pane on ${where}${current.company ? ` for ${current.company.name}` : ''}.` }
  }).catch(() => ({ deny: 'The Paperclip mod could not open its pane.' }))

  on('tool.call', { tool: 'mcp__paperclip__company' }, async $ => {
    await refresh($)
    const current = await read($, board)
    if (current.state === 'error') return { deny: current.message ?? 'Paperclip is not reachable.' }
    return { result: companySummary(current, new Date(await $.clock.now())) }
  }).catch(() => ({ deny: 'The Paperclip mod could not answer this call.' }))

  on('tool.call', { tool: 'mcp__paperclip__issues' }, async ($, e) => {
    await refresh($)
    const current = await read($, board)
    if (current.state === 'error') return { deny: current.message ?? 'Paperclip is not reachable.' }
    if (!current.company) return { deny: 'No Paperclip company is chosen. Ask the person to pick one with /paperclip.' }
    const wanted = typeof e.status === 'string' ? e.status : undefined
    const issues = wanted ? current.issues.filter(one => one.status === wanted) : current.issues
    const text = issues.length
      ? issues.map(one => `${one.identifier} [${one.status}, ${one.priority}] ${one.title}`).join('\n')
      : 'No matching open issues.'
    return { result: `${current.company.name}: ${issues.length} open issues\n${text}` }
  }).catch(() => ({ deny: 'The Paperclip mod could not answer this call.' }))

  on('tool.call', { tool: 'mcp__paperclip__issue' }, async ($, e) => {
    try {
      const found = await client($).issue(await pinnedOrGiven($, e.identifier))
      return { result: describeIssue(found) }
    } catch (error) {
      return { deny: error instanceof Error ? error.message : String(error) }
    }
  }).catch(() => ({ deny: 'The Paperclip mod could not answer this call.' }))

  on('tool.call', { tool: 'mcp__paperclip__comment' }, async ($, e) => {
    try {
      const body = typeof e.body === 'string' ? e.body.trim() : ''
      if (body === '') throw new Error('The comment body is empty.')
      const identifier = await pinnedOrGiven($, e.identifier)
      await client($).comment(identifier, body)
      return { result: `Commented on ${identifier}.` }
    } catch (error) {
      return { deny: error instanceof Error ? error.message : String(error) }
    }
  }).catch(() => ({ deny: 'The Paperclip mod could not answer this call.' }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const pin = await read($, pinned)
    if (!pin) return composed
    const { company } = await read($, board)
    const section = { id: 'paperclip:pinned', text: pinnedSection(pin, company), scope: 'session' as const }
    return { sections: [...composed.sections, section] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    const current = await read($, board)
    const pin = await read($, pinned)
    const active = await read($, tab)
    const open = await read($, detail)
    const message = await read($, notice)
    const pending = await read($, confirm)
    const now = new Date(await $.clock.now())
    // Every surface but the terminal draws Svg; the runtime table is not a reliable signal.
    const isRich = e.surface !== 'terminal' && 'Svg' in ui
    const hasInput = e.surface !== 'mobile' && 'Input' in ui
    const hasSelect = e.surface !== 'mobile' && 'Select' in ui
    const columns = Math.max(28, e.props.bodyColumns)
    const fit = (text: string, room: number) => (isRich ? text : clip(text, Math.max(10, room)))
    const company = current.company
    const counts = (status: string) => current.issues.filter(one => one.status === status).length
    const done = doneCounts(current.done, now)
    const hover = isRich ? { backgroundColor: HOVER } : undefined

    // Shared pieces --------------------------------------------------------

    const issueRow = (issue: IssueSummary, prefix: string, extra?: string) => (
      <Box key={`${prefix}-row-${issue.identifier}`} hover={hover}>
        <Button key={`${prefix}-${issue.identifier}`} plain onPress={() => openIssue($, issue.identifier)}>
          <Text color={PRIORITY_COLORS[issue.priority] ?? GREY}>●</Text> <Text dimColor>{issue.identifier}</Text>{' '}
          {fit(issue.title, columns - issue.identifier.length - 6 - (extra?.length ?? 0))}
          {extra ? <Text dimColor> · {extra}</Text> : ''}
        </Button>
      </Box>
    )

    const agentRow = (agent: Agent, prefix: string, extra: string) => (
      <Box key={`${prefix}-row-${agent.id}`} hover={hover}>
        <Button key={`${prefix}-${agent.id}`} plain onPress={() => openAgent($, agent.id)}>
          <Text color={statusColor(agent.status)}>●</Text> {agent.name}
          <Text dimColor> · {extra}</Text>
        </Button>
      </Box>
    )

    const section = (key: string, title: string, content: JSX.Element, hint?: string) => (
      <Box key={key} flexDirection="column" marginTop={1}>
        <Text size="heading" weight="semibold">
          {title}
          {hint ? <Text dimColor size="caption"> {hint}</Text> : ''}
        </Text>
        {content}
      </Box>
    )

    const tile = (key: string, label: string, value: string | number, color: string, hint?: string) =>
      isRich ? (
        <Box key={key} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} flexGrow={1} minWidth={15}>
          <Text dimColor size="caption">
            {label}
          </Text>
          <Text size="title" weight="bold" color={color}>
            {String(value)}
          </Text>
          {hint ? (
            <Text dimColor size="caption">
              {hint}
            </Text>
          ) : null}
        </Box>
      ) : (
        <Text key={key}>
          <Text color={color}>●</Text> <Text dimColor>{label.padEnd(16)}</Text>
          <Text weight="bold" color={color}>
            {String(value)}
          </Text>
          {hint ? <Text dimColor> {hint}</Text> : ''}
        </Text>
      )

    const workButtons = (identifier: string, prefix: string) => (
      <Box key={`${prefix}-work`} flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key={`${prefix}-claude`} variant="primary" label="Claude Code" onPress={() => sendToClaude($, identifier)} />
        <Button key={`${prefix}-codex`} label="Codex" onPress={() => sendToCodex($, identifier)} />
        {prefix !== 'detail' && <Button key={`${prefix}-more`} label="Details" onPress={() => openIssue($, identifier)} />}
      </Box>
    )

    // Header, navigation and notices ----------------------------------------

    const header = (
      <Box key="header" flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Text size="title" weight="bold">
            {company ? company.name : 'Paperclip'}
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="open-paperclip" label="Open Paperclip" onPress={() => openUrl($, companyUrl(company, 'dashboard'))} />
            <Button key="refresh" label={current.state === 'loading' ? 'Refreshing…' : 'Refresh'} onPress={() => refresh($)} />
          </Box>
        </Box>
        {company && (
          <Text dimColor size="caption">
            {company.prefix} · {current.companySource ?? 'chosen'}
            {current.refreshedAt ? ` · updated ${relativeTime(current.refreshedAt, now)}` : ''}
          </Text>
        )}
        {current.companies.length > 1 && hasSelect && (
          <Box marginTop={1}>
            <ui.Select
              key="company"
              label="Company"
              value={company?.id}
              options={current.companies.map(one => ({ value: one.id, label: `${one.name} (${one.prefix})` }))}
              onSelect={value => chooseCompany($, value)}
            />
          </Box>
        )}
      </Box>
    )

    const tabs = (
      <Box key="tabs" flexDirection="row" gap={1} marginTop={1}>
        {TABS.map(one => (
          <Button
            key={`tab-${one.id}`}
            label={one.label}
            variant={!open && active === one.id ? 'primary' : 'secondary'}
            onPress={async () => {
              await update($, tab, () => one.id)
              await goBack($)
            }}
          />
        ))}
      </Box>
    )

    const noticeBox = message ? (
      <Box
        key="notice"
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        borderStyle="round"
        borderColor={TONES[message.tone]}
        paddingX={1}
        marginTop={1}
        gap={1}
      >
        <Text color={TONES[message.tone]}>{message.text}</Text>
        <Button key="notice-dismiss" label="Dismiss" plain onPress={() => update($, notice, () => null)} />
      </Box>
    ) : null

    const pinnedCard = pin ? (
      <Box key="pinned" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} marginTop={1}>
        <Text dimColor size="caption">
          Pinned to this session · Claude sees it in every prompt
        </Text>
        <Button key="pinned-open" plain onPress={() => openIssue($, pin.identifier)}>
          <Text weight="bold">{pin.identifier}</Text> {fit(pin.title, columns - pin.identifier.length - 4)}
        </Button>
        <Text dimColor size="caption">
          <Text color={ISSUE_COLORS[pin.status] ?? GREY}>●</Text> {statusLabel(pin.status)} · {pin.priority} priority
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="unpin" label="Unpin" onPress={() => setPinned($, null)} />
          {company && (
            <Button key="pinned-web" label="Open in Paperclip" onPress={() => openUrl($, issueUrl(config.baseUrl, company, pin.identifier))} />
          )}
        </Box>
      </Box>
    ) : null

    // Overview -------------------------------------------------------------

    const overview = (here: Company) => {
      const next = suggestNext(current.issues, now)
      const blocked = current.issues.filter(one => one.status === 'blocked')
      const failing = current.agents.filter(one => one.status === 'error')
      const dash = current.dashboard
      const failedRuns = dash ? dash.runActivity.reduce((sum, day) => sum + day.failed, 0) : 0
      const approvals = dash?.pendingApprovals ?? 0
      const isCalm = blocked.length + failing.length + approvals + failedRuns === 0
      return (
        <Box key="overview" flexDirection="column">
          <Box key="stats" flexDirection={isRich ? 'row' : 'column'} flexWrap="wrap" gap={isRich ? 1 : 0} marginTop={1}>
            {tile('t-progress', 'In progress', counts('in_progress'), ISSUE_COLORS.in_progress ?? GREY)}
            {tile('t-review', 'In review', counts('in_review'), ISSUE_COLORS.in_review ?? GREY)}
            {tile('t-blocked', 'Blocked', counts('blocked'), counts('blocked') ? ISSUE_COLORS.blocked ?? GREY : GREY)}
            {tile('t-today', 'Done today', done.today, ISSUE_COLORS.done ?? GREY)}
            {tile('t-week', 'Done this week', done.week, ISSUE_COLORS.done ?? GREY)}
            {tile('t-open', 'Open', current.issues.length, GREY, `${counts('todo')} todo · ${counts('backlog')} backlog`)}
          </Box>
          {pinnedCard}
          {next &&
            section(
              'next',
              'Suggested next',
              <Box key="next-card" flexDirection="column" borderStyle="round" borderColor="#3b82f6" paddingX={1}>
                <Button key="next-open" plain onPress={() => openIssue($, next.issue.identifier)}>
                  <Text color={PRIORITY_COLORS[next.issue.priority] ?? GREY}>●</Text> <Text weight="bold">{next.issue.identifier}</Text>{' '}
                  {fit(next.issue.title, columns - 12)}
                </Button>
                <Text dimColor size="caption">
                  {next.reason}
                </Text>
                {workButtons(next.issue.identifier, 'next')}
              </Box>,
            )}
          {section(
            'attention',
            'Needs attention',
            isCalm ? (
              <Text key="calm" color={ISSUE_COLORS.done}>
                ✓ Nothing is blocked or failing.
              </Text>
            ) : (
              <Box key="attention-list" flexDirection="column">
                {blocked.map(issue => issueRow(issue, 'blocked', 'blocked'))}
                {failing.map(agent => agentRow(agent, 'failing', 'agent in error'))}
                {approvals > 0 && (
                  <Button key="approvals" plain onPress={() => openUrl($, companyUrl(here, 'approvals'))}>
                    <Text color="#d29922">●</Text> {approvals} {approvals === 1 ? 'approval waits' : 'approvals wait'} for the board{' '}
                    <Text dimColor>· open in Paperclip</Text>
                  </Button>
                )}
                {failedRuns > 0 && (
                  <Text key="failed-runs">
                    <Text color={ISSUE_COLORS.blocked}>●</Text> {failedRuns} failed {failedRuns === 1 ? 'run' : 'runs'} in the last 14 days
                  </Text>
                )}
              </Box>
            ),
          )}
          {dash &&
            section(
              'activity',
              'Agent runs',
              <Box key="activity-body" flexDirection="column">
                {isRich && 'Svg' in ui ? (
                  <ui.Svg source={activitySvg(dash.runActivity, 640)} alt={`Agent runs per day for 14 days: ${sparkline(dash.runActivity)}`} />
                ) : (
                  <Text>{sparkline(dash.runActivity)}</Text>
                )}
                <Text dimColor>
                  {countNodes(current.org)} agents: {dash.agents.running} running · {dash.agents.active} active · {dash.agents.paused} paused
                  {dash.agents.error ? ` · ${dash.agents.error} error` : ''} · {money(dash.costs.monthSpendCents)} spent ({spendLine(dash.costs)})
                </Text>
              </Box>,
              'last 14 days',
            )}
          {current.done.length > 0 &&
            section(
              'recent',
              'Recently done',
              <Box key="recent-list" flexDirection="column">
                {current.done.slice(0, 5).map(issue => issueRow(issue, 'done', relativeTime(issue.completedAt, now)))}
              </Box>,
            )}
        </Box>
      )
    }

    // Org chart --------------------------------------------------------------

    const orgCard = (node: OrgNode, depth: number): JSX.Element => (
      <Box key={`org-${node.id}`} flexDirection="column" marginLeft={depth > 1 ? 3 : 0} marginTop={1}>
        <Box
          key={`org-card-${node.id}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={statusColor(node.status)}
          paddingX={1}
          hover={hover}
        >
          <Button key={`agent-${node.id}`} plain onPress={() => openAgent($, node.id)}>
            <Text color={statusColor(node.status)}>●</Text> <Text weight="bold">{node.name}</Text>
            {node.reports.length ? (
              <Text dimColor>
                {' '}
                · {node.reports.length} {node.reports.length === 1 ? 'report' : 'reports'}
              </Text>
            ) : (
              ''
            )}
          </Button>
          <Text dimColor size="caption">
            {agentSubtitle(node)}
          </Text>
        </Box>
        {node.reports.map(child => orgCard(child, depth + 1))}
      </Box>
    )

    const orgChart = (here: Company) => {
      const dash = current.dashboard
      return (
        <Box key="org" flexDirection="column">
          <Box key="org-board" flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1} marginTop={1}>
            <Text weight="bold">Board · you</Text>
            <Text dimColor size="caption">
              Approves hires, budgets and plans for {here.name}
              {dash ? ` · ${dash.pendingApprovals} pending approvals` : ''}
            </Text>
          </Box>
          {current.org.length === 0 ? (
            <Box key="org-empty" flexDirection="column" marginTop={1} gap={1}>
              <Text dimColor>No agents in this company yet.</Text>
              <Button key="org-hire" label="Hire one in Paperclip" onPress={() => openUrl($, companyUrl(here, 'agents'))} />
            </Box>
          ) : (
            current.org.map(node => orgCard(node, 1))
          )}
          <Box key="legend" flexDirection="row" gap={2} marginTop={1} flexWrap="wrap">
            {['running', 'active', 'idle', 'paused', 'error'].map(status => (
              <Text key={`legend-${status}`} dimColor size="caption">
                <Text color={statusColor(status)}>●</Text> {status}
              </Text>
            ))}
          </Box>
          <Text dimColor size="caption">
            Press an agent for its work and recent runs.
          </Text>
        </Box>
      )
    }

    // Issues -----------------------------------------------------------------

    const issueList = async () => {
      const text = (await read($, query)).trim().toLowerCase()
      const matches = (issue: IssueSummary) =>
        text === '' || issue.identifier.toLowerCase().includes(text) || issue.title.toLowerCase().includes(text)
      const groups = OPEN_STATUSES.map(status => ({
        status,
        issues: current.issues.filter(one => one.status === status && matches(one)),
      })).filter(group => group.issues.length > 0)
      const recent = current.done.filter(matches).slice(0, 8)
      return (
        <Box key="issues" flexDirection="column">
          {hasInput && 'Input' in ui && (
            <Box key="search-box" marginTop={1}>
              <ui.Input
                key="search"
                label="Filter"
                placeholder="Title or ID"
                value={text}
                onInput={value => update($, query, () => value)}
                onSubmit={value => update($, query, () => value)}
              />
            </Box>
          )}
          {pinnedCard}
          {groups.length === 0 && recent.length === 0 && (
            <Text key="no-match" dimColor>
              No issues match.
            </Text>
          )}
          {groups.map(group =>
            section(
              `group-${group.status}`,
              statusLabel(group.status),
              <Box key={`group-list-${group.status}`} flexDirection="column">
                {group.issues.map(issue =>
                  issueRow(issue, 'list', issue.assigneeAgentId ? agentName(current.agents, issue.assigneeAgentId) : undefined),
                )}
              </Box>,
              String(group.issues.length),
            ),
          )}
          {recent.length > 0 &&
            section(
              'group-done',
              'Done',
              <Box key="group-list-done" flexDirection="column">
                {recent.map(issue => issueRow(issue, 'list-done', relativeTime(issue.completedAt, now)))}
              </Box>,
              `${done.today} today · ${done.week} this week`,
            )}
          <Text dimColor size="caption">
            Press an issue to open it, then send it to Claude Code, Codex or a Paperclip agent.
          </Text>
        </Box>
      )
    }

    // Issue detail -----------------------------------------------------------

    const issueView = async (here: Company, identifier: string) => {
      const found = await read($, issueDetail)
      if (!found || found.identifier !== identifier) {
        return (
          <Text key="issue-loading" dimColor>
            Loading {identifier}…
          </Text>
        )
      }
      const chosen = await read($, dispatchAgent)
      const isPinned = pin?.identifier === identifier
      const target = current.agents.find(one => one.id === pending?.agentId)
      const agentPart =
        current.agents.length === 0 ? (
          <Text key="no-agents" dimColor>
            No agents in this company.
          </Text>
        ) : pending && pending.identifier === identifier ? (
          <Box key="confirm" flexDirection="column" borderStyle="round" borderColor="#d29922" paddingX={1}>
            <Text>
              Assign {identifier} to <Text weight="bold">{target?.name ?? 'the agent'}</Text> and wake it now?
            </Text>
            <Text dimColor size="caption">
              {target?.status === 'paused'
                ? `${target.name} is paused: Paperclip assigns the issue but starts no run until the agent is resumed.`
                : 'A run spends from the agent’s budget.'}
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button key="confirm-yes" variant="primary" label="Assign and start" onPress={() => confirmDispatch($)} />
              <Button key="confirm-no" label="Cancel" onPress={() => update($, confirm, () => null)} />
            </Box>
          </Box>
        ) : (
          <Box key="agent-pick" flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
            {hasSelect && 'Select' in ui && (
              <ui.Select
                key="dispatch-agent"
                label="Agent"
                value={chosen || undefined}
                options={current.agents.map(one => ({ value: one.id, label: `${one.name} · ${one.status}` }))}
                onSelect={value => update($, dispatchAgent, () => value)}
              />
            )}
            <Button key="dispatch" label="Assign and start…" onPress={() => askDispatch($, identifier)} />
          </Box>
        )
      return (
        <Box key="issue-view" flexDirection="column" marginTop={1}>
          <Text dimColor size="caption">
            {identifier} · opened {relativeTime(found.createdAt, now)} · updated {relativeTime(found.updatedAt, now)}
          </Text>
          <Text size="heading" weight="bold">
            {found.title}
          </Text>
          <Text>
            <Text color={ISSUE_COLORS[found.status] ?? GREY}>●</Text> {statusLabel(found.status)}
            {'   '}
            <Text color={PRIORITY_COLORS[found.priority] ?? GREY}>●</Text> {found.priority} priority{'   '}
            <Text dimColor>{agentName(current.agents, found.assigneeAgentId)}</Text>
            {found.hasActiveRun ? <Text color={ISSUE_COLORS.in_progress}> · run in progress</Text> : ''}
          </Text>
          {section('work', 'Work on it', workButtons(identifier, 'detail'), 'sends the issue with its description')}
          {section('agent', 'Paperclip agent', agentPart)}
          <Box key="issue-actions" flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
            <Button
              key="pin-toggle"
              label={isPinned ? 'Unpin from session' : 'Pin to session'}
              onPress={() => (isPinned ? setPinned($, null) : pinIssue($, identifier))}
            />
            <Button key="issue-web" label="Open in Paperclip" onPress={() => openUrl($, issueUrl(config.baseUrl, here, identifier))} />
          </Box>
          {section('description', 'Description', <Markdown key="description-text" text={found.description?.trim() || '_No description._'} />)}
          {found.comments.length > 0 &&
            section(
              'comments',
              'Latest comments',
              <Box key="comment-list" flexDirection="column">
                {found.comments.map((comment, index) => (
                  <Box key={`comment-${index}`} flexDirection="column" marginTop={1}>
                    <Text dimColor size="caption">
                      {comment.agentId ? agentName(current.agents, comment.agentId) : comment.author === 'user' ? 'Board' : comment.author} ·{' '}
                      {relativeTime(comment.createdAt, now)}
                    </Text>
                    <Markdown key={`comment-text-${index}`} text={comment.body.trim().slice(0, 1500)} />
                  </Box>
                ))}
              </Box>,
            )}
        </Box>
      )
    }

    // Agent detail -----------------------------------------------------------

    const agentView = async (here: Company, id: string) => {
      const agent = current.agents.find(one => one.id === id)
      if (!agent) {
        return (
          <Text key="agent-missing" dimColor>
            This agent is no longer in the company.
          </Text>
        )
      }
      const runs = await read($, agentRuns)
      const boss = current.agents.find(one => one.id === agent.reportsTo)
      const team = current.agents.filter(one => one.reportsTo === agent.id)
      const work = current.issues.filter(one => one.assigneeAgentId === agent.id)
      const budget = agent.budgetMonthlyCents > 0 ? ` of ${money(agent.budgetMonthlyCents)}` : ''
      return (
        <Box key="agent-view" flexDirection="column" marginTop={1}>
          <Text size="heading" weight="bold">
            <Text color={statusColor(agent.status)}>●</Text> {agent.name}
          </Text>
          <Text dimColor>{agentSubtitle({ ...agent, reports: [] })}</Text>
          <Box key="agent-stats" flexDirection={isRich ? 'row' : 'column'} flexWrap="wrap" gap={isRich ? 1 : 0} marginTop={1}>
            {tile('a-work', 'Open issues', work.length, ISSUE_COLORS.in_progress ?? GREY)}
            {tile('a-spend', 'Spent this month', `${money(agent.spentMonthlyCents)}${budget}`, GREY)}
            {tile('a-beat', 'Last heartbeat', relativeTime(agent.lastHeartbeatAt, now), statusColor(agent.status))}
          </Box>
          {section(
            'agent-team',
            'Team',
            <Box key="team-list" flexDirection="column">
              {boss ? (
                agentRow(boss, 'boss', `manager · ${boss.status}`)
              ) : (
                <Text key="no-boss" dimColor>
                  Reports to the board
                </Text>
              )}
              {team.map(one => agentRow(one, 'team', `reports to ${agent.name} · ${one.status}`))}
            </Box>,
          )}
          {section(
            'agent-work',
            'Assigned issues',
            work.length === 0 ? (
              <Text key="no-work" dimColor>
                Nothing assigned.
              </Text>
            ) : (
              <Box key="work-list" flexDirection="column">
                {work.map(issue => issueRow(issue, 'work', statusLabel(issue.status)))}
              </Box>
            ),
          )}
          {section(
            'agent-runs',
            'Recent runs',
            runs.length === 0 ? (
              <Text key="no-runs" dimColor>
                No runs yet.
              </Text>
            ) : (
              <Box key="run-list" flexDirection="column">
                {runs.map(run => {
                  const seconds =
                    run.startedAt && run.finishedAt ? Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000) : null
                  const color =
                    run.status === 'succeeded' ? ISSUE_COLORS.done : run.status === 'failed' ? ISSUE_COLORS.blocked : ISSUE_COLORS.in_progress
                  const length = seconds === null ? '' : ` · ${seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`}`
                  return (
                    <Text key={`run-${run.id}`}>
                      <Text color={color}>●</Text> {run.status}{' '}
                      <Text dimColor>
                        · {run.source.replace(/_/g, ' ')} · {relativeTime(run.startedAt, now)}
                        {length}
                        {run.error ? ` · ${clip(run.error, 60)}` : ''}
                      </Text>
                    </Text>
                  )
                })}
              </Box>
            ),
          )}
          <Box key="agent-actions" flexDirection="row" gap={1} marginTop={1} alignItems="center">
            <Button key="agent-web" label="Open in Paperclip" onPress={() => openUrl($, companyUrl(here, `agents/${agent.urlKey}`))} />
            <Text dimColor size="caption">
              Runs on {adapterLabel(agent.adapterType) || 'an unknown adapter'}
            </Text>
          </Box>
        </Box>
      )
    }

    // Assembly ---------------------------------------------------------------

    let body: JSX.Element | null
    if (current.state === 'error') {
      body = (
        <Box key="error" flexDirection="column" marginTop={1}>
          <Text color="error">{current.message}</Text>
          <Text dimColor>Check that Paperclip is running, or change its URL with /config.</Text>
        </Box>
      )
    } else if (!company) {
      body = (
        <Text key="none" dimColor>
          {current.state === 'ready' ? 'Pick a company above, or set one with /config.' : 'Loading Paperclip…'}
        </Text>
      )
    } else if (open?.kind === 'issue') {
      body = await issueView(company, open.identifier)
    } else if (open?.kind === 'agent') {
      body = await agentView(company, open.id)
    } else if (active === 'org') {
      body = orgChart(company)
    } else if (active === 'issues') {
      body = await issueList()
    } else {
      body = overview(company)
    }

    const crumbs = open ? (
      <Box key="crumbs" flexDirection="row" gap={1} alignItems="center" marginTop={1}>
        <Button key="back" label="← Back" onPress={() => goBack($)} />
        <Text dimColor>
          {TABS.find(one => one.id === active)?.label} › {open.kind === 'issue' ? open.identifier : agentName(current.agents, open.id)}
        </Text>
      </Box>
    ) : null

    return (
      <Box flexDirection="column">
        {header}
        {company && tabs}
        {noticeBox}
        {crumbs}
        {body}
      </Box>
    )
  })
}
