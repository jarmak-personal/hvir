import { hostPathEquals } from '../../shared/host-path'
import type { ManagedPty } from '../pty/pty-contract'
import { app, sharedTexture, type WebFrameMain } from 'electron'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalViewport } from './native-terminal-sessions'
import { NativeTerminalSessions } from './native-terminal-sessions'
import { NativeTerminalHost } from './native-terminal-host'
import { NativeTerminalFrameImports } from './native-terminal-import'
import { NativeTerminalPresenter } from './native-terminal-presenter'
import { NativeTerminalPresentationTargets } from './native-terminal-presentation-target'

/** Application lifetime wiring stays beside the native resource owner. */
export async function installNativeTerminalApplication(
  lifetime: Pick<import('../workbench-runtime').WorkbenchRuntime, 'own'>,
  ptys: PtySupervisor,
  scopes: Pick<import('../renderer-resource-scopes').RendererResourceScopes, 'isCurrent'>,
): Promise<{ nativeTerminals?: NativeTerminalApplication }> {
  const native = await createNativeTerminalApplication(ptys, (owner) =>
    scopes.isCurrent(owner),
  )
  return {
    nativeTerminals:
      native &&
      lifetime.own('Native development terminals', native, (owner) => owner.dispose()),
  }
}

/** Development opt-in is selected by trusted main startup, never a renderer path.
 * Keeping the concrete process import conditional also keeps native addons out of
 * ordinary startup when contributor bindings have not been built. */
export async function createNativeTerminalApplication(
  ptys: PtySupervisor,
  isCurrent: (owner: RendererOwner) => boolean,
): Promise<NativeTerminalApplication | undefined> {
  const library = process.env['HVIR_NATIVE_TERMINAL_LIBRARY']
  if (!library || app.isPackaged) return
  if (process.platform !== 'darwin')
    throw new Error(
      'Native workbench development runtime is currently qualified on macOS',
    )
  const { NativeTerminalProcess } = await import('./native-terminal-process')
  const processOwner = new NativeTerminalProcess(library)
  const host = new NativeTerminalHost(processOwner, {
    resolve: (id) => sessions?.resolve(id),
    isRendererCurrent: (id, generation) => isCurrent({ id, generation }),
  })
  const sessions: NativeTerminalSessions = new NativeTerminalSessions(
    host,
    (id, generation) => isCurrent({ id, generation }),
    (id, instance) => application?.unavailable(id, instance),
  )
  const targets = new NativeTerminalPresentationTargets()
  const presenter = new NativeTerminalPresenter(
    host,
    new NativeTerminalFrameImports(processOwner, sharedTexture),
  )
  const application: NativeTerminalApplication = new NativeTerminalApplication(
    sessions,
    host,
    presenter,
    targets,
    ptys,
    isCurrent,
  )
  return application
}

type OwnedPty = Pick<
  ManagedPty,
  'id' | 'instanceId' | 'ownerId' | 'ownerGeneration' | 'workspaceRoot'
>
export class NativeTerminalApplication {
  private readonly stopPtyObservation: import('../project-host/project-host').Disposer
  private readonly views = new Map<
    string,
    {
      sessionId: string
      instanceId: string
      owner: RendererOwner
      revision: number
      visible: boolean
    }
  >()
  constructor(
    readonly sessions: Pick<
      NativeTerminalSessions,
      'prepare' | 'get' | 'resolve' | 'remove' | 'transferOwner'
    >,
    private readonly host: Pick<
      NativeTerminalHost,
      'inspectProducer' | 'readProducer' | 'encodeKey' | 'dispose'
    >,
    private readonly presenter: Pick<
      NativeTerminalPresenter,
      'attach' | 'update' | 'demand' | 'detach' | 'suspend' | 'isInputCurrent'
    >,
    readonly targets: Pick<
      NativeTerminalPresentationTargets,
      'create' | 'dispose' | 'acknowledge'
    >,
    private readonly ptys: Pick<
      PtySupervisor,
      'resize' | 'writeConfirmed' | 'observe'
    > & {
      get(id: string): OwnedPty | undefined
      list(): readonly OwnedPty[]
    },
    private readonly isCurrent: (owner: RendererOwner) => boolean,
  ) {
    this.stopPtyObservation = ptys.observe(() => this.refreshOwnership())
    this.refreshOwnership()
  }
  private refreshOwnership(): void {
    for (const managed of this.ptys.list()) {
      const native = this.sessions.get(managed.id)
      if (
        !native ||
        native.session.instanceId !== managed.instanceId ||
        native.session.workspaceRoot.hostId !== managed.workspaceRoot.hostId ||
        !this.isCurrent({ id: managed.ownerId, generation: managed.ownerGeneration })
      )
        continue
      if (
        native.session.ownerId !== managed.ownerId ||
        native.session.ownerGeneration !== managed.ownerGeneration ||
        !hostPathEquals(native.session.workspaceRoot, managed.workspaceRoot)
      )
        this.sessions.transferOwner(
          managed.id,
          managed.instanceId,
          managed.ownerId,
          managed.ownerGeneration,
          managed.workspaceRoot,
        )
    }
  }
  preparation(viewport: NativeTerminalViewport) {
    return (
      reservation: Parameters<NativeTerminalSessions['prepare']>[0],
      signal: AbortSignal,
    ) => this.sessions.prepare(reservation, signal, viewport)
  }
  async attach(id: string, owner: RendererOwner, frame: WebFrameMain): Promise<string> {
    const record = this.requireSession(id, owner)
    // Replacing the current input view revokes old IDs before asynchronous work.
    for (const [viewId, view] of this.views) {
      if (view.sessionId === id && view.instanceId === record.session.instanceId)
        this.views.delete(viewId)
    }
    const viewId = await this.presenter.attach(
      record.handle,
      record.session,
      this.targets.create(
        frame,
        () => {
          const current = this.sessions.get(id)
          return (
            this.isCurrent(owner) &&
            !!current &&
            !current.unavailable &&
            current.session.instanceId === record.session.instanceId &&
            current.session.ownerId === owner.id &&
            current.session.ownerGeneration === owner.generation
          )
        },
        () => true,
      ),
    )
    try {
      const current = this.requireSession(id, owner)
      if (
        current.session.instanceId !== record.session.instanceId ||
        current.handle !== record.handle
      )
        throw new Error('native-view-stale')
    } catch (error) {
      await this.presenter.detach(viewId).catch(() => undefined)
      throw error
    }
    this.views.set(viewId, {
      sessionId: id,
      instanceId: record.session.instanceId,
      owner,
      revision: 0,
      visible: false,
    })
    return viewId
  }
  async update(
    viewId: string,
    owner: RendererOwner,
    layout: {
      width: number
      height: number
      backingScale: number
      visible: boolean
    },
  ): Promise<void> {
    const view = this.requireView(viewId, owner)
    if (!layout.visible) view.visible = false
    const revision = ++view.revision
    const grant = await this.presenter.update(viewId, layout)
    this.requireView(viewId, owner)
    if (!grant || view.revision !== revision) return
    const record = this.requireSession(view.sessionId, owner)
    const status = await this.host.inspectProducer(record.handle, view.instanceId)
    this.requireView(viewId, owner)
    if (view.revision !== revision || status.geometry.serial !== grant.geometrySerial)
      return
    view.visible = layout.visible
    // Only acknowledged native cells notify the existing PTY transport.
    const current = this.requireSession(view.sessionId, owner)
    const live = this.ptys.get(view.sessionId)
    if (
      !current.readonly &&
      live?.instanceId === view.instanceId &&
      live.ownerId === owner.id &&
      live.ownerGeneration === owner.generation
    )
      this.ptys.resize(
        view.sessionId,
        owner.id,
        status.geometry.columns,
        status.geometry.rows,
        owner.generation,
      )
  }
  async demand(viewId: string, owner: RendererOwner): Promise<boolean> {
    this.requireView(viewId, owner)
    return this.presenter.demand(viewId)
  }
  /** Bounded main-owned inspection; no renderer parser or replay buffer. */
  async inspectRetained(id: string, owner: RendererOwner) {
    const record = this.requireSession(id, owner)
    return this.host.inspectProducer(record.handle, record.session.instanceId)
  }
  async readRetained(id: string, owner: RendererOwner): Promise<Uint8Array> {
    const record = this.requireSession(id, owner)
    return this.host.readProducer(record.handle, record.session.instanceId)
  }
  async key(
    viewId: string,
    owner: RendererOwner,
    input: {
      key: number
      modifiers: number
      action: number
      text: string
    },
  ): Promise<void> {
    const { view, record } = this.requireInput(viewId, owner)
    const bytes = await this.host.encodeKey(record.handle, view.instanceId, input)
    this.requireInput(viewId, owner)
    if (bytes.byteLength)
      await this.ptys.writeConfirmed(
        view.sessionId,
        owner.id,
        bytes,
        owner.generation,
        'user',
      )
  }
  async detach(viewId: string, owner: RendererOwner): Promise<void> {
    const view = this.views.get(viewId)
    if (!view) return
    if (view.owner.id !== owner.id || view.owner.generation !== owner.generation)
      throw new Error('native-view-foreign')
    this.views.delete(viewId)
    await this.presenter.detach(viewId)
  }
  async remove(id: string, instanceId: string): Promise<void> {
    const detaching: Promise<void>[] = []
    for (const [viewId, view] of this.views) {
      if (view.sessionId === id && view.instanceId === instanceId) {
        this.views.delete(viewId)
        detaching.push(this.presenter.detach(viewId))
      }
    }
    const results = await Promise.allSettled(detaching)
    results.push(...(await Promise.allSettled([this.sessions.remove(id, instanceId)])))
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  unavailable(sessionId: string, instanceId: string): void {
    for (const [viewId, view] of this.views) {
      if (view.sessionId === sessionId && view.instanceId === instanceId)
        void this.presenter.suspend(viewId).catch(() => undefined)
    }
  }
  dispose(): void {
    void this.stopPtyObservation()
    this.views.clear()
    this.targets.dispose()
    this.host.dispose()
  }
  private requireInput(id: string, owner: RendererOwner) {
    const view = this.requireView(id, owner)
    const record = this.requireSession(view.sessionId, owner)
    const live = this.ptys.get(view.sessionId)
    if (
      record.readonly ||
      live?.instanceId !== view.instanceId ||
      live.ownerId !== owner.id ||
      live.ownerGeneration !== owner.generation
    )
      throw new Error('native-session-readonly')
    if (!view.visible) throw new Error('native-view-hidden')
    if (!this.presenter.isInputCurrent(id))
      throw new Error('native-presentation-unavailable')
    return { view, record }
  }
  private requireSession(id: string, owner: RendererOwner) {
    const record = this.sessions.get(id)
    if (
      !record ||
      record.unavailable ||
      !this.isCurrent(owner) ||
      record.session.ownerId !== owner.id ||
      record.session.ownerGeneration !== owner.generation
    )
      throw new Error('native-session-foreign')
    return record
  }
  private requireView(id: string, owner: RendererOwner) {
    const view = this.views.get(id)
    if (!view || view.owner.id !== owner.id || view.owner.generation !== owner.generation)
      throw new Error('native-view-foreign')
    const record = this.requireSession(view.sessionId, owner)
    if (record.session.instanceId !== view.instanceId)
      throw new Error('native-view-stale')
    return view
  }
}
