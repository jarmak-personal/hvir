import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/app-data', getVersion: () => '0.1.4', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { write: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  nativeImage: {},
}))

import {
  buildDiagnosticReport,
  type DiagnosticReportApplicationFacts,
} from '../src/main/diagnostics/diagnostic-report-builder'
import { DiagnosticReportCoordinator } from '../src/main/diagnostics/diagnostic-report-coordinator'
import { DiagnosticReportStorage } from '../src/main/diagnostics/diagnostic-report-storage'
import type { DiagnosticReportActions } from '../src/main/diagnostics/electron-diagnostic-report-actions'
import type { DiagnosticRecentSnapshot } from '../src/main/diagnostics/diagnostic-intake'
import type { RendererOwner } from '../src/main/renderer-resource-scopes'
import {
  DIAGNOSTIC_REPORT_NOTICE,
  isDiagnosticReport,
  isDiagnosticReportArtifact,
  localPath,
  serializeDiagnosticReportArtifact,
  type DiagnosticReportArtifact,
  type DiagnosticReportScreenshot,
  type DirEntry,
  type HostPath,
  type Stat,
  type WorkbenchHealthSnapshot,
} from '../src/shared'

const NOW = Date.parse('2026-07-22T12:00:00.000Z')
const OWNER: RendererOwner = { id: 7, generation: 3 }
const SENTINEL = '/secret/project TOKEN=hvir-private prompt raw-stack.example'
const ROOT = localPath('/app-data')
const APPLICATION: DiagnosticReportApplicationFacts = {
  version: '0.1.4',
  electronVersion: '37.2.6',
  chromeVersion: '138.0.7204.251',
  platform: 'linux',
  architecture: 'x64',
  mode: 'packaged',
}

describe('diagnostic report boundary', () => {
  it('projects local and SSH evidence into the same closed, future-failing schema', () => {
    const local = report(1, diagnostics('local'))
    const ssh = report(1, diagnostics('ssh'))

    expect(local).toEqual(ssh)
    expect(local.notice).toBe(DIAGNOSTIC_REPORT_NOTICE)
    expect(local.diagnostics.events).toEqual([
      {
        kind: 'pty-spawn-failed',
        owner: 'pty-supervisor',
        ownerGeneration: 1,
        severity: 'error',
        occurredAt: '2026-07-22T12:00:00.000Z',
        correlation: opaqueId(51),
      },
    ])
    expect(JSON.stringify(local)).not.toContain(SENTINEL)
    expect(isDiagnosticReport({ ...local, futureField: true })).toBe(false)
    expect(isDiagnosticReport({ ...local, version: 2 })).toBe(false)
    expect(
      isDiagnosticReport({
        ...local,
        diagnostics: {
          ...local.diagnostics,
          events: Array.from({ length: 257 }, () => local.diagnostics.events[0]),
        },
      }),
    ).toBe(false)
  })

  it('copies and saves only the exact reviewed artifact, then deletes idempotently', async () => {
    const host = new MemoryReportHost()
    const actions = new FakeActions()
    const coordinator = createCoordinator(host, actions)
    const id = opaqueId(1)

    const created = await coordinator.create(OWNER, id)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const reviewed = serializeDiagnosticReportArtifact(created.state.artifact)

    expect(coordinator.copy(OWNER, id)).toEqual({ ok: true, outcome: 'copied' })
    expect(await coordinator.save(OWNER, id)).toEqual({ ok: true, outcome: 'saved' })
    expect(actions.copied).toEqual([reviewed])
    expect(actions.saved).toEqual([reviewed])
    expect(reviewed).not.toContain(SENTINEL)
    expect([...host.files.values()][0]?.content).toBe(reviewed)

    expect(await coordinator.delete(OWNER, id)).toEqual({
      ok: true,
      outcome: 'deleted',
    })
    expect(await coordinator.delete(OWNER, id)).toEqual({
      ok: true,
      outcome: 'deleted',
    })
    expect(host.files.size).toBe(0)
  })

  it('cannot let late or overlapping capture and save work revive stale state', async () => {
    const host = new MemoryReportHost()
    const actions = new FakeActions()
    const coordinator = createCoordinator(host, actions)
    const id = opaqueId(2)
    const created = await coordinator.create(OWNER, id)
    expect(created.ok).toBe(true)

    const firstImage = deferred<DiagnosticReportScreenshot>()
    const secondImage = deferred<DiagnosticReportScreenshot>()
    actions.captureResults.push(firstImage.promise, secondImage.promise)
    const firstCapture = coordinator.capture(OWNER, id, [])
    firstImage.resolve(screenshot(1))
    const captureWrite = host.blockNextWrite()
    await captureWrite.started
    const secondCapture = coordinator.capture(OWNER, id, [])
    captureWrite.release()
    expect(await firstCapture).toEqual({ ok: false, reason: 'stale-renderer' })
    secondImage.resolve(screenshot(2))
    const secondResult = await secondCapture
    expect(secondResult).toMatchObject({ ok: true })
    if (!secondResult.ok) return
    expect(secondResult.state.artifact.screenshot?.sha256).toBe('2'.repeat(64))
    expect([...host.files.values()][0]?.content).toBe(
      serializeDiagnosticReportArtifact(secondResult.state.artifact),
    )

    const saveSelection = deferred<HostPath | undefined>()
    actions.saveSelection = saveSelection.promise
    const saving = coordinator.save(OWNER, id)
    coordinator.cancel(OWNER, id)
    saveSelection.resolve(localPath('/reviewed/report.json'))
    expect(await saving).toEqual({ ok: false, reason: 'stale-renderer' })
    expect(actions.saved).toHaveLength(0)

    const lateImage = deferred<DiagnosticReportScreenshot>()
    actions.captureResults.push(lateImage.promise)
    const lateCapture = coordinator.capture(OWNER, id, [])
    await coordinator.revoke(OWNER)
    lateImage.resolve(screenshot(3))
    expect(await lateCapture).toEqual({ ok: false, reason: 'stale-renderer' })
    expect(host.files.size).toBe(0)
  })

  it('retains at most sixteen temporary reports and removes expired files', async () => {
    const host = new MemoryReportHost()
    const storage = new DiagnosticReportStorage(host, ROOT, () => NOW)

    for (let index = 0; index < 20; index++) {
      const artifact: DiagnosticReportArtifact = { report: report(index + 100) }
      await storage.write(artifact.report.reportId, artifact)
    }
    expect(host.files.size).toBe(16)

    const oldest = [...host.files.values()][0]
    expect(oldest).toBeDefined()
    if (oldest) oldest.mtimeMs = NOW - 25 * 60 * 60 * 1_000
    await storage.cleanup()
    expect(host.files.size).toBe(15)
    await storage.remove(opaqueId(999))
    expect(host.files.size).toBe(15)
  })
})

class FakeActions implements DiagnosticReportActions {
  readonly captureResults: Promise<DiagnosticReportScreenshot>[] = []
  readonly copied: string[] = []
  readonly saved: string[] = []
  saveSelection: Promise<HostPath | undefined> = Promise.resolve(
    localPath('/reviewed/report.json'),
  )

  capture(): Promise<DiagnosticReportScreenshot> {
    return this.captureResults.shift() ?? Promise.resolve(screenshot(9))
  }

  copy(serialized: string): void {
    this.copied.push(serialized)
  }

  selectSave(): Promise<HostPath | undefined> {
    return this.saveSelection
  }

  writeSave(_path: HostPath, serialized: string): Promise<void> {
    this.saved.push(serialized)
    return Promise.resolve()
  }
}

class MemoryReportHost {
  readonly files = new Map<string, { content: string; mtimeMs: number }>()
  private blocker:
    | {
        started: () => void
        wait: Promise<void>
      }
    | undefined
  private mtime = NOW

  readdir(root: HostPath): Promise<DirEntry[]> {
    return Promise.resolve(
      [...this.files.keys()]
        .filter((path) => path.startsWith(`${root.path}/`))
        .map((path) => ({ name: path.slice(root.path.length + 1), type: 'file' })),
    )
  }

  stat(path: HostPath): Promise<Stat> {
    const file = this.files.get(path.path)
    if (!file) return Promise.reject(missing())
    return Promise.resolve({
      type: 'file',
      size: Buffer.byteLength(file.content),
      mtimeMs: file.mtimeMs,
      mode: 0o600,
    })
  }

  async writeFile(path: HostPath, data: Uint8Array | string): Promise<void> {
    const blocker = this.blocker
    this.blocker = undefined
    if (blocker) {
      blocker.started()
      await blocker.wait
    }
    this.files.set(path.path, {
      content: typeof data === 'string' ? data : Buffer.from(data).toString('utf8'),
      mtimeMs: ++this.mtime,
    })
  }

  removeFile(path: HostPath): Promise<void> {
    return this.files.delete(path.path) ? Promise.resolve() : Promise.reject(missing())
  }

  blockNextWrite(): { started: Promise<void>; release: () => void } {
    const started = deferred<void>()
    const release = deferred<void>()
    this.blocker = { started: () => started.resolve(), wait: release.promise }
    return { started: started.promise, release: () => release.resolve() }
  }
}

function createCoordinator(
  host: MemoryReportHost,
  actions: DiagnosticReportActions,
): DiagnosticReportCoordinator {
  return new DiagnosticReportCoordinator(
    { diagnostics: () => diagnostics('ssh'), health },
    APPLICATION,
    new DiagnosticReportStorage(host, ROOT, () => NOW),
    actions,
    (owner) => owner.id === OWNER.id && owner.generation === OWNER.generation,
    () => undefined,
    () => NOW,
  )
}

function report(
  value: number,
  evidence: DiagnosticRecentSnapshot = diagnostics('local'),
) {
  const result = buildDiagnosticReport({
    reportId: opaqueId(value),
    createdAt: '2026-07-22T12:00:00.000Z',
    application: APPLICATION,
    owner: OWNER,
    diagnostics: evidence,
    health: health(),
  })
  if (!result) throw new Error('Expected report fixture to satisfy the schema')
  return result
}

function diagnostics(hostKind: 'local' | 'ssh'): DiagnosticRecentSnapshot {
  return {
    version: 1,
    events: [
      {
        version: 1,
        kind: 'pty-spawn-failed',
        owner: 'pty-supervisor',
        ownerGeneration: 1,
        severity: 'error',
        occurredAt: '2026-07-22T12:00:00.000Z',
        correlation: opaqueId(51),
        hostKind,
        cwd: SENTINEL,
        error: SENTINEL,
        stack: SENTINEL,
        ipcBody: SENTINEL,
        terminalData: SENTINEL,
        prompt: SENTINEL,
        environment: SENTINEL,
        url: SENTINEL,
        source: SENTINEL,
        diff: SENTINEL,
      },
    ],
    dropped: [],
  }
}

function health(): WorkbenchHealthSnapshot {
  return { version: 1, evidence: 'durable', items: [], dropped: 0 }
}

function screenshot(value: number): DiagnosticReportScreenshot {
  const byte = Buffer.from([value])
  return {
    mediaType: 'image/png',
    width: 1,
    height: 1,
    bytes: byte.byteLength,
    sha256: String(value).repeat(64),
    dataUrl: `data:image/png;base64,${byte.toString('base64')}`,
    masked: ['terminal', 'web-pane', 'viewer', 'project-navigation'],
  }
}

function opaqueId(value: number): string {
  return `019c0000-0000-7000-8000-${value.toString().padStart(12, '0')}`
}

function missing(): Error & { code: string } {
  return Object.assign(new Error('missing'), { code: 'ENOENT' })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('diagnostic report artifact schema', () => {
  it('requires image byte accounting and the exact optional-image fields', () => {
    const artifact = { report: report(80), screenshot: screenshot(4) }
    expect(isDiagnosticReportArtifact(artifact)).toBe(true)
    expect(
      isDiagnosticReportArtifact({
        ...artifact,
        screenshot: { ...artifact.screenshot, bytes: 2 },
      }),
    ).toBe(false)
    expect(
      isDiagnosticReportArtifact({
        ...artifact,
        screenshot: { ...artifact.screenshot, futureField: SENTINEL },
      }),
    ).toBe(false)
  })
})
