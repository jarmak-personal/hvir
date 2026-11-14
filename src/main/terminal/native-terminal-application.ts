import { NativeTerminalEffectPolicy } from './native-terminal-effect-policy'
import type { NativeTerminalProductEffect } from '../../shared/native-terminal-effects'
import {
  NativeTerminalInput,
  type NativeTerminalInputContext,
  type NativeTerminalInputState,
} from './native-terminal-input'
import {
  validNativeTerminalInput,
  nativeTerminalKeyOperation,
  NativeTerminalInputResourceRefused,
  type NativeTerminalInputOperation,
} from '../../shared/native-terminal-input'
import { hostPathEquals } from '../../shared/host-path'
import { NativeTerminalAdmissionError } from '../../shared/native-terminal'
import { nativeTerminalLinuxOptionsFromEnvironment } from '../../shared/native-terminal-linux'
import type { ManagedPty } from '../pty/pty-contract'
import { app, clipboard, sharedTexture, type WebFrameMain } from 'electron'
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
  systemClipboard: { writeText(text: string): void } = clipboard,
): Promise<NativeTerminalApplication | undefined> {
  const library = process.env['HVIR_NATIVE_TERMINAL_LIBRARY']
  if (!library || app.isPackaged) return
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('Native workbench development runtime requires macOS or Linux')
  const linux =
    process.platform === 'linux'
      ? nativeTerminalLinuxOptionsFromEnvironment(process.env)
      : undefined
  const { NativeTerminalProcess } = await import('./native-terminal-process')
  const processOwner = new NativeTerminalProcess(library, undefined, undefined, linux)
  const host = new NativeTerminalHost(processOwner, {
    resolve: (id) => sessions?.resolve(id),
    isRendererCurrent: (id, generation) => isCurrent({ id, generation }),
  })
  const effects = new NativeTerminalEffectPolicy(systemClipboard, (session, effect) =>
    application?.publishEffect(session, effect),
  )
  const sessions: NativeTerminalSessions = new NativeTerminalSessions(
    host,
    (id, generation) => isCurrent({ id, generation }),
    (id, instance) => application?.unavailable(id, instance),
    effects,
  )
  const targets = new NativeTerminalPresentationTargets()
  const presenter = new NativeTerminalPresenter(
    host,
    new NativeTerminalFrameImports(processOwner, sharedTexture),
    linux?.presentationMode,
  )
  const application: NativeTerminalApplication = new NativeTerminalApplication(
    sessions,
    host,
    presenter,
    targets,
    ptys,
    isCurrent,
    effects,
  )
  return application
}

type OwnedPty = Pick<
  ManagedPty,
  'id' | 'instanceId' | 'ownerId' | 'ownerGeneration' | 'workspaceRoot'
>
export class NativeTerminalApplication {
  private readonly stopPtyObservation: import('../project-host/project-host').Disposer
  private readonly inputOwner: NativeTerminalInput
  private readonly views = new Map<
    string,
    {
      sessionId: string
      instanceId: string
      owner: RendererOwner
      revision: number
      visible: boolean
      geometrySerial: number
      input: NativeTerminalInputState
      frame: WebFrameMain
    }
  >()
  constructor(
    readonly sessions: Pick<
      NativeTerminalSessions,
      | 'prepare'
      | 'get'
      | 'resolve'
      | 'remove'
      | 'transferOwner'
      | 'writeControl'
      | 'blockInput'
      | 'inputSettled'
      | 'retainInput'
    >,
    private readonly host: Pick<
      NativeTerminalHost,
      | 'inspectProducer'
      | 'readProducer'
      | 'readLinkProducer'
      | 'input'
      | 'rendererInfo'
      | 'dispose'
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
      'resize' | 'writeConfirmed' | 'observe' | 'inputPrefix' | 'inputPolicy'
    > & {
      get(id: string): OwnedPty | undefined
      list(): readonly OwnedPty[]
    },
    private readonly isCurrent: (owner: RendererOwner) => boolean,
    readonly effects?: NativeTerminalEffectPolicy,
  ) {
    this.inputOwner = new NativeTerminalInput(host)
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
  /** Trusted-main qualification only; not a renderer IPC capability. */
  async rendererInfo(id: string, owner: RendererOwner) {
    const record = this.requireSession(id, owner)
    const info = await this.host.rendererInfo(record.handle, record.session.instanceId)
    if (this.requireSession(id, owner).session.instanceId !== record.session.instanceId)
      throw new Error('native-session-stale')
    return info
  }
  preparation(viewport: NativeTerminalViewport) {
    return (
      reservation: Parameters<NativeTerminalSessions['prepare']>[0],
      signal: AbortSignal,
    ) => this.sessions.prepare(reservation, signal, viewport)
  }
  metadata(
    id: string,
    owner: RendererOwner,
  ): import('../../shared/native-terminal-effects').NativeTerminalMetadata {
    const record = this.requireSession(id, owner)
    return { instanceId: record.session.instanceId, title: record.title }
  }
  async readLink(
    id: string,
    owner: RendererOwner,
    query: import('../../shared/native-terminal-link').NativeTerminalLinkQuery,
  ) {
    const record = this.requireSession(id, owner)
    const result = await this.host.readLinkProducer(
      record.handle,
      record.session.instanceId,
      query,
    )
    const current = this.requireSession(id, owner)
    if (
      current.handle !== record.handle ||
      current.session.instanceId !== record.session.instanceId
    )
      throw new Error('native-link-stale')
    return result && { ...result, workspaceRoot: record.session.workspaceRoot }
  }
  /** Only an explicit user-intent caller supplies the existing navigation owner. */
  async activateLink(
    id: string,
    owner: RendererOwner,
    query: import('../../shared/native-terminal-link').NativeTerminalLinkQuery,
    activate: (
      link: import('../../shared/native-terminal-link').NativeTerminalLink,
    ) => void,
  ): Promise<void> {
    const link = await this.readLink(id, owner, query)
    if (link) activate(link)
  }
  publishEffect(
    session: import('../../shared/native-terminal').NativeTerminalSession,
    effect: NativeTerminalProductEffect,
  ): void {
    for (const view of this.views.values()) {
      if (
        view.sessionId !== session.sessionId ||
        view.instanceId !== session.instanceId ||
        view.owner.id !== session.ownerId ||
        view.owner.generation !== session.ownerGeneration ||
        !this.isCurrent(view.owner) ||
        view.frame.isDestroyed()
      )
        continue
      const current = this.sessions.get(session.sessionId)
      if (
        !current ||
        current.session.instanceId !== session.instanceId ||
        current.session.ownerId !== session.ownerId ||
        current.session.ownerGeneration !== session.ownerGeneration ||
        (effect.effect.kind !== 'title' &&
          (current.readonly ||
            current.inputClosed ||
            current.unavailable ||
            current.inputUnavailable))
      )
        continue
      view.frame.send('native-terminal:effect', effect)
    }
  }
  async attach(id: string, owner: RendererOwner, frame: WebFrameMain): Promise<string> {
    const record = this.requireSession(id, owner)
    // Replacing the current input view revokes old IDs before asynchronous work.
    for (const [viewId, view] of this.views) {
      if (view.sessionId === id && view.instanceId === record.session.instanceId)
        await this.detach(viewId, view.owner)
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
      geometrySerial: 0,
      input: { revoked: false },
      frame,
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
    const cleanup = !layout.visible
      ? this.inputOwner.blur(this.inputContext(viewId, owner, true))
      : undefined
    if (!layout.visible) view.visible = false
    const revision = ++view.revision
    await cleanup
    const grant = await this.presenter.update(viewId, layout)
    this.requireView(viewId, owner)
    if (!grant || view.revision !== revision) return
    const record = this.requireSession(view.sessionId, owner)
    const status = await this.host.inspectProducer(record.handle, view.instanceId)
    this.requireView(viewId, owner)
    if (view.revision !== revision || status.geometry.serial !== grant.geometrySerial)
      return
    view.geometrySerial = status.geometry.serial
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
  input(viewId: string, owner: RendererOwner, input: NativeTerminalInputOperation) {
    if (!validNativeTerminalInput(input)) throw new Error('native-input-invalid')
    let cleanup = input.kind === 'focus' && !input.focused
    if (input.kind === 'preedit' && input.text === null) {
      try {
        this.requireInput(viewId, owner)
      } catch (error) {
        if (
          !(error instanceof Error) ||
          ![
            'native-view-hidden',
            'native-presentation-unavailable',
            'native-session-readonly',
            'native-input-unavailable',
          ].includes(error.message)
        )
          throw error
        cleanup = true
      }
    }
    if (cleanup) {
      const context = this.inputContext(viewId, owner, true)
      return this.inputOwner.blur(context).then(() => ({ requestedMutation: 0 }))
    }
    if (input.kind !== 'wheel' && input.kind !== 'pointer' && input.kind !== 'caret')
      this.requireInput(viewId, owner)
    const context = this.inputContext(viewId, owner)
    if (context.readOnly && input.kind === 'pointer' && input.button !== undefined)
      throw new Error('native-session-readonly')
    try {
      return this.inputOwner.dispatch(context, input).catch((error: unknown) => {
        if (
          error instanceof NativeTerminalAdmissionError ||
          error instanceof NativeTerminalInputResourceRefused
        )
          return { requestedMutation: 0, refused: 'capacity' as const }
        throw error
      })
    } catch (error) {
      if (
        error instanceof NativeTerminalAdmissionError ||
        error instanceof NativeTerminalInputResourceRefused
      )
        return Promise.resolve({ requestedMutation: 0, refused: 'capacity' as const })
      throw error
    }
  }
  inputUnavailable(viewId: string, owner: RendererOwner): boolean {
    const view = this.requireView(viewId, owner)
    return this.requireSession(view.sessionId, owner).inputUnavailable
  }
  async key(
    viewId: string,
    owner: RendererOwner,
    input: { key: number; modifiers: number; action: number; text: string },
  ): Promise<void> {
    await this.input(viewId, owner, nativeTerminalKeyOperation(input))
  }

  private inputContext(
    viewId: string,
    owner: RendererOwner,
    captured = false,
  ): NativeTerminalInputContext {
    const view = captured ? this.views.get(viewId) : this.requireView(viewId, owner)
    if (!view || view.owner.id !== owner.id || view.owner.generation !== owner.generation)
      throw new Error('native-view-foreign')
    const record = captured
      ? this.sessions.get(view.sessionId)
      : this.requireSession(view.sessionId, owner)
    if (!record || record.session.instanceId !== view.instanceId)
      throw new Error('native-view-stale')
    const revision = view.revision
    const readOnly =
      record.readonly ||
      record.inputClosed ||
      record.inputUnavailable ||
      this.ptys.get(view.sessionId)?.instanceId !== view.instanceId
    return {
      handle: record.handle,
      instanceId: view.instanceId,
      geometrySerial: view.geometrySerial,
      state: view.input,
      inputSettled: () => this.sessions.inputSettled(view.sessionId, view.instanceId),
      retainInput: (pending) =>
        this.sessions.retainInput(view.sessionId, view.instanceId, pending),
      readOnly,
      policy:
        readOnly || captured
          ? undefined
          : this.ptys.inputPolicy(view.sessionId, owner.id, owner.generation),
      assertCurrent: () => {
        const current = readOnly
          ? { view: this.requireView(viewId, owner) }
          : this.requireInput(viewId, owner)
        if (!view.visible || !this.presenter.isInputCurrent(viewId))
          throw new Error('native-view-hidden')
        if (current.view !== view || view.revision !== revision)
          throw new Error('native-view-stale')
      },
      prefix: () =>
        !record.unavailable &&
        this.ptys.get(view.sessionId)?.instanceId === view.instanceId
          ? this.ptys.inputPrefix(view.sessionId, view.instanceId)
          : { parsed: () => Promise.resolve(), replies: () => Promise.resolve() },
      writeUser: (bytes) =>
        this.ptys.writeConfirmed(
          view.sessionId,
          owner.id,
          bytes,
          owner.generation,
          'user',
        ),
      writeControl: (bytes) =>
        this.sessions.writeControl(view.sessionId, view.instanceId, bytes),
      blockInput: () => this.sessions.blockInput(view.sessionId, view.instanceId),
    }
  }
  async detach(viewId: string, owner: RendererOwner): Promise<void> {
    const view = this.views.get(viewId)
    if (!view) return
    if (view.owner.id !== owner.id || view.owner.generation !== owner.generation)
      throw new Error('native-view-foreign')
    const context = this.inputContext(viewId, owner, true)
    this.views.delete(viewId)
    const results = await Promise.allSettled([this.inputOwner.revoke(context)])
    results.push(...(await Promise.allSettled([this.presenter.detach(viewId)])))
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  async remove(id: string, instanceId: string): Promise<void> {
    const detaching: Promise<void>[] = []
    for (const [viewId, view] of this.views) {
      if (view.sessionId === id && view.instanceId === instanceId) {
        detaching.push(this.detach(viewId, view.owner))
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
    if (record.inputUnavailable) throw new Error('native-input-unavailable')
    if (
      record.readonly ||
      record.inputClosed ||
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
