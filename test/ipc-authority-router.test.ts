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
  const currentOwner = vi.fn(() => owner)
  const assertCurrent = vi.fn()
  const rendererResources = {
    currentOwner,
    assertCurrent,
  } as unknown as RendererResourceScopes
  const recordIpcContractDiagnostic = vi.fn<(event: IpcContractDiagnostic) => void>()
  const deps = {
    rendererResources,
    recordIpcContractDiagnostic,
    getProjectState: () => projectState(),
    getRegisteredWorkspaceRoot: (candidate: typeof root) =>
      candidate.path === root.path && candidate.hostId === root.hostId ? root : undefined,
    getProject: () => ({
      root,
      host: {
        hostId: root.hostId,
        connectionState: 'connected',
        watchTier: 'native',
      } as unknown as ProjectHost,
    }),
  } as unknown as IpcDeps
  const transport = new FakeIpcMain()
  return {
    deps,
    transport,
    currentOwner,
    assertCurrent,
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
    const { deps, transport, currentOwner, assertCurrent } = fixture()
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
    expect(currentOwner).toHaveBeenCalledTimes(total)
    expect(assertCurrent).toHaveBeenCalledTimes(total)
    expect(assertCurrent).toHaveBeenCalledWith(owner)
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
        'responsiveness-diagnostics:get',
        'responsiveness-diagnostics:start',
        'responsiveness-diagnostics:stop',
        'responsiveness-diagnostics:delete',
        'project:connect-host',
        'project:browse-host',
        'project:open',
        'ssh:prompt-response',
        'html-preview:create',
        'web-pane:open',
        'web-pane:close',
        'web-pane:open-external',
        'web-pane:open-browser',
        'terminal:plan-move',
        'terminal:move',
        'pty:start',
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
        'fs:readdir',
        'fs:resolve-entry',
        'fs:read',
        'fs:read-asset',
        'fs:write',
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
        'harness:probe-profiles',
        'harness:probe-templates',
        'harness:profile-materialize',
        'harness:profile-save',
        'harness:acknowledge-risk',
        'harness:preview',
        'harness:authorize-path',
        'terminal:recovery',
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
