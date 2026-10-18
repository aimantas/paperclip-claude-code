export type Company = { id: string; name: string; prefix: string }

export type IssueSummary = {
  id: string
  identifier: string
  title: string
  status: string
  priority: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  assigneeAgentId: string | null
  hasActiveRun: boolean
}

export type Comment = { author: string; agentId: string | null; body: string; createdAt: string }

export type IssueDetail = IssueSummary & { description: string | null; comments: Comment[] }

export type Agent = {
  id: string
  name: string
  role: string
  title: string
  status: string
  adapterType: string
  reportsTo: string | null
  lastHeartbeatAt: string | null
  spentMonthlyCents: number
  budgetMonthlyCents: number
  urlKey: string
}

export type OrgNode = Agent & { reports: OrgNode[] }

export type RunSummary = {
  id: string
  status: string
  source: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

export type RunDay = { date: string; succeeded: number; failed: number; total: number }

export type Dashboard = {
  agents: { active: number; running: number; paused: number; error: number }
  tasks: { open: number; inProgress: number; blocked: number; done: number }
  costs: { monthSpendCents: number; monthBudgetCents: number; monthUtilizationPercent: number }
  pendingApprovals: number
  runActivity: RunDay[]
}

export type ProjectSummary = { id: string; name: string; status: string; folders: string[] }

export type Board = {
  state: 'idle' | 'loading' | 'ready' | 'error'
  message?: string
  company?: Company
  /** How the company was chosen: picked for this folder, matched to it, settings, last used. */
  companySource?: string
  companies: Company[]
  issues: IssueSummary[]
  done: IssueSummary[]
  org: OrgNode[]
  agents: Agent[]
  dashboard?: Dashboard
  projects: ProjectSummary[]
  refreshedAt?: string
}

export type Tab = 'overview' | 'org' | 'issues'

export type Detail = { kind: 'issue'; identifier: string } | { kind: 'agent'; id: string } | null

export type Notice = { text: string; tone: 'success' | 'error' | 'info' } | null

export type Confirm = { identifier: string; agentId: string } | null

declare module 'claude-code' {
  interface PluginState {
    paperclip: {
      board: Board
      pinned: IssueSummary | null
      tab: Tab
      detail: Detail
      issueDetail: IssueDetail | null
      agentRuns: RunSummary[]
      query: string
      notice: Notice
      confirm: Confirm
      dispatchAgent: string
    }
  }
}
