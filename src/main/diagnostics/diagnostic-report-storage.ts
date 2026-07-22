import {
  DIAGNOSTIC_REPORT_RETENTION_HOURS,
  MAX_DIAGNOSTIC_REPORT_BYTES,
  isDiagnosticOpaqueId,
  joinHostPath,
  type DiagnosticReportArtifact,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import { serializeDiagnosticReportArtifact } from '../../shared'

const REPORT_PREFIX = 'hvir-diagnostic-report-'
const REPORT_SUFFIX = '.json'
const MAX_TEMPORARY_REPORTS = 16

/** App-local bounded temporary report storage; paths never enter report content. */
export class DiagnosticReportStorage {
  private mutation = Promise.resolve()

  constructor(
    private readonly host: Pick<
      ProjectHost,
      'readdir' | 'stat' | 'writeFile' | 'removeFile'
    >,
    private readonly root: HostPath,
    private readonly now: () => number = Date.now,
  ) {}

  async write(reportId: string, artifact: DiagnosticReportArtifact): Promise<void> {
    const serialized = serializeDiagnosticReportArtifact(artifact)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DIAGNOSTIC_REPORT_BYTES) {
      throw new ReportStorageTooLargeError()
    }
    const path = this.file(reportId)
    await this.mutate(async () => {
      await this.host.writeFile(path, serialized)
      try {
        await this.cleanupUnlocked(path)
      } catch (error) {
        await this.removeUnlocked(path).catch(() => undefined)
        throw error
      }
    })
  }

  async remove(reportId: string): Promise<void> {
    await this.mutate(() => this.removeUnlocked(this.file(reportId)))
  }

  async cleanup(): Promise<void> {
    await this.mutate(() => this.cleanupUnlocked())
  }

  private async cleanupUnlocked(protectedPath?: HostPath): Promise<void> {
    const cutoff = this.now() - DIAGNOSTIC_REPORT_RETENTION_HOURS * 60 * 60 * 1_000
    const entries = (await this.host.readdir(this.root))
      .filter((entry) => entry.type === 'file' && isReportFilename(entry.name))
      .map((entry) => ({ name: entry.name, path: joinHostPath(this.root, entry.name) }))
    const inspected = await Promise.all(
      entries.map(async (entry) => {
        try {
          return { ...entry, stat: await this.host.stat(entry.path) }
        } catch (error) {
          if (isMissing(error)) return undefined
          throw error
        }
      }),
    )
    const files = inspected
      .filter((entry) => entry?.stat.type === 'file')
      .sort((left, right) => {
        if (protectedPath && left?.path.path === protectedPath.path) return -1
        if (protectedPath && right?.path.path === protectedPath.path) return 1
        return (right?.stat.mtimeMs ?? 0) - (left?.stat.mtimeMs ?? 0)
      })
    await Promise.all(
      files
        .filter(
          (entry, index) =>
            index >= MAX_TEMPORARY_REPORTS || entry!.stat.mtimeMs < cutoff,
        )
        .map((entry) =>
          this.host.removeFile(entry!.path).catch((error: unknown) => {
            if (!isMissing(error)) throw error
          }),
        ),
    )
  }

  private async removeUnlocked(path: HostPath): Promise<void> {
    await this.host.removeFile(path).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation)
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private file(reportId: string): HostPath {
    if (!isDiagnosticOpaqueId(reportId)) throw new Error('Invalid report id')
    return joinHostPath(this.root, `${REPORT_PREFIX}${reportId}${REPORT_SUFFIX}`)
  }
}

export class ReportStorageTooLargeError extends Error {}

function isReportFilename(value: string): boolean {
  if (!value.startsWith(REPORT_PREFIX) || !value.endsWith(REPORT_SUFFIX)) return false
  return isDiagnosticOpaqueId(value.slice(REPORT_PREFIX.length, -REPORT_SUFFIX.length))
}

function isMissing(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code?: unknown }).code === 'ENOENT'
  )
}
