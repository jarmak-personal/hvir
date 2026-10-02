import { randomUUID } from 'node:crypto'
import {
  AGENT_LIMITS,
  type AgentReport,
  type AgentReportSummary,
} from '../../shared/agent/contract'
import type { HostPath } from '../../shared/host-path'

interface RetainedReport {
  report: AgentReport
  readonly handle: string
  readonly connection: string
  bytes: number
}
/** Viewer content identity and retention, independent of diagnostic and terminal attention. */
export class AgentReportOwner {
  private readonly retained = new Map<string, RetainedReport>()
  constructor(private readonly changed: () => void) {}
  snapshot(): readonly AgentReportSummary[] {
    return [...this.retained.values()].map(
      ({ report: { content: _content, ...summary } }) => summary,
    )
  }
  read(id: string): AgentReport {
    const report = this.retained.get(id)?.report
    if (!report) throw new Error('Report is closed')
    return report
  }
  publish(
    connection: string,
    workspace: string,
    root: HostPath,
    title: string,
    format: 'text' | 'markdown',
    content: string,
    handle?: string,
  ): { readonly id: string; readonly handle: string; readonly workspace: string } {
    if (!title || title.length > 80 || !['text', 'markdown'].includes(format))
      throw new Error('Invalid report presentation')
    const bytes = Buffer.byteLength(content)
    if (bytes > AGENT_LIMITS.reportBytes) throw new Error('Report exceeds its byte limit')
    const previous = handle
      ? [...this.retained.values()].find((entry) => entry.handle === handle)
      : undefined
    if (
      handle &&
      (!previous ||
        previous.report.workspace !== workspace ||
        previous.report.root.hostId !== root.hostId ||
        previous.report.root.path !== root.path)
    )
      throw new Error('Report handle is stale or belongs to another target')
    const current = [...this.retained.values()].filter((entry) => entry !== previous)
    const chargedConnection = previous?.connection ?? connection
    if (
      current.length >= AGENT_LIMITS.reports ||
      current.reduce((total, entry) => total + entry.bytes, 0) + bytes >
        AGENT_LIMITS.reportTotalBytes ||
      current.filter((entry) => entry.connection === chargedConnection).length >=
        AGENT_LIMITS.reportsPerConnection ||
      current
        .filter((entry) => entry.connection === chargedConnection)
        .reduce((total, entry) => total + entry.bytes, 0) +
        bytes >
        AGENT_LIMITS.reportConnectionBytes
    )
      throw new Error('Report capacity is full; close unused reports')
    const id = previous?.report.id ?? randomUUID(),
      replacementHandle = previous?.handle ?? randomUUID()
    this.retained.set(id, {
      report: {
        id,
        workspace,
        root,
        title,
        format,
        content,
        unread: true,
        version: (previous?.report.version ?? 0) + 1,
      },
      handle: replacementHandle,
      connection: previous?.connection ?? connection,
      bytes,
    })
    this.changed()
    return { id, handle: replacementHandle, workspace }
  }
  viewed(id: string, version: number): void {
    const entry = this.retained.get(id)
    if (entry?.report.unread && entry.report.version === version) {
      entry.report = { ...entry.report, unread: false }
      this.changed()
    }
  }
  close(id: string): void {
    if (this.retained.delete(id)) this.changed()
  }
  retainWorkspaces(ids: ReadonlySet<string>): void {
    let changed = false
    for (const [id, entry] of this.retained)
      if (!ids.has(entry.report.workspace)) {
        this.retained.delete(id)
        changed = true
      }
    if (changed) this.changed()
  }
  dispose(): void {
    this.retained.clear()
  }
}
