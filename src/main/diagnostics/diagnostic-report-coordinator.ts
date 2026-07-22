import { app } from 'electron'

import {
  DIAGNOSTIC_REPORT_RETENTION_HOURS,
  isDiagnosticOpaqueId,
  isDiagnosticReportArtifact,
  localPath,
  serializeDiagnosticReportArtifact,
  type DiagnosticCaptureMask,
  type DiagnosticReportActionResult,
  type DiagnosticReportArtifact,
  type DiagnosticReportFailure,
  type DiagnosticReportState,
  type DiagnosticReportStateResult,
  type HostPath,
} from '../../shared'
import { LocalHost } from '../project-host/local-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import {
  buildDiagnosticReport,
  reportArchitecture,
  reportPlatform,
  safeVersion,
  type DiagnosticReportApplicationFacts,
} from './diagnostic-report-builder'
import {
  ElectronDiagnosticReportActions,
  ScreenshotTooLargeError,
  type DiagnosticReportActions,
} from './electron-diagnostic-report-actions'
import {
  DiagnosticReportStorage,
  ReportStorageTooLargeError,
} from './diagnostic-report-storage'
import type { DiagnosticRecentSnapshot } from './diagnostic-intake'
import type { WorkbenchHealthSnapshot } from '../../shared'

export interface DiagnosticReportSnapshotPorts {
  readonly diagnostics: () => DiagnosticRecentSnapshot
  readonly health: () => WorkbenchHealthSnapshot
}

interface ReportRecord {
  readonly owner: RendererOwner
  readonly reportId: string
  revision: number
  commit: Promise<void>
  cancelExpiry?: () => void
  artifact?: DiagnosticReportArtifact
}

/** Coordinates one reviewed temporary report per exact renderer generation. */
export class DiagnosticReportCoordinator {
  private readonly records = new Map<string, ReportRecord>()
  private readonly activeByOwner = new Map<string, ReportRecord>()
  private readonly deletedByOwner = new Map<string, Set<string>>()
  private disposed = false

  constructor(
    private readonly snapshots: DiagnosticReportSnapshotPorts,
    private readonly application: DiagnosticReportApplicationFacts,
    private readonly storage: DiagnosticReportStorage,
    private readonly actions: DiagnosticReportActions,
    private readonly isRendererCurrent: (owner: RendererOwner) => boolean,
    private readonly disposeStorage: () => void | Promise<void> = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly scheduleExpiry: (
      callback: () => void,
      delayMs: number,
    ) => () => void = defaultScheduleExpiry,
  ) {}

  async start(): Promise<void> {
    try {
      await this.storage.cleanup()
    } catch {
      // Temporary report cleanup cannot interfere with startup.
    }
  }

  async create(
    owner: RendererOwner,
    reportId: string,
  ): Promise<DiagnosticReportStateResult> {
    if (
      !this.accepts(owner) ||
      !isDiagnosticOpaqueId(reportId) ||
      this.records.has(reportId)
    )
      return failure('invalid-request')
    try {
      await this.replaceActive(owner)
    } catch {
      return failure('storage-unavailable')
    }
    if (!this.accepts(owner) || this.records.has(reportId)) {
      return failure('stale-renderer')
    }
    const record: ReportRecord = {
      owner,
      reportId,
      revision: 0,
      commit: Promise.resolve(),
    }
    this.records.set(reportId, record)
    this.activeByOwner.set(ownerKey(owner), record)
    let report: DiagnosticReportArtifact['report'] | undefined
    try {
      report = buildDiagnosticReport({
        reportId,
        createdAt: new Date(this.now()).toISOString(),
        application: this.application,
        owner,
        diagnostics: this.snapshots.diagnostics(),
        health: this.snapshots.health(),
      })
    } catch {
      this.forget(record)
      return failure('storage-unavailable')
    }
    if (!report) {
      this.forget(record)
      return failure('report-too-large')
    }
    const artifact: DiagnosticReportArtifact = { report }
    try {
      await this.storage.write(reportId, artifact)
    } catch (error) {
      this.forget(record)
      return failure(storageFailure(error))
    }
    if (!this.matches(record, 0)) {
      this.forget(record)
      await this.storage.remove(reportId).catch(() => undefined)
      return failure('stale-renderer')
    }
    record.artifact = artifact
    record.cancelExpiry = this.scheduleExpiry(
      () => this.expire(record),
      DIAGNOSTIC_REPORT_RETENTION_HOURS * 60 * 60 * 1_000,
    )
    return success(artifact)
  }

  async capture(
    owner: RendererOwner,
    reportId: string,
    masks: readonly DiagnosticCaptureMask[],
  ): Promise<DiagnosticReportStateResult> {
    const record = this.current(owner, reportId)
    if (!record?.artifact)
      return failure(this.accepts(owner) ? 'report-not-found' : 'stale-renderer')
    const revision = ++record.revision
    const previous = record.artifact
    let screenshot: Awaited<ReturnType<DiagnosticReportActions['capture']>>
    try {
      screenshot = await this.actions.capture(owner, masks)
    } catch (error) {
      return failure(
        error instanceof ScreenshotTooLargeError ? 'report-too-large' : 'capture-failed',
      )
    }
    const artifact: DiagnosticReportArtifact = { report: previous.report, screenshot }
    if (!isDiagnosticReportArtifact(artifact)) return failure('report-too-large')
    if (!this.matches(record, revision)) return failure('stale-renderer')
    return this.commitCapture(record, revision, previous, artifact)
  }

  copy(owner: RendererOwner, reportId: string): DiagnosticReportActionResult {
    const record = this.current(owner, reportId)
    if (!record?.artifact)
      return failure(this.accepts(owner) ? 'report-not-found' : 'stale-renderer')
    try {
      this.actions.copy(
        serializeDiagnosticReportArtifact(record.artifact),
        record.artifact.screenshot,
      )
      return { ok: true, outcome: 'copied' }
    } catch {
      return failure('action-unavailable')
    }
  }

  async save(
    owner: RendererOwner,
    reportId: string,
  ): Promise<DiagnosticReportActionResult> {
    const record = this.current(owner, reportId)
    if (!record?.artifact)
      return failure(this.accepts(owner) ? 'report-not-found' : 'stale-renderer')
    const revision = record.revision
    let path: HostPath | undefined
    try {
      path = await this.actions.selectSave(owner)
    } catch {
      return failure('storage-unavailable')
    }
    if (!path) return { ok: true, outcome: 'cancelled' }
    if (!this.matches(record, revision)) return failure('stale-renderer')
    try {
      await this.actions.writeSave(
        path,
        serializeDiagnosticReportArtifact(record.artifact),
      )
      return this.matches(record, revision)
        ? { ok: true, outcome: 'saved' }
        : failure('stale-renderer')
    } catch {
      return failure('storage-unavailable')
    }
  }

  cancel(owner: RendererOwner, reportId: string): DiagnosticReportActionResult {
    const record = this.current(owner, reportId)
    if (record) record.revision++
    return { ok: true, outcome: 'cancelled' }
  }

  async delete(
    owner: RendererOwner,
    reportId: string,
  ): Promise<DiagnosticReportActionResult> {
    const record = this.current(owner, reportId)
    if (!record) {
      if (!this.deletedByOwner.get(ownerKey(owner))?.has(reportId)) {
        return failure(this.accepts(owner) ? 'report-not-found' : 'stale-renderer')
      }
      try {
        await this.storage.remove(reportId)
        return { ok: true, outcome: 'deleted' }
      } catch {
        return failure('storage-unavailable')
      }
    }
    this.forget(record)
    const deleted = this.deletedByOwner.get(ownerKey(owner)) ?? new Set<string>()
    deleted.add(reportId)
    while (deleted.size > 16) deleted.delete(deleted.values().next().value!)
    this.deletedByOwner.set(ownerKey(owner), deleted)
    try {
      await this.storage.remove(reportId)
      return { ok: true, outcome: 'deleted' }
    } catch {
      return failure('storage-unavailable')
    }
  }

  async revoke(owner: RendererOwner): Promise<void> {
    const records = [...this.records.values()].filter(
      (record) => ownerKey(record.owner) === ownerKey(owner),
    )
    for (const record of records) this.forget(record)
    this.deletedByOwner.delete(ownerKey(owner))
    await Promise.all(
      records.map((record) =>
        this.storage.remove(record.reportId).catch(() => undefined),
      ),
    )
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const record of [...this.records.values()]) this.forget(record)
    this.activeByOwner.clear()
    this.deletedByOwner.clear()
    await this.disposeStorage()
  }

  private accepts(owner: RendererOwner): boolean {
    return !this.disposed && this.isRendererCurrent(owner)
  }

  private current(owner: RendererOwner, reportId: string): ReportRecord | undefined {
    if (!this.accepts(owner)) return undefined
    const record = this.records.get(reportId)
    return record &&
      this.activeByOwner.get(ownerKey(owner)) === record &&
      ownerKey(record.owner) === ownerKey(owner)
      ? record
      : undefined
  }

  private matches(record: ReportRecord, revision: number): boolean {
    return (
      this.accepts(record.owner) &&
      this.records.get(record.reportId) === record &&
      this.activeByOwner.get(ownerKey(record.owner)) === record &&
      record.revision === revision
    )
  }

  private async replaceActive(owner: RendererOwner): Promise<void> {
    const previous = this.activeByOwner.get(ownerKey(owner))
    if (!previous) return
    this.forget(previous)
    await this.storage.remove(previous.reportId)
  }

  private forget(record: ReportRecord): void {
    record.revision++
    record.cancelExpiry?.()
    record.cancelExpiry = undefined
    if (this.records.get(record.reportId) === record) this.records.delete(record.reportId)
    if (this.activeByOwner.get(ownerKey(record.owner)) === record) {
      this.activeByOwner.delete(ownerKey(record.owner))
    }
  }

  private async restoreOrRemove(
    record: ReportRecord,
    previous: DiagnosticReportArtifact,
  ): Promise<void> {
    if (this.records.get(record.reportId) === record) {
      await this.storage.write(record.reportId, previous).catch(() => undefined)
    } else {
      await this.storage.remove(record.reportId).catch(() => undefined)
    }
  }

  private commitCapture(
    record: ReportRecord,
    revision: number,
    previous: DiagnosticReportArtifact,
    artifact: DiagnosticReportArtifact,
  ): Promise<DiagnosticReportStateResult> {
    const operation = record.commit.then(async () => {
      if (!this.matches(record, revision)) return failure('stale-renderer')
      try {
        await this.storage.write(record.reportId, artifact)
      } catch (error) {
        return failure(storageFailure(error))
      }
      if (!this.matches(record, revision)) {
        await this.restoreOrRemove(record, previous)
        return failure('stale-renderer')
      }
      record.artifact = artifact
      return success(artifact)
    })
    record.commit = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private expire(record: ReportRecord): void {
    if (this.records.get(record.reportId) !== record) return
    this.forget(record)
    void this.storage.remove(record.reportId).catch(() => undefined)
  }
}

export function createDiagnosticReportCoordinator(
  diagnostics: {
    snapshot(): DiagnosticRecentSnapshot
    healthSnapshot(): WorkbenchHealthSnapshot
  },
  renderers: { isCurrent(owner: RendererOwner): boolean },
): DiagnosticReportCoordinator {
  const host = new LocalHost()
  const coordinator = new DiagnosticReportCoordinator(
    {
      diagnostics: () => diagnostics.snapshot(),
      health: () => diagnostics.healthSnapshot(),
    },
    {
      version: safeVersion(app.getVersion()),
      electronVersion: safeVersion(process.versions.electron),
      chromeVersion: safeVersion(process.versions.chrome),
      platform: reportPlatform(process.platform),
      architecture: reportArchitecture(process.arch),
      mode: app.isPackaged ? 'packaged' : 'development',
    },
    new DiagnosticReportStorage(host, localPath(app.getPath('userData'))),
    new ElectronDiagnosticReportActions(host),
    (owner) => renderers.isCurrent(owner),
    () => host.dispose(),
  )
  void coordinator.start()
  return coordinator
}

function success(artifact: DiagnosticReportArtifact): DiagnosticReportStateResult {
  const state: DiagnosticReportState = {
    artifact,
    storage: {
      location: 'Application data',
      retentionHours: DIAGNOSTIC_REPORT_RETENTION_HOURS,
    },
  }
  return { ok: true, state }
}

function failure(reason: DiagnosticReportFailure): {
  ok: false
  reason: DiagnosticReportFailure
} {
  return { ok: false, reason }
}

function storageFailure(error: unknown): DiagnosticReportFailure {
  return error instanceof ReportStorageTooLargeError
    ? 'report-too-large'
    : 'storage-unavailable'
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}

function defaultScheduleExpiry(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return () => clearTimeout(timer)
}
