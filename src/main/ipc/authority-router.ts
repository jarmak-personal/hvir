import { ipcMain } from 'electron'

import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  asHostId,
  dirnameHostPath,
  hostPath,
  hostPathEquals,
  type HostPath,
  type IpcEventChannel,
  type IpcInvokeChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcSendChannel,
  type IpcSendPayload,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { IpcDeps } from './deps'

export const OWNER_SCOPED_INVOKE_CHANNELS = [
  'workbench-health:acknowledge',
  'diagnostic-report:create',
  'diagnostic-report:capture',
  'diagnostic-report:copy',
  'diagnostic-report:save',
  'diagnostic-report:cancel',
  'diagnostic-report:delete',
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
] as const satisfies readonly IpcInvokeChannel[]

export const OWNER_SCOPED_SEND_CHANNELS = SEND_CHANNELS

export const AUTHORITY_SCOPED_INVOKE_CHANNELS = [
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
] as const satisfies readonly IpcInvokeChannel[]

export interface IpcInvokeContext {
  readonly sender: Electron.WebContents
  readonly authority: IpcAuthority
  owner(): RendererOwner
}

export interface IpcSendContext {
  readonly sender: Electron.WebContents
  readonly authority: IpcAuthority
  owner(): RendererOwner
}

export interface IpcContractDiagnostic {
  readonly channel: IpcInvokeChannel | IpcSendChannel
  readonly outcome: 'non-main-frame' | 'renderer-revoked'
  readonly timing: 'under-1ms' | 'under-10ms' | '10ms-or-more'
}

export type IpcInvokeHandler<C extends IpcInvokeChannel> = (
  req: IpcRequest<C>,
  context: IpcInvokeContext,
) => IpcResponse<C> | Promise<IpcResponse<C>>

export type IpcSendHandler<C extends IpcSendChannel> = (
  payload: IpcSendPayload<C>,
  context: IpcSendContext,
) => void

/** Narrow capability given to feature registrars; transport and lifecycle stay private. */
export interface IpcRegistrar {
  readonly authority: IpcAuthority
  handle<C extends IpcInvokeChannel>(channel: C, handler: IpcInvokeHandler<C>): void
  handleSend<C extends IpcSendChannel>(channel: C, handler: IpcSendHandler<C>): void
}

export interface IpcMainRegistrationPort {
  handle(
    channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, request: unknown) => unknown,
  ): void
  removeHandler(channel: string): void
  on(
    channel: string,
    listener: (event: Electron.IpcMainEvent, payload: unknown) => void,
  ): unknown
  removeListener(
    channel: string,
    listener: (event: Electron.IpcMainEvent, payload: unknown) => void,
  ): unknown
}

const electronIpcMainPort = ipcMain as unknown as IpcMainRegistrationPort

export interface EffectiveIpcManifest {
  readonly invoke: readonly IpcInvokeChannel[]
  readonly send: readonly IpcSendChannel[]
  readonly event: readonly IpcEventChannel[]
}

export class IpcAuthorityRouter {
  readonly authority: IpcAuthority
  private readonly invokeChannels = new Set<IpcInvokeChannel>()
  private readonly sendChannels = new Set<IpcSendChannel>()
  private readonly sendListeners = new Map<
    IpcSendChannel,
    (event: Electron.IpcMainEvent, payload: unknown) => void
  >()
  private disposed = false

  constructor(
    private readonly deps: Pick<
      IpcDeps,
      | 'getProject'
      | 'getProjectState'
      | 'getRegisteredWorkspaceRoot'
      | 'rendererResources'
      | 'recordIpcContractDiagnostic'
    >,
    private readonly transport: IpcMainRegistrationPort = electronIpcMainPort,
  ) {
    this.authority = new IpcAuthority(deps)
  }

  handle<C extends IpcInvokeChannel>(channel: C, handler: IpcInvokeHandler<C>): void {
    this.assertCanRegister(channel, this.invokeChannels, 'invoke')
    this.invokeChannels.add(channel)
    const ownerScoped = includes(OWNER_SCOPED_INVOKE_CHANNELS, channel)
    this.transport.handle(channel, (event, request) => {
      const startedAt = performance.now()
      try {
        assertMainFrame(event)
      } catch (error) {
        this.reportDiagnostic(channel, 'non-main-frame', startedAt)
        throw error
      }
      return handler(
        request as IpcRequest<C>,
        this.context(event.sender, ownerScoped, channel, startedAt),
      )
    })
  }

  handleSend<C extends IpcSendChannel>(channel: C, handler: IpcSendHandler<C>): void {
    this.assertCanRegister(channel, this.sendChannels, 'send')
    this.sendChannels.add(channel)
    const ownerScoped = includes(OWNER_SCOPED_SEND_CHANNELS, channel)
    const listener = (event: Electron.IpcMainEvent, payload: unknown): void => {
      const startedAt = performance.now()
      try {
        assertMainFrame(event)
      } catch (reason) {
        this.reportDiagnostic(channel, 'non-main-frame', startedAt)
        console.warn(
          `[ipc] ignored invalid ${channel} message: ${reason instanceof Error ? reason.message : String(reason)}`,
        )
        return
      }
      try {
        handler(
          payload as IpcSendPayload<C>,
          this.context(event.sender, ownerScoped, channel, startedAt),
        )
      } catch (reason) {
        console.warn(
          `[ipc] ignored invalid ${channel} message: ${reason instanceof Error ? reason.message : String(reason)}`,
        )
      }
    }
    this.sendListeners.set(channel, listener)
    this.transport.on(channel, listener)
  }

  assertComplete(): void {
    assertExactChannels('invoke', INVOKE_CHANNELS, this.invokeChannels)
    assertExactChannels('send', SEND_CHANNELS, this.sendChannels)
  }

  effectiveManifest(): EffectiveIpcManifest {
    return {
      invoke: [...this.invokeChannels],
      send: [...this.sendChannels],
      event: EVENT_CHANNELS,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const channel of this.invokeChannels) this.transport.removeHandler(channel)
    for (const [channel, listener] of this.sendListeners) {
      this.transport.removeListener(channel, listener)
    }
    this.invokeChannels.clear()
    this.sendChannels.clear()
    this.sendListeners.clear()
  }

  private context(
    sender: Electron.WebContents,
    ownerScoped: boolean,
    channel: IpcInvokeChannel | IpcSendChannel,
    startedAt: number,
  ): IpcInvokeContext & IpcSendContext {
    let owner: RendererOwner | undefined
    return {
      sender,
      authority: this.authority,
      owner: () => {
        if (!ownerScoped) throw new Error('IPC channel is not owner-scoped')
        try {
          owner ??= this.deps.rendererResources.currentOwner(sender.id)
          this.deps.rendererResources.assertCurrent(owner)
          return owner
        } catch (error) {
          this.reportDiagnostic(channel, 'renderer-revoked', startedAt)
          throw error
        }
      },
    }
  }

  private reportDiagnostic(
    channel: IpcContractDiagnostic['channel'],
    outcome: IpcContractDiagnostic['outcome'],
    startedAt: number,
  ): void {
    try {
      this.deps.recordIpcContractDiagnostic({
        channel,
        outcome,
        timing: timingBucket(performance.now() - startedAt),
      })
    } catch {
      // Diagnostics is a droppable observer and never owns IPC behavior.
    }
  }

  private assertCanRegister<C extends IpcInvokeChannel | IpcSendChannel>(
    channel: C,
    registered: ReadonlySet<C>,
    direction: 'invoke' | 'send',
  ): void {
    if (this.disposed) throw new Error('IPC authority router is disposed')
    const declared = direction === 'invoke' ? INVOKE_CHANNELS : SEND_CHANNELS
    if (!(declared as readonly string[]).includes(channel)) {
      throw new Error(`Cannot register undeclared ${direction} channel '${channel}'`)
    }
    if (registered.has(channel)) {
      throw new Error(`IPC ${direction} channel '${channel}' is already registered`)
    }
  }
}

function timingBucket(elapsedMs: number): IpcContractDiagnostic['timing'] {
  if (elapsedMs < 1) return 'under-1ms'
  if (elapsedMs < 10) return 'under-10ms'
  return '10ms-or-more'
}

export class IpcAuthority {
  private readonly canonicalRoots = new WeakMap<
    ProjectHost,
    Map<string, Promise<HostPath>>
  >()

  constructor(
    private readonly deps: Pick<
      IpcDeps,
      'getProject' | 'getProjectState' | 'getRegisteredWorkspaceRoot'
    >,
  ) {}

  workspaceRoot(candidate: HostPath): HostPath {
    if (
      !candidate ||
      typeof candidate.hostId !== 'string' ||
      typeof candidate.path !== 'string'
    ) {
      throw new Error('Terminal session belongs to another project')
    }
    const decoded = hostPath(asHostId(candidate.hostId), candidate.path)
    const root = this.deps.getRegisteredWorkspaceRoot(decoded)
    if (!root || !hostPathEquals(decoded, root)) {
      throw new Error('Terminal session belongs to another project')
    }
    return root
  }

  projectRoot(workspaceRoot: HostPath): HostPath {
    const project = this.deps
      .getProjectState()
      .projects.find((candidate) =>
        candidate.workspaces.some((workspace) =>
          hostPathEquals(workspace.root, workspaceRoot),
        ),
      )
    if (!project) throw new Error('Workspace does not belong to a registered project')
    return project.registeredRoot
  }

  worktreeRoots(root: HostPath): readonly HostPath[] {
    const project = this.deps
      .getProjectState()
      .projects.find((candidate) =>
        candidate.workspaces.some((workspace) => hostPathEquals(workspace.root, root)),
      )
    return (
      project?.workspaces
        .filter((workspace) => !workspace.missing)
        .map((workspace) => workspace.root) ?? []
    )
  }

  activeProject(): { readonly host: ProjectHost; readonly root: HostPath } {
    return this.deps.getProject()
  }

  assertActiveWorkspace(candidate: HostPath): HostPath {
    const active = this.deps.getProject().root
    if (!hostPathEquals(candidate, active)) {
      throw new Error('Watch interests do not belong to the active workspace')
    }
    return active
  }

  async canonicalHostPath(
    candidate: HostPath,
    expectedHostId: string,
    host: ProjectHost,
  ): Promise<HostPath> {
    if (
      !candidate ||
      typeof candidate.hostId !== 'string' ||
      typeof candidate.path !== 'string' ||
      candidate.hostId !== expectedHostId ||
      !candidate.path.startsWith('/')
    ) {
      throw new Error('Invalid host-qualified harness path')
    }
    return host.realpath(hostPath(asHostId(candidate.hostId), candidate.path))
  }

  /** Rebuild the opaque path at the IPC trust boundary and keep it in-project. */
  async projectPath(
    candidate: HostPath,
    root?: HostPath,
    host?: ProjectHost,
    options: {
      readonly allowMissingLeaf?: boolean
      readonly returnCanonical?: boolean
    } = {},
  ): Promise<HostPath> {
    const active = this.deps.getProject()
    const projectRoot = root ?? active.root
    const projectHost = host ?? active.host
    if (
      !candidate ||
      typeof candidate.path !== 'string' ||
      typeof candidate.hostId !== 'string'
    ) {
      throw new Error('Invalid host-qualified path')
    }
    const decoded = hostPath(asHostId(candidate.hostId), candidate.path)
    if (decoded.hostId !== projectRoot.hostId) {
      throw new Error('Path belongs to another host')
    }
    const prefix = projectRoot.path === '/' ? '/' : `${projectRoot.path}/`
    if (decoded.path !== projectRoot.path && !decoded.path.startsWith(prefix)) {
      throw new Error('Path escapes the project root')
    }
    let roots = this.canonicalRoots.get(projectHost)
    if (!roots) {
      roots = new Map()
      this.canonicalRoots.set(projectHost, roots)
    }
    const rootKey = `${projectRoot.hostId}:${projectRoot.path}`
    let canonicalRootPromise = roots.get(rootKey)
    if (!canonicalRootPromise) {
      canonicalRootPromise = projectHost.realpath(projectRoot)
      roots.set(rootKey, canonicalRootPromise)
      void canonicalRootPromise.catch(() => roots?.delete(rootKey))
    }
    const canonicalRoot = await canonicalRootPromise
    let canonicalPath: HostPath
    try {
      canonicalPath = await projectHost.realpath(decoded)
    } catch (reason) {
      if (!options.allowMissingLeaf || !isMissingPathError(reason)) throw reason
      let ancestor = dirnameHostPath(decoded)
      for (;;) {
        try {
          canonicalPath = await projectHost.realpath(ancestor)
          break
        } catch (ancestorReason) {
          if (!isMissingPathError(ancestorReason) || ancestor.path === projectRoot.path) {
            throw ancestorReason
          }
          const parent = dirnameHostPath(ancestor)
          if (parent.path === ancestor.path || !isLexicallyInside(parent, projectRoot)) {
            throw reason
          }
          ancestor = parent
        }
      }
    }
    const canonicalPrefix = canonicalRoot.path === '/' ? '/' : `${canonicalRoot.path}/`
    if (
      canonicalPath.path !== canonicalRoot.path &&
      !canonicalPath.path.startsWith(canonicalPrefix)
    ) {
      throw new Error('Path escapes the project root through a symlink')
    }
    return options.returnCanonical ? canonicalPath : decoded
  }
}

function assertMainFrame(
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC is available only to the workbench main frame')
  }
}

function assertExactChannels<C extends string>(
  direction: string,
  expected: readonly C[],
  actual: ReadonlySet<C>,
): void {
  const missing = expected.filter((channel) => !actual.has(channel))
  const extra = [...actual].filter((channel) => !expected.includes(channel))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `IPC ${direction} manifest mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
    )
  }
}

function includes<C extends string>(
  channels: readonly C[],
  channel: string,
): channel is C {
  return (channels as readonly string[]).includes(channel)
}

function isLexicallyInside(candidate: HostPath, root: HostPath): boolean {
  const prefix = root.path === '/' ? '/' : `${root.path}/`
  return candidate.path === root.path || candidate.path.startsWith(prefix)
}

function isMissingPathError(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false
  const code = (reason as { code?: unknown }).code
  const message = reason instanceof Error ? reason.message : ''
  return code === 'ENOENT' || code === 2 || /no such file|not found/i.test(message)
}
