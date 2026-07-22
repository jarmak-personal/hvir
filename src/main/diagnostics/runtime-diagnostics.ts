import { join } from 'node:path'

import {
  localPath,
  type HostPath,
  type RenderContainmentDiagnosticBatch,
  type ResponsivenessDiagnosticsState,
  type ResponsivenessObservationBatch,
  type ResponsivenessStopReason,
  type RendererDiagnosticSession,
  type WorkbenchHealthSnapshot,
} from '../../shared'
import { WorkbenchHealth } from '../health/workbench-health'
import type { WindowHealthDiagnostic } from '../health/workbench-health-events'
import type { ProjectHost } from '../project-host'
import { LocalHost } from '../project-host/local-host'
import type { ProjectHostControlDiagnostic } from '../project-coordinator'
import type { PtySupervisorDiagnostic } from '../pty/pty-supervisor'
import type { TerminalSessionRegistryDiagnostic } from '../terminal/session-registry'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { IpcContractDiagnostic } from '../ipc/authority-router'
import { DiagnosticIntake, type DiagnosticRecentSnapshot } from './diagnostic-intake'
import {
  DiagnosticJournal,
  DIAGNOSTIC_SEGMENT_COUNT,
  type ApplicationDiagnosticKind,
  type DiagnosticJournalStatus,
  type DiagnosticJournalStorage,
  type DiagnosticSegmentMetadata,
} from './diagnostic-journal'
import type { StoredDiagnosticEvent } from './diagnostic-event'
import { ResponsivenessDiagnosticSessions } from './responsiveness-diagnostic-sessions'

const JOURNAL_FILE = 'runtime-diagnostics.jsonl'
type PublishHealth = (snapshot: WorkbenchHealthSnapshot) => void

/** App-lifetime diagnostics facade; feature owners can emit only their closed schemas. */
export class RuntimeDiagnostics {
  private constructor(
    private readonly intake: DiagnosticIntake,
    private readonly health: WorkbenchHealth,
    private readonly persistenceEnabled: boolean,
    private readonly publish: PublishHealth,
    private readonly responsiveness: ResponsivenessDiagnosticSessions,
    private readonly journal?: DiagnosticJournal,
    private readonly localHost?: LocalHost,
  ) {}

  static create(
    userDataPath: string,
    enabled: boolean,
    publish: PublishHealth = () => undefined,
    responsivenessAvailable = false,
  ): RuntimeDiagnostics {
    const health = new WorkbenchHealth()
    let runtime: RuntimeDiagnostics | undefined
    const onAccepted = (event: StoredDiagnosticEvent): void => {
      if (health.observe(event)) runtime?.publishHealth()
    }
    if (!enabled) {
      const intake = new DiagnosticIntake({ onAccepted })
      runtime = new RuntimeDiagnostics(
        intake,
        health,
        false,
        publish,
        new ResponsivenessDiagnosticSessions(intake, {
          available: responsivenessAvailable,
        }),
      )
      return runtime
    }
    const localHost = new LocalHost()
    const storage = new ProjectHostDiagnosticStorage(localHost, userDataPath)
    const journal = new DiagnosticJournal(storage)
    const intake = new DiagnosticIntake({ writer: journal, onAccepted })
    runtime = new RuntimeDiagnostics(
      intake,
      health,
      true,
      publish,
      new ResponsivenessDiagnosticSessions(intake, {
        available: responsivenessAvailable,
      }),
      journal,
      localHost,
    )
    return runtime
  }

  recordApplication(kind: ApplicationDiagnosticKind): void {
    this.intake.record({ kind })
  }

  recordPty(event: PtySupervisorDiagnostic): void {
    this.intake.record(event)
  }

  recordSessionRegistry(event: TerminalSessionRegistryDiagnostic): void {
    if (event.kind === 'load-failed') {
      this.intake.record({
        kind: 'terminal-session-registry-load-failed',
        reason: event.reason,
      })
    } else {
      this.intake.record({ kind: 'terminal-session-registry-persist-failed' })
    }
  }

  recordHostControl(event: ProjectHostControlDiagnostic): void {
    this.intake.record({
      kind: 'host-control-failed',
      operation: event.operation,
      hostKind: event.hostKind,
    })
  }

  recordIpcContract(event: IpcContractDiagnostic): void {
    this.intake.record({ kind: 'ipc-contract-rejected', ...event })
  }

  startRenderer(owner: RendererOwner): RendererDiagnosticSession {
    const session = this.intake.startRenderer(owner)
    const recovered = this.health.rendererReady(owner, nowIso())
    if (recovered.length > 0) this.publishHealth()
    for (const event of recovered) this.intake.record(event)
    return session
  }

  revokeRenderer(owner: RendererOwner): void {
    this.responsiveness.revoke(owner)
    this.intake.revokeRenderer(owner)
  }

  closeRenderer(owner: RendererOwner): void {
    this.responsiveness.revoke(owner)
    this.intake.revokeRenderer(owner)
    const recovered = this.health.rendererClosed(owner, nowIso())
    if (recovered.length > 0) this.publishHealth()
    for (const event of recovered) this.intake.record(event)
  }

  recordWindowHealth(event: WindowHealthDiagnostic): void {
    this.intake.record(event)
  }

  recordRenderContainment(
    owner: RendererOwner,
    batch: RenderContainmentDiagnosticBatch,
  ): void {
    this.intake.recordRenderContainment(owner, batch)
  }

  responsivenessState(owner: RendererOwner): ResponsivenessDiagnosticsState {
    return this.responsiveness.state(owner)
  }

  startResponsiveness(owner: RendererOwner): ResponsivenessDiagnosticsState {
    return this.responsiveness.start(owner)
  }

  recordResponsiveness(
    owner: RendererOwner,
    batch: ResponsivenessObservationBatch,
  ): void {
    this.responsiveness.observe(owner, batch)
  }

  stopResponsiveness(
    owner: RendererOwner,
    diagnosticSessionId: string,
    reason: Exclude<ResponsivenessStopReason, 'timeout'>,
  ): ResponsivenessDiagnosticsState {
    return this.responsiveness.stop(owner, diagnosticSessionId, reason)
  }

  deleteResponsiveness(
    owner: RendererOwner,
    diagnosticSessionId: string,
  ): ResponsivenessDiagnosticsState {
    return this.responsiveness.delete(owner, diagnosticSessionId)
  }

  snapshot(): DiagnosticRecentSnapshot {
    return this.intake.snapshot()
  }

  healthSnapshot(): WorkbenchHealthSnapshot {
    return this.health.snapshot(this.evidenceAvailability())
  }

  acknowledgeHealth(occurrenceId: string): WorkbenchHealthSnapshot {
    if (this.health.acknowledge(occurrenceId)) this.publishHealth()
    return this.healthSnapshot()
  }

  status(): DiagnosticJournalStatus | undefined {
    return this.journal?.status()
  }

  async dispose(): Promise<void> {
    this.responsiveness.dispose()
    await this.journal?.dispose()
    await this.localHost?.dispose()
  }

  private publishHealth(): void {
    try {
      this.publish(this.healthSnapshot())
    } catch {
      // Health presentation never owns diagnostic intake or feature recovery.
    }
  }

  private evidenceAvailability(): WorkbenchHealthSnapshot['evidence'] {
    if (!this.persistenceEnabled) return 'memory-only'
    return this.journal?.status().sink === 'failed' ? 'unavailable' : 'durable'
  }
}

function nowIso(): string {
  return new Date(Date.now()).toISOString()
}

class ProjectHostDiagnosticStorage implements DiagnosticJournalStorage {
  readonly location: string
  private readonly files: readonly HostPath[]

  constructor(
    private readonly host: ProjectHost,
    userDataPath: string,
  ) {
    this.location = join(userDataPath, JOURNAL_FILE)
    this.files = Array.from({ length: DIAGNOSTIC_SEGMENT_COUNT }, (_value, index) =>
      localPath(
        join(
          userDataPath,
          index === 0 ? JOURNAL_FILE : `runtime-diagnostics.${index}.jsonl`,
        ),
      ),
    )
  }

  async inspectSegment(index: number): Promise<DiagnosticSegmentMetadata | undefined> {
    try {
      const stat = await this.host.stat(this.file(index))
      if (stat.type !== 'file') return undefined
      return { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  async readSegment(index: number, maxBytes: number): Promise<string | undefined> {
    try {
      const content = await this.host.readFile(this.file(index))
      if (content.byteLength > maxBytes) return undefined
      return content.toString('utf8')
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  writeSegment(index: number, content: string): Promise<void> {
    return this.host.writeFile(this.file(index), content)
  }

  async removeSegment(index: number): Promise<void> {
    await this.host.removeFile(this.file(index)).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
  }

  private file(index: number): HostPath {
    const file = this.files[index]
    if (!file) throw new Error('Invalid diagnostics segment')
    return file
  }
}

function isMissing(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    value.code === 'ENOENT'
  )
}
