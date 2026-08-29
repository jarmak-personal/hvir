import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { registerIpcHandlers, type IpcDeps } from '../src/main/ipc'
import {
  AUTHORITY_SCOPED_INVOKE_CHANNELS,
  IpcAuthority,
  IpcAuthorityRouter,
  OWNER_SCOPED_INVOKE_CHANNELS,
  OWNER_SCOPED_SEND_CHANNELS,
  type IpcContractDiagnostic,
  type IpcMainRegistrationPort,
} from '../src/main/ipc/authority-router'
import type { ProjectHost } from '../src/main/project-host'
import type { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  localPath,
  type IpcInvokeChannel,
  type IpcSendChannel,
  type DocumentReviewModel,
  type ProjectState,
} from '../src/shared'

type InvokeListener = (event: Electron.IpcMainInvokeEvent, request: unknown) => unknown
type SendListener = (event: Electron.IpcMainEvent, payload: unknown) => void

class FakeIpcMain implements IpcMainRegistrationPort {
  readonly invokes = new Map<string, InvokeListener[]>()
  readonly sends = new Map<string, SendListener[]>()
  readonly removedInvokes: string[] = []
  readonly removedSends: string[] = []

  handle(channel: string, listener: InvokeListener): void {
    const listeners = this.invokes.get(channel) ?? []
    listeners.push(listener)
    this.invokes.set(channel, listeners)
  }

  removeHandler(channel: string): void {
    this.removedInvokes.push(channel)
    this.invokes.delete(channel)
  }

  on(channel: string, listener: SendListener): void {
    const listeners = this.sends.get(channel) ?? []
    listeners.push(listener)
    this.sends.set(channel, listeners)
  }

  removeListener(channel: string, listener: SendListener): void {
    this.removedSends.push(channel)
    const remaining = (this.sends.get(channel) ?? []).filter(
      (candidate) => candidate !== listener,
    )
    if (remaining.length > 0) this.sends.set(channel, remaining)
    else this.sends.delete(channel)
  }
}

const root = localPath('/project')
const owner = { id: 7, generation: 3 }

function projectState(): ProjectState {
  return {
    revision: 0,
    root,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project-1',
    activeWorkspaceId: 'workspace-1',
    projects: [
      {
        id: 'project-1',
        registeredRoot: root,
        displayName: 'project',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: 'workspace-1',
        workspaces: [
          {
            id: 'workspace-1',
            root,
            name: 'project',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
}

function fixture() {
  const currentIpcOwner = vi.fn(() => owner)
  const assertCurrent = vi.fn()
  const rendererResources = {
    currentIpcOwner,
    assertCurrent,
  } as unknown as RendererResourceScopes
  const recordIpcContractDiagnostic = vi.fn<(event: IpcContractDiagnostic) => void>()
  const createProjectFile = vi.fn<IpcDeps['projectFiles']['create']>().mockResolvedValue({
    outcome: 'completed',
    operationId: 'operation-1',
    generation: 1,
    items: [],
  })
  const organizeProjectFile = vi
    .fn<IpcDeps['projectFiles']['organize']>()
    .mockResolvedValue({
      outcome: 'started',
      operationId: 'organize-1',
      generation: 2,
      itemCount: 1,
    })
  const discloseDeletion = vi
    .fn<IpcDeps['projectFiles']['discloseDeletion']>()
    .mockResolvedValue({
      outcome: 'available',
      workspaceRoot: root,
      source: localPath('/project/source.ts'),
      recovery: 'recoverable',
    })
  const deleteProjectFile = vi.fn<IpcDeps['projectFiles']['delete']>().mockResolvedValue({
    outcome: 'started',
    operationId: 'delete-1',
    generation: 3,
    itemCount: 1,
  })
  const discloseExternalMove = vi
    .fn<IpcDeps['projectFiles']['discloseExternalMove']>()
    .mockReturnValue({
      outcome: 'available',
      picker: { kind: 'mixed-multiple', limitation: 'mixed selection' },
      recovery: 'recoverable',
    })
  const acquireExternalMove = vi
    .fn<IpcDeps['projectFiles']['acquireExternalMove']>()
    .mockResolvedValue({ outcome: 'cancelled' })
  const releaseExternalMove = vi
    .fn<IpcDeps['projectFiles']['releaseExternalMove']>()
    .mockReturnValue(true)
  const moveExternal = vi
    .fn<IpcDeps['projectFiles']['moveExternal']>()
    .mockResolvedValue({
      outcome: 'started',
      operationId: 'external-move-1',
      generation: 4,
      itemCount: 1,
    })
  const reviewModel: DocumentReviewModel = {
    workspace: { id: 'workspace-1', root },
    comments: [],
    batches: [],
  }
  const restoreDocumentReview = vi
    .fn<IpcDeps['documentReview']['activate']>()
    .mockResolvedValue({ workspaceGeneration: 4, revision: 0, model: reviewModel })
  const saveDocumentReview = vi
    .fn<IpcDeps['documentReview']['save']>()
    .mockResolvedValue({ workspaceGeneration: 4, revision: 1, model: reviewModel })
  const revalidateDocumentReview = vi
    .fn<IpcDeps['documentReview']['revalidate']>()
    .mockImplementation((_owner, request) =>
      Promise.resolve({
        status: 'stale',
        document: request.document,
        reason: 'deleted',
      }),
    )
  const realpath = vi.fn((path: typeof root) => Promise.resolve(path))
  const stat = vi
    .fn<ProjectHost['stat']>()
    .mockResolvedValue({ type: 'file', size: 0, mtimeMs: 0, mode: 0o644 })
  const projectHost = {
    hostId: root.hostId,
    connectionState: 'connected',
    watchTier: 'native',
    realpath,
    stat,
  } as unknown as ProjectHost
  const revealLocalEntry = vi.fn()
  const deps = {
    rendererResources,
    recordIpcContractDiagnostic,
    projectFiles: {
      create: createProjectFile,
      organize: organizeProjectFile,
      discloseDeletion,
      delete: deleteProjectFile,
      discloseExternalMove,
      acquireExternalMove,
      releaseExternalMove,
      moveExternal,
    },
    documentReview: {
      activate: restoreDocumentReview,
      save: saveDocumentReview,
      revalidate: revalidateDocumentReview,
    },
    getProjectState: () => projectState(),
    getRegisteredWorkspaceRoot: (candidate: typeof root) =>
      candidate.path === root.path && candidate.hostId === root.hostId ? root : undefined,
    getProject: () => ({ root, host: projectHost }),
    getHost: (hostId: string) => (hostId === root.hostId ? projectHost : undefined),
    revealLocalEntry,
  } as unknown as IpcDeps
  const transport = new FakeIpcMain()
  return {
    deps,
    transport,
    currentIpcOwner,
    assertCurrent,
    createProjectFile,
    organizeProjectFile,
    discloseDeletion,
    deleteProjectFile,
    discloseExternalMove,
    acquireExternalMove,
    releaseExternalMove,
    moveExternal,
    restoreDocumentReview,
    saveDocumentReview,
    revalidateDocumentReview,
    stat,
    revealLocalEntry,
    recordIpcContractDiagnostic,
  }
}

function ipcEvent(mainFrame = true): Electron.IpcMainInvokeEvent {
  const frame = {}
  const sender = {
    id: owner.id,
    mainFrame: frame,
    isDestroyed: () => false,
    send: vi.fn(),
  }
  return {
    sender,
    senderFrame: mainFrame ? frame : {},
  } as unknown as Electron.IpcMainInvokeEvent
}

function ipcSendEvent(mainFrame = true): Electron.IpcMainEvent {
  return ipcEvent(mainFrame) as unknown as Electron.IpcMainEvent
}

describe('IpcAuthorityRouter', () => {
  it('keeps declared and effectively registered channel manifests identical', () => {
    const { deps, transport } = fixture()
    const router = registerIpcHandlers(deps, transport)
    const manifest = router.effectiveManifest()

    expect(new Set(manifest.invoke)).toEqual(new Set(INVOKE_CHANNELS))
    expect(new Set(manifest.send)).toEqual(new Set(SEND_CHANNELS))
    expect(new Set(manifest.event)).toEqual(new Set(EVENT_CHANNELS))
    expect(
      [...transport.invokes.values()].every((listeners) => listeners.length === 1),
    ).toBe(true)
    expect(
      [...transport.sends.values()].every((listeners) => listeners.length === 1),
    ).toBe(true)
  })

  it('qualifies document review restore and revalidation to the exact active workspace', async () => {
    const { deps, transport, restoreDocumentReview, revalidateDocumentReview } = fixture()
    registerIpcHandlers(deps, transport)
    const workspace = { id: 'workspace-1', root }
    const document = localPath('/project/docs/review.md')

    await expect(
      transport.invokes.get('document-review:restore')?.[0]?.(ipcEvent(), { workspace }),
    ).resolves.toMatchObject({
      ok: true,
      value: { workspaceGeneration: 4, model: { workspace } },
    })
    expect(restoreDocumentReview).toHaveBeenCalledWith(
      owner,
      workspace,
      expect.objectContaining({ hostId: root.hostId }),
    )

    await expect(
      transport.invokes.get('document-review:revalidate')?.[0]?.(ipcEvent(), {
        workspace,
        workspaceGeneration: 4,
        document,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: 'stale', document, reason: 'deleted' },
    })
    expect(revalidateDocumentReview).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ workspace, document }),
      document,
    )
  })

  it('rejects document review state from another worktree before its effect owner', async () => {
    const { deps, transport, restoreDocumentReview } = fixture()
    registerIpcHandlers(deps, transport)

    await expect(
      transport.invokes.get('document-review:restore')?.[0]?.(ipcEvent(), {
        workspace: { id: 'workspace-other', root },
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Document review belongs to another workspace identity',
    })
    expect(restoreDocumentReview).not.toHaveBeenCalled()
  })

  it('puts every invoke and send handler behind main-frame validation', () => {
    const { deps, transport, recordIpcContractDiagnostic } = fixture()
    registerIpcHandlers(deps, transport)
    const invalid = ipcEvent(false)

    for (const listeners of transport.invokes.values()) {
      expect(() => listeners[0]!(invalid, undefined)).toThrow(
        'IPC is available only to the workbench main frame',
      )
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const listeners of transport.sends.values()) {
      expect(() => listeners[0]!(ipcSendEvent(false), undefined)).not.toThrow()
    }
    expect(warn).toHaveBeenCalledTimes(SEND_CHANNELS.length)
    expect(recordIpcContractDiagnostic).toHaveBeenCalledTimes(
      INVOKE_CHANNELS.length + SEND_CHANNELS.length,
    )
    for (const [diagnostic] of recordIpcContractDiagnostic.mock.calls) {
      expect([...INVOKE_CHANNELS, ...SEND_CHANNELS]).toContain(diagnostic.channel)
      expect(diagnostic.outcome).toBe('non-main-frame')
      expect(['under-1ms', 'under-10ms', '10ms-or-more']).toContain(diagnostic.timing)
    }
    warn.mockRestore()
  })

  it('records revoked-owner rejection without request, error, or payload content', () => {
    const { deps, transport, assertCurrent, recordIpcContractDiagnostic } = fixture()
    assertCurrent.mockImplementationOnce(() => {
      throw new Error('/secret/project TOKEN=hvir-private')
    })
    const router = new IpcAuthorityRouter(deps, transport)
    router.handle('pty:start', (_request, context) => {
      context.owner()
      return undefined as never
    })

    expect(() =>
      transport.invokes.get('pty:start')?.[0]?.(ipcEvent(), {
        terminalInput: '/secret/project TOKEN=hvir-private',
      }),
    ).toThrow('TOKEN=hvir-private')
    expect(recordIpcContractDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'pty:start', outcome: 'renderer-revoked' }),
    )
    expect(JSON.stringify(recordIpcContractDiagnostic.mock.calls)).not.toMatch(
      /secret|TOKEN|terminalInput/,
    )
  })

  it('centrally validates current owner generation for every owner-scoped channel', () => {
    const { deps, transport, currentIpcOwner, assertCurrent } = fixture()
    const router = new IpcAuthorityRouter(deps, transport)
    for (const channel of OWNER_SCOPED_INVOKE_CHANNELS) {
      router.handle(channel, (_request, context) => {
        context.owner()
        return undefined
      })
    }
    for (const channel of OWNER_SCOPED_SEND_CHANNELS) {
      router.handleSend(channel, (_payload, context) => {
        context.owner()
      })
    }
    const event = ipcEvent()

    for (const channel of OWNER_SCOPED_INVOKE_CHANNELS) {
      transport.invokes.get(channel)?.[0]?.(event, undefined)
    }
    for (const channel of OWNER_SCOPED_SEND_CHANNELS) {
      transport.sends.get(channel)?.[0]?.(ipcSendEvent(), undefined)
    }

    const total = OWNER_SCOPED_INVOKE_CHANNELS.length + OWNER_SCOPED_SEND_CHANNELS.length
    expect(currentIpcOwner).toHaveBeenCalledTimes(total)
    expect(assertCurrent).toHaveBeenCalledTimes(total)
    expect(assertCurrent).toHaveBeenCalledWith(owner)
  })

  it('reads the native file clipboard only for a current renderer owner', () => {
    const { deps, transport, currentIpcOwner, assertCurrent } = fixture()
    const read = vi.fn(() => '/home/user/Downloads/requirements.txt')
    const router = new IpcAuthorityRouter(deps, transport)
    router.handle('terminal:resolve-file-clipboard', (_request, context) => {
      context.owner()
      return read()
    })

    expect(
      transport.invokes.get('terminal:resolve-file-clipboard')?.[0]?.(ipcEvent(), {}),
    ).toBe('/home/user/Downloads/requirements.txt')
    expect(read).toHaveBeenCalledTimes(1)
    expect(currentIpcOwner).toHaveBeenCalledTimes(1)
    expect(assertCurrent).toHaveBeenCalledExactlyOnceWith(owner)
  })

  it('rejects duplicate registration and removes every handler on dispose', () => {
    const { deps, transport } = fixture()
    const router = registerIpcHandlers(deps, transport)

    expect(() => router.handle('app:info', () => undefined as never)).toThrow(
      'already registered',
    )
    router.dispose()

    expect(new Set(transport.removedInvokes)).toEqual(new Set(INVOKE_CHANNELS))
    expect(new Set(transport.removedSends)).toEqual(new Set(SEND_CHANNELS))
    expect(transport.invokes.size).toBe(0)
    expect(transport.sends.size).toBe(0)
  })

  it('keeps the reviewed owner and authority channel policies explicit', () => {
    expect(new Set(OWNER_SCOPED_INVOKE_CHANNELS)).toEqual(
      new Set<IpcInvokeChannel>([
        'workbench-health:acknowledge',
        'diagnostic-evidence:get',
        'diagnostic-evidence:delete',
        'project:connect-host',
        'project:browse-host',
        'project:folder-picker-start',
        'project:folder-picker-browse',
        'project:folder-picker-create-directory',
        'project:folder-picker-close',
        'project:open',
        'document-review:restore',
        'document-review:save',
        'document-review:revalidate',
        'document-review:delivery-destinations',
        'document-review:preview-delivery',
        'document-review:prepare-delivery',
        'document-review:insert-delivery',
        'document-review:send-now-delivery',
        'ssh:prompt-response',
        'fs:filename-search',
        'fs:reveal-entry',
        'fs:create-entry',
        'fs:acquire-clipboard-files',
        'fs:acquire-dropped-files',
        'fs:copy-external',
        'fs:external-move-disclosure',
        'fs:acquire-external-move-files',
        'fs:release-external-move-grant',
        'fs:move-external',
        'fs:organize-entry',
        'fs:deletion-disclosure',
        'fs:delete-entry',
        'fs:cancel-file-operation',
        'html-preview:create',
        'web-pane:open',
        'web-pane:close',
        'web-pane:open-external',
        'web-pane:open-browser',
        'terminal:plan-move',
        'terminal:move',
        'terminal:record-recovery-decision',
        'terminal:resolve-file-clipboard',
        'pty:start',
        'sessions:observe',
        'sessions:snapshot',
        'sessions:release',
        'sessions:usage-observe',
        'sessions:usage-snapshot',
        'sessions:usage-release',
        'sessions:open',
        'sessions:resolve-terminal',
        'diagnostic-report:create',
        'diagnostic-report:capture',
        'diagnostic-report:copy',
        'diagnostic-report:save',
        'diagnostic-report:cancel',
        'diagnostic-report:delete',
      ]),
    )
    expect(new Set(OWNER_SCOPED_SEND_CHANNELS)).toEqual(
      new Set<IpcSendChannel>(SEND_CHANNELS),
    )
    expect(new Set(AUTHORITY_SCOPED_INVOKE_CHANNELS)).toEqual(
      new Set<IpcInvokeChannel>([
        'project:watch-interests',
        'document-review:restore',
        'document-review:save',
        'document-review:revalidate',
        'document-review:delivery-destinations',
        'document-review:preview-delivery',
        'document-review:prepare-delivery',
        'fs:readdir',
        'fs:filename-search',
        'fs:resolve-entry',
        'fs:reveal-entry',
        'fs:read',
        'fs:read-asset',
        'fs:write',
        'fs:create-entry',
        'fs:copy-external',
        'fs:move-external',
        'fs:organize-entry',
        'fs:deletion-disclosure',
        'fs:delete-entry',
        'git:diff-inputs',
        'git:changes',
        'git:history',
        'git:ignored-entries',
        'git:commit-detail',
        'git:blame',
        'git:branches',
        'git:fetch',
        'git:pull',
        'git:switch-branch',
        'html-preview:create',
        'harness:profiles',
        'harness:probe-snapshot',
        'harness:probe-profiles',
        'harness:probe-templates',
        'harness:profile-materialize',
        'harness:profile-save',
        'harness:preview',
        'harness:authorize-path',
        'terminal:recovery',
        'terminal:record-recovery-decision',
        'terminal:update-layout',
        'terminal:forget',
        'terminal:rebind-profile',
        'pty:start',
        'web-pane:open',
      ]),
    )
  })

  it('keeps feature registrars free of direct IPC and canonicalization primitives', async () => {
    const featureDirectory = join(process.cwd(), 'src/main/ipc/features')
    const features = [
      'app.ts',
      'filesystem.ts',
      'git.ts',
      'harness.ts',
      'preview.ts',
      'project.ts',
      'terminal.ts',
      'web-pane.ts',
      'diagnostic-report.ts',
      'document-review.ts',
      'image-paste.ts',
      'clipboard.ts',
      'terminal-file-paste.ts',
      'sessions.ts',
    ]
    const source = (
      await Promise.all(
        features.map((feature) => readFile(join(featureDirectory, feature), 'utf8')),
      )
    ).join('\n')

    expect(source).not.toMatch(/\bipcMain\b/)
    expect(source).not.toMatch(/\.currentOwner\(/)
    expect(source).not.toMatch(/\.realpath\(/)
    expect(source).not.toMatch(/getRegisteredWorkspaceRoot/)
    for (const channel of AUTHORITY_SCOPED_INVOKE_CHANNELS) {
      expect(registrationBlock(source, 'handle', channel)).toMatch(/ipc\.authority\./)
    }
    for (const channel of OWNER_SCOPED_INVOKE_CHANNELS) {
      expect(registrationBlock(source, 'handle', channel)).toMatch(/\.owner\(\)/)
    }
    for (const channel of OWNER_SCOPED_SEND_CHANNELS) {
      expect(registrationBlock(source, 'handleSend', channel)).toMatch(/\.owner\(\)/)
    }
  })

  it('reconstructs normalized create-entry paths and qualifies the exact owner', async () => {
    const { deps, transport, createProjectFile } = fixture()
    registerIpcHandlers(deps, transport)

    const response = await transport.invokes.get('fs:create-entry')?.[0]?.(ipcEvent(), {
      workspaceRoot: { hostId: 'local', path: '/project' },
      destinationDirectory: { hostId: 'local', path: '/project/src' },
      name: 'new-file.ts',
      kind: 'file',
    })

    expect(response).toEqual({
      ok: true,
      value: {
        outcome: 'completed',
        operationId: 'operation-1',
        generation: 1,
        items: [],
      },
    })
    expect(createProjectFile).toHaveBeenCalledWith({
      owner,
      workspaceRoot: localPath('/project'),
      destinationDirectory: localPath('/project/src'),
      name: 'new-file.ts',
      kind: 'file',
    })
  })

  it.each(['file', 'dir', 'symlink'] as const)(
    'reveals one exact registered local %s through the native adapter',
    async (type) => {
      const { deps, transport, stat, revealLocalEntry } = fixture()
      stat.mockResolvedValue({ type, size: 0, mtimeMs: 0, mode: 0o644 })
      registerIpcHandlers(deps, transport)

      await expect(
        transport.invokes.get('fs:reveal-entry')?.[0]?.(ipcEvent(), {
          workspaceRoot: { hostId: 'local', path: '/project' },
          path: { hostId: 'local', path: '/project/src/link.txt' },
        }),
      ).resolves.toEqual({ ok: true, value: undefined })
      expect(revealLocalEntry).toHaveBeenCalledWith(localPath('/project/src/link.txt'))
    },
  )

  it('rejects stale, SSH, outside, and unsupported reveal targets before the adapter', async () => {
    const { deps, transport, revealLocalEntry } = fixture()
    registerIpcHandlers(deps, transport)
    const invoke = transport.invokes.get('fs:reveal-entry')?.[0]

    await expect(
      invoke?.(ipcEvent(), {
        workspaceRoot: { hostId: 'local', path: '/project' },
        path: { hostId: 'local', path: '/outside/file.txt' },
      }),
    ).resolves.toEqual({ ok: false, error: 'Path escapes the project root' })

    const sshRoot = { hostId: 'ssh:example', path: '/project' }
    vi.spyOn(deps, 'getRegisteredWorkspaceRoot').mockReturnValue(sshRoot as typeof root)
    await expect(
      invoke?.(ipcEvent(), { workspaceRoot: sshRoot, path: sshRoot }),
    ).resolves.toEqual({
      ok: false,
      error: 'Only local workspace entries can be revealed',
    })

    vi.spyOn(deps, 'getRegisteredWorkspaceRoot').mockReturnValue(root)
    vi.spyOn(deps, 'getProjectState').mockReturnValue({
      ...projectState(),
      projects: [
        {
          ...projectState().projects[0]!,
          workspaces: [{ ...projectState().projects[0]!.workspaces[0]!, missing: true }],
        },
      ],
    })
    await expect(
      invoke?.(ipcEvent(), { workspaceRoot: root, path: root }),
    ).resolves.toEqual({ ok: false, error: 'Workspace is no longer available' })

    vi.restoreAllMocks()
    const unsupported = fixture()
    unsupported.stat.mockResolvedValue({
      type: 'other',
      size: 0,
      mtimeMs: 0,
      mode: 0,
    })
    registerIpcHandlers(unsupported.deps, unsupported.transport)
    await expect(
      unsupported.transport.invokes.get('fs:reveal-entry')?.[0]?.(ipcEvent(), {
        workspaceRoot: root,
        path: root,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Only files, folders, and symbolic links can be revealed',
    })
    expect(revealLocalEntry).not.toHaveBeenCalled()
    expect(unsupported.revealLocalEntry).not.toHaveBeenCalled()
  })

  it('rejects an unnormalized create-entry path before the effect owner', async () => {
    const { deps, transport, createProjectFile } = fixture()
    registerIpcHandlers(deps, transport)
    const invoke = transport.invokes.get('fs:create-entry')?.[0]

    await expect(
      invoke?.(ipcEvent(), {
        workspaceRoot: { hostId: 'local', path: '/project' },
        destinationDirectory: { hostId: 'local', path: '/project/src/../src' },
        name: 'new-file.ts',
        kind: 'file',
      }),
    ).resolves.toEqual({ ok: false, error: 'Project paths must already be normalized' })
    expect(createProjectFile).not.toHaveBeenCalled()
  })

  it('reconstructs an exact organization request and qualifies progress to its sender', async () => {
    const { deps, transport, organizeProjectFile } = fixture()
    registerIpcHandlers(deps, transport)
    const event = ipcEvent()
    const send = vi.spyOn(event.sender, 'send')

    const response = await transport.invokes.get('fs:organize-entry')?.[0]?.(event, {
      action: 'duplicate',
      workspaceRoot: { hostId: 'local', path: '/project' },
      source: { hostId: 'local', path: '/project/src/source.ts' },
      destinationDirectory: { hostId: 'local', path: '/project/copies' },
      name: 'exact copy.ts',
    })

    expect(response).toEqual({
      ok: true,
      value: {
        outcome: 'started',
        operationId: 'organize-1',
        generation: 2,
        itemCount: 1,
      },
    })
    expect(organizeProjectFile).toHaveBeenCalledOnce()
    const organization = organizeProjectFile.mock.calls[0]?.[0]
    expect(organization).toMatchObject({
      owner,
      request: {
        action: 'duplicate',
        workspaceRoot: localPath('/project'),
        source: localPath('/project/src/source.ts'),
        destinationDirectory: localPath('/project/copies'),
        name: 'exact copy.ts',
      },
    })
    expect(typeof organization?.publish).toBe('function')
    const progress = {
      workspaceRoot: root,
      operationId: 'organize-1',
      generation: 2,
      phase: 'moving' as const,
      completedItems: 0,
      totalItems: 1,
    }
    organization?.publish(progress)
    expect(send).toHaveBeenCalledWith('fs:project-file-operation', {
      ...progress,
    })
  })

  it('rejects hostile organization discriminants and paths before the coordinator', async () => {
    const { deps, transport, organizeProjectFile } = fixture()
    registerIpcHandlers(deps, transport)
    const invoke = transport.invokes.get('fs:organize-entry')?.[0]

    await expect(
      invoke?.(ipcEvent(), {
        action: 'erase',
        workspaceRoot: { hostId: 'local', path: '/project' },
        source: { hostId: 'local', path: '/project/source.ts' },
      }),
    ).resolves.toEqual({ ok: false, error: 'Invalid project entry action' })
    await expect(
      invoke?.(ipcEvent(), {
        action: 'move',
        workspaceRoot: { hostId: 'local', path: '/project' },
        source: { hostId: 'local', path: '/project/src/../source.ts' },
        destinationDirectory: { hostId: 'local', path: '/project/copies' },
      }),
    ).resolves.toEqual({ ok: false, error: 'Project paths must already be normalized' })
    expect(organizeProjectFile).not.toHaveBeenCalled()
  })

  it('reconstructs exact deletion disclosure and confirmed deletion requests', async () => {
    const { deps, transport, discloseDeletion, deleteProjectFile } = fixture()
    registerIpcHandlers(deps, transport)
    const event = ipcEvent()
    const send = vi.spyOn(event.sender, 'send')
    const request = {
      workspaceRoot: { hostId: 'local', path: '/project' },
      source: { hostId: 'local', path: '/project/source.ts' },
    }

    await transport.invokes.get('fs:deletion-disclosure')?.[0]?.(event, request)
    expect(discloseDeletion).toHaveBeenCalledWith(
      owner,
      localPath('/project'),
      localPath('/project/source.ts'),
    )

    await transport.invokes.get('fs:delete-entry')?.[0]?.(event, {
      ...request,
      confirmedRecovery: 'recoverable',
    })
    expect(deleteProjectFile).toHaveBeenCalledOnce()
    const deletion = deleteProjectFile.mock.calls[0]?.[0]
    expect(deletion).toMatchObject({
      owner,
      request: {
        workspaceRoot: localPath('/project'),
        source: localPath('/project/source.ts'),
        confirmedRecovery: 'recoverable',
      },
    })
    const progress = {
      workspaceRoot: root,
      operationId: 'delete-1',
      generation: 3,
      phase: 'deleting' as const,
      completedItems: 0,
      totalItems: 1,
    }
    deletion?.publish(progress)
    expect(send).toHaveBeenCalledWith('fs:project-file-operation', progress)
  })

  it('keeps native move acquisition owner-scoped and reconstructs only destination authority', async () => {
    const {
      deps,
      transport,
      discloseExternalMove,
      acquireExternalMove,
      releaseExternalMove,
      moveExternal,
    } = fixture()
    registerIpcHandlers(deps, transport)
    const event = ipcEvent()

    await transport.invokes.get('fs:external-move-disclosure')?.[0]?.(event, undefined)
    await transport.invokes.get('fs:acquire-external-move-files')?.[0]?.(event, {
      selection: 'files',
    })
    expect(discloseExternalMove).toHaveBeenCalledWith(owner)
    expect(acquireExternalMove).toHaveBeenCalledWith(owner, 'files')
    await transport.invokes.get('fs:release-external-move-grant')?.[0]?.(event, {
      grantId: 'opaque-grant',
      grantGeneration: 8,
    })
    expect(releaseExternalMove).toHaveBeenCalledWith(owner, 'opaque-grant', 8)

    await transport.invokes.get('fs:move-external')?.[0]?.(event, {
      workspaceRoot: { hostId: 'local', path: '/project' },
      destinationDirectory: { hostId: 'local', path: '/project/imports' },
      grantId: 'opaque-grant',
      grantGeneration: 8,
    })
    expect(moveExternal).toHaveBeenCalledOnce()
    expect(moveExternal.mock.calls[0]?.[0]).toMatchObject({
      owner,
      workspaceRoot: localPath('/project'),
      destinationDirectory: localPath('/project/imports'),
      grantId: 'opaque-grant',
      grantGeneration: 8,
    })
  })
})

function registrationBlock(
  source: string,
  method: 'handle' | 'handleSend',
  channel: string,
): string {
  const marker = `ipc.${method}('${channel}'`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`Missing ${method} registration for ${channel}`)
  const candidates = [
    source.indexOf('\n  ipc.handle(', start + marker.length),
    source.indexOf('\n  ipc.handleSend(', start + marker.length),
  ].filter((index) => index >= 0)
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length
  return source.slice(start, end)
}

describe('IpcAuthority', () => {
  it('requires exact registered workspace identity and rejects canonical escapes', async () => {
    const canonicalRoot = localPath('/canonical/project')
    const host = {
      hostId: root.hostId,
      realpath: vi.fn((candidate: typeof root) =>
        Promise.resolve(
          candidate.path === root.path
            ? canonicalRoot
            : localPath('/canonical/outside/file.txt'),
        ),
      ),
    } as unknown as ProjectHost
    const authority = new IpcAuthority({
      getProject: () => ({ host, root }),
      getProjectState: () => projectState(),
      getRegisteredWorkspaceRoot: (candidate) =>
        candidate.path === root.path && candidate.hostId === root.hostId
          ? root
          : undefined,
    })

    expect(authority.workspaceRoot(root)).toEqual(root)
    expect(() => authority.workspaceRoot(localPath('/project/nested'))).toThrow(
      'another project',
    )
    await expect(
      authority.projectPath(localPath('/project/file.txt'), root, host),
    ).rejects.toThrow('through a symlink')
  })
})
