import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { IssueSummary, OrgNode } from '../types'
import { codexLine, detectCompany, dispatchPrompt, doneCounts, suggestNext, terminalArgv } from '../hooks/insights'
import { parseCommand, resolveCompany, sortIssues } from '../hooks/paperclip'
import { activitySvg, orgText, sparkline } from '../hooks/visuals'

const NOW = Date.parse('2026-10-18T12:00:00Z')
const COMPANY = { id: 'c1', name: 'Acme', issuePrefix: 'ACM', status: 'active' }
const ISSUES = [
  { id: 'i1', identifier: 'ACM-1', title: 'Write the launch post', status: 'todo', priority: 'low', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
  { id: 'i2', identifier: 'ACM-2', title: 'Fix the checkout bug', status: 'in_progress', priority: 'high', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', assigneeAgentId: 'a2' },
  { id: 'i3', identifier: 'ACM-3', title: 'Add CSV export', status: 'todo', priority: 'high', createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' },
  { id: 'i4', identifier: 'ACM-4', title: 'Rate-limit search', status: 'blocked', priority: 'medium', createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' },
]
const DONE = [
  { id: 'd1', identifier: 'ACM-9', title: 'Ship pricing page', status: 'done', priority: 'medium', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-18T09:00:00Z', completedAt: '2026-10-18T09:00:00Z' },
  { id: 'd2', identifier: 'ACM-8', title: 'Fix login', status: 'done', priority: 'high', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-13T09:00:00Z', completedAt: '2026-10-13T09:00:00Z' },
  { id: 'd3', identifier: 'ACM-7', title: 'Old work', status: 'done', priority: 'low', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-01T09:00:00Z', completedAt: '2026-10-01T09:00:00Z' },
]
const ORG = [
  { id: 'a1', name: 'Ada', role: 'ceo', status: 'running', reports: [{ id: 'a2', name: 'Linus', role: 'engineer', status: 'paused', reports: [] }] },
]
const AGENTS = [
  { id: 'a1', name: 'Ada', role: 'ceo', title: 'CEO', adapterType: 'claude_local', status: 'running', reportsTo: null, lastHeartbeatAt: '2026-10-18T11:00:00Z', spentMonthlyCents: 900, budgetMonthlyCents: 5000, urlKey: 'ada' },
  { id: 'a2', name: 'Linus', role: 'engineer', title: 'Founding engineer', adapterType: 'codex_local', status: 'paused', reportsTo: 'a1', lastHeartbeatAt: null, spentMonthlyCents: 0, budgetMonthlyCents: 0, urlKey: 'linus' },
]
const RUNS = [{ id: 'r1', status: 'succeeded', invocationSource: 'assignment', startedAt: '2026-10-18T10:00:00Z', finishedAt: '2026-10-18T10:02:00Z', error: null }]
const DASHBOARD = {
  agents: { active: 0, running: 1, paused: 1, error: 0 },
  tasks: { open: 4, inProgress: 1, blocked: 1, done: 3 },
  costs: { monthSpendCents: 1234, monthBudgetCents: 5000, monthUtilizationPercent: 24.68 },
  pendingApprovals: 1,
  runActivity: Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${String(5 + i).padStart(2, '0')}`, succeeded: i % 3, failed: i === 10 ? 1 : 0, recovered: 0, total: (i % 3) + (i === 10 ? 1 : 0) })),
}
const PANE = { title: 'Paperclip', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const SURFACES = ['terminal', 'desktop'] as const

type Sent = { method: string; url: string; body?: string }
type World = { sent: Sent[]; prompts: string[]; commands: string[][] }

const summary = (raw: Record<string, unknown>): IssueSummary => ({
  id: String(raw.id),
  identifier: String(raw.identifier),
  title: String(raw.title),
  status: String(raw.status),
  priority: String(raw.priority),
  createdAt: String(raw.createdAt),
  updatedAt: String(raw.updatedAt),
  completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
  assigneeAgentId: typeof raw.assigneeAgentId === 'string' ? raw.assigneeAgentId : null,
  hasActiveRun: false,
})

function fakePaperclip(on: On, stored: Record<string, unknown> = {}): World {
  const world: World = { sent: [], prompts: [], commands: [] }
  mock.store(on, stored)
  mock.clock(on, { now: NOW })
  on('classic.SessionStart', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('prompt.submit', ($, e) => {
    world.prompts.push(e.text)
    return { text: e.text }
  })
  on('process.run', ($, e) => {
    world.commands.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', ($, e) => {
    const method = e.init?.method ?? 'GET'
    world.sent.push({ method, url: e.url, body: e.init?.body })
    const url = new URL(e.url)
    const path = url.pathname
    const reply = (data: unknown, status = 200) => ({ value: { status, ok: status < 400, headers: {}, text: JSON.stringify(data) } })
    if (path === '/api/companies') return reply([COMPANY])
    if (path === '/api/companies/c1/issues') return reply(url.searchParams.get('status') === 'done' ? DONE : ISSUES)
    if (path === '/api/companies/c1/org') return reply(ORG)
    if (path === '/api/companies/c1/agents') return reply(AGENTS)
    if (path === '/api/companies/c1/dashboard') return reply(DASHBOARD)
    if (path === '/api/companies/c1/projects') return reply([{ id: 'p1', name: 'Checkout v2', status: 'in_progress', workspaces: [{ cwd: '/work/checkout' }] }])
    if (path === '/api/companies/c1/heartbeat-runs') return reply(RUNS)
    if (path === '/api/issues/ACM-2' && method === 'GET') return reply({ ...ISSUES[1], description: 'Cart total is wrong.' })
    if (path === '/api/issues/ACM-2' && method === 'PATCH') return reply({ ...ISSUES[1], assigneeAgentId: 'a1' })
    if (path === '/api/issues/ACM-2/comments' && method === 'GET') return reply([{ body: 'Looking into it', authorAgentId: 'a2', createdAt: '2026-10-18T10:00:00Z' }])
    if (path === '/api/issues/ACM-2/comments' && method === 'POST') return reply({ id: 'k1' }, 201)
    if (path === '/api/agents/a1/wakeup' && method === 'POST') return reply({ status: 'queued' }, 202)
    return reply({ error: 'not found' }, 404)
  })
  return world
}

test('parses the command arguments', () => {
  expect(parseCommand('')).toEqual({ kind: 'open', tab: 'overview' })
  expect(parseCommand('org')).toEqual({ kind: 'open', tab: 'org' })
  expect(parseCommand('acm-12')).toEqual({ kind: 'pin', identifier: 'ACM-12' })
  expect(parseCommand('comment shipped the fix')).toEqual({ kind: 'comment', body: 'shipped the fix' })
  expect(parseCommand('status in review')).toEqual({ kind: 'status', status: 'in_review' })
  expect(parseCommand('status nope').kind).toBe('help')
})

test('sorts issues and resolves companies', () => {
  expect(sortIssues(ISSUES.map(summary)).map(one => one.identifier)).toEqual(['ACM-2', 'ACM-4', 'ACM-3', 'ACM-1'])
  const companies = [{ id: 'c1', name: 'Acme', prefix: 'ACM' }]
  expect(resolveCompany(companies, 'acm')?.id).toBe('c1')
  expect(resolveCompany([...companies, { id: 'c2', name: 'Beta', prefix: 'BET' }], '')).toBeUndefined()
})

test('picks the company for a folder', () => {
  const companies = [
    { id: 'c1', name: 'Acme', prefix: 'ACM' },
    { id: 'c2', name: 'Beta Labs', prefix: 'BET' },
  ]
  const projects = new Map([
    ['c1', [{ id: 'p1', name: 'Checkout', status: 'active', folders: ['/work/checkout'] }]],
    ['c2', [{ id: 'p2', name: 'Docs site', status: 'active', folders: [] }]],
  ])
  expect(detectCompany('/work/checkout/src', companies, projects)?.company.id).toBe('c1')
  expect(detectCompany('/Users/me/beta-labs', companies, projects)?.company.id).toBe('c2')
  expect(detectCompany('/Users/me/docs-site', companies, projects)?.reason).toBe('project Docs site has this folder’s name')
  expect(detectCompany('/Users/me/elsewhere', companies, projects)).toBeUndefined()
})

test('counts done work and suggests the next issue', () => {
  const now = new Date(NOW)
  expect(doneCounts(DONE.map(summary), now)).toEqual({ today: 1, week: 2 })
  const next = suggestNext(ISSUES.map(summary), now)
  expect(next?.issue.identifier).toBe('ACM-3')
  expect(next?.reason).toContain('Highest-priority todo issue of 2, high priority')
})

test('builds dispatch prompts and the Codex launch', () => {
  const found = { ...summary(ISSUES[1]!), description: "Cart total's wrong.", comments: [] }
  const prompt = dispatchPrompt(found, 'http://pc/ACM/issues/ACM-2', 'http://pc', 'codex')
  expect(prompt).toContain('Work on Paperclip issue ACM-2: Fix the checkout bug')
  expect(prompt).toContain("curl -s -X POST http://pc/api/issues/ACM-2/comments")
  const line = codexLine('/work/my app', prompt)
  expect(line.startsWith("cd '/work/my app' && codex 'Work on")).toBe(true)
  expect(line).toContain("Cart total'\\''s wrong.")
  expect(line.includes('\n')).toBe(false)
  expect(terminalArgv(line)[2]).toContain('tell application "Terminal" to do script "cd ')
})

test('draws charts and text fallbacks', () => {
  const nodes: OrgNode[] = [{ ...AGENTS[0]!, reports: [{ ...AGENTS[1]!, reports: [] }] }]
  expect(orgText(nodes, 'Acme')).toEqual(['Board · Acme', '└─ Ada (CEO · running)', '   └─ Linus (Founding engineer · paused)'])
  const days = [{ date: '2026-10-17', succeeded: 0, failed: 0, total: 0 }, { date: '2026-10-18', succeeded: 3, failed: 1, total: 4 }]
  expect(activitySvg(days, 300)).toContain('4 in 14 days · 1 failed')
  expect(sparkline(days)).toBe('▁█')
})

test('summarises the company for the model', async ($, on) => {
  fakePaperclip(on)
  const result = await $.tool.call({ tool: 'mcp__paperclip__company' })
  expect(result.result).toContain('Issues: 4 open (1 in progress, 0 in review, 1 blocked); 1 done today, 2 this week.')
  expect(result.result).toContain('Suggested next: ACM-3 Add CSV export')
  expect(result.result).toContain('└─ Ada (CEO · running)')
  const listed = await $.tool.call({ tool: 'mcp__paperclip__issues', status: 'todo' })
  expect(listed.result).toContain('ACM-3 [todo, high] Add CSV export')
})

test('the overview shows stats, the next issue and what needs attention', async ($, on) => {
  fakePaperclip(on)
  await $.command.run({ ...RUN, command: 'paperclip', args: 'refresh' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'paperclip', surface, component: 'Pane', requestId: 'paperclip', props: PANE })
    await ui.press({ key: 'tab-overview' })
    expect(await ui.find({ type: 'Text', text: 'Done this week' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Highest-priority todo issue/ })).toBeDefined()
    expect(await ui.find({ key: 'blocked-ACM-4' })).toBeDefined()
    expect(await ui.find({ key: 'approvals' })).toBeDefined()
    await ui.press({ key: 'open-paperclip' })
    await ui.unmount()
  }
})

test('the org chart opens an agent with its work and runs', async ($, on) => {
  fakePaperclip(on)
  await $.command.run({ ...RUN, command: 'paperclip', args: 'org' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'paperclip', surface, component: 'Pane', requestId: 'paperclip', props: PANE })
    await ui.press({ key: 'tab-org' })
    await ui.press({ key: 'agent-a2' })
    expect(await ui.find({ type: 'Text', text: 'Recent runs' })).toBeDefined()
    expect(await ui.find({ key: 'work-ACM-2' })).toBeDefined()
    await ui.press({ key: 'boss-a1' })
    expect(await ui.find({ type: 'Text', text: /succeeded/ })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()
    await ui.unmount()
  }
})

test('an issue goes to Claude Code, Codex or an agent', async ($, on) => {
  const world = fakePaperclip(on)
  await $.command.run({ ...RUN, command: 'paperclip', args: 'issues' })
  const ui = await $.ui.mount({ plugin: 'paperclip', surface: 'desktop', component: 'Pane', requestId: 'paperclip', props: PANE })
  await ui.press({ key: 'tab-issues' })
  await ui.press({ key: 'list-ACM-2' })
  expect(await ui.find({ type: 'Text', text: 'Fix the checkout bug' })).toBeDefined()

  await ui.press({ key: 'detail-claude' })
  expect(world.prompts[0]).toContain('Work on Paperclip issue ACM-2')
  expect(await ui.find({ type: 'Text', text: /Sent ACM-2 to Claude Code/ })).toBeDefined()

  await ui.press({ key: 'detail-codex' })
  const codex = world.commands.find(argv => argv[0] === 'osascript')
  expect(codex?.[2]).toContain('codex')

  expect((await ui.find({ key: 'dispatch-agent' }))).toBeDefined()
  await ui.select({ key: 'dispatch-agent', value: 'a1' })
  await ui.press({ key: 'dispatch' })
  expect(await ui.find({ key: 'confirm-yes' })).toBeDefined()
  expect(world.sent.some(one => one.method === 'PATCH')).toBe(false)
  await ui.press({ key: 'confirm-yes' })
  const patch = world.sent.find(one => one.method === 'PATCH')
  expect(patch?.body).toBe(JSON.stringify({ assigneeAgentId: 'a1' }))
  expect(world.sent.some(one => one.url.endsWith('/api/agents/a1/wakeup'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Assigned ACM-2 to Ada and woke the agent/ })).toBeDefined()
  await ui.unmount()
})

test('the model comments on the pinned issue', async ($, on) => {
  const world = fakePaperclip(on)
  await $.command.run({ ...RUN, command: 'paperclip', args: 'ACM-2' })
  const commented = await $.tool.call({ tool: 'mcp__paperclip__comment', body: 'Fixed the cart total.' })
  expect(commented).toEqual({ result: 'Commented on ACM-2.' })
  expect(world.sent.find(one => one.method === 'POST')?.body).toBe(JSON.stringify({ body: 'Fixed the cart total.' }))
  const empty = await $.tool.call({ tool: 'mcp__paperclip__comment', body: ' ' })
  expect(empty).toEqual({ deny: 'The comment body is empty.' })
})

test('opens the pane on a company or an issue for the model', async ($, on) => {
  fakePaperclip(on)
  expect(await $.tool.call({ tool: 'mcp__paperclip__show', tab: 'org', company: 'acm' })).toEqual({
    result: 'Opened the Paperclip pane on the org chart for Acme.',
  })
  expect(await $.tool.call({ tool: 'mcp__paperclip__show', issue: 'acm-2' })).toEqual({ result: 'Opened ACM-2 in the Paperclip pane.' })
  expect(await $.tool.call({ tool: 'mcp__paperclip__show', company: 'nope' })).toEqual({
    deny: 'No Paperclip company matches "nope". Companies: ACM.',
  })
})

test('restores the pinned issue after /clear', async ($, on) => {
  fakePaperclip(on, { pinned: summary(ISSUES[1]!) })
  await $.classic.SessionStart({ source: 'clear' })
  const read = await $.tool.call({ tool: 'mcp__paperclip__issue' })
  expect(read.result).toContain('ACM-2: Fix the checkout bug')
})

test('says when Paperclip is unreachable', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('http.fetch', () => {
    throw new Error('connection refused')
  })
  const result = await $.command.run({ ...RUN, command: 'paperclip', args: 'refresh' })
  expect(result.text).toBe('Paperclip is not reachable at http://127.0.0.1:3100.')
})
