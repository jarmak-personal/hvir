import { join } from 'node:path'

import { localPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { LocalHost } from '../project-host/local-host'
import type { ProjectHostControlDiagnostic } from '../project-coordinator'
import type { PtySupervisorDiagnostic } from '../pty/pty-supervisor'
import type { TerminalSessionRegistryDiagnostic } from '../terminal/session-registry'
import {
  DiagnosticJournal,
  DIAGNOSTIC_SEGMENT_COUNT,
  type ApplicationDiagnosticKind,
  type DiagnosticJournalStatus,
  type DiagnosticJournalStorage,
  type DiagnosticSegmentMetadata,
} from './diagnostic-journal'

const JOURNAL_FILE = 'runtime-diagnostics.jsonl'

/** App-lifetime diagnostics facade; feature owners can emit only their closed schemas. */
export class RuntimeDiagnostics {
  private constructor(
    private readonly journal?: DiagnosticJournal,
    private readonly localHost?: LocalHost,
  ) {}

  static create(userDataPath: string, enabled: boolean): RuntimeDiagnostics {
    if (!enabled) return new RuntimeDiagnostics()
    const localHost = new LocalHost()
    const storage = new ProjectHostDiagnosticStorage(localHost, userDataPath)
    return new RuntimeDiagnostics(new DiagnosticJournal(storage), localHost)
  }

  recordApplication(kind: ApplicationDiagnosticKind): void {
    this.journal?.record({ kind })
  }

  recordPty(event: PtySupervisorDiagnostic): void {
    this.journal?.record(event)
  }

  recordSessionRegistry(event: TerminalSessionRegistryDiagnostic): void {
    if (event.kind === 'load-failed') {
      this.journal?.record({
        kind: 'terminal-session-registry-load-failed',
        reason: event.reason,
      })
    } else {
      this.journal?.record({ kind: 'terminal-session-registry-persist-failed' })
    }
  }

  recordHostControl(event: ProjectHostControlDiagnostic): void {
    this.journal?.record({
      kind: 'host-control-failed',
      operation: event.operation,
      hostKind: event.hostKind,
    })
  }

  status(): DiagnosticJournalStatus | undefined {
    return this.journal?.status()
  }

  async dispose(): Promise<void> {
    await this.journal?.dispose()
    await this.localHost?.dispose()
  }
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
