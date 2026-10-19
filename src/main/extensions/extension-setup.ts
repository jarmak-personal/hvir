import { extensionRequestIdentity } from '../../shared/extensions/validation'
import {
  extensionSetupTemplate,
  parseExtensionSetup,
  SETUP_LIMITS,
} from '../../shared/extensions/setup-proposal'
import type {
  ExtensionSetupReview,
  ExtensionSetupRow,
} from '../../shared/extensions/setup-review'
import type { HostPath } from '../../shared/host-path'
import type { ExtensionActivation, ExtensionActivationOwner } from './activation'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import {
  prepareSetupAgent,
  prepareSetupProgram,
  prepareSetupSource,
  type SetupBinding,
  type SetupBindingPorts,
} from './extension-setup-bindings'

export interface ExtensionSetupFilePicker {
  choose(owner: RendererOwner, current: () => void): Promise<HostPath | undefined>
  read(path: HostPath, current: () => void): Promise<{ name: string; text: string }>
}
interface SetupReviewSession {
  readonly owner: RendererOwner
  readonly activation: ExtensionActivation
  readonly controller: AbortController
  readonly current: () => void
  readonly bindings: SetupBinding[]
  readonly stop: () => void
  review: ExtensionSetupReview
  selecting: boolean
  awaitingForeground?: () => void
  working: boolean
}

/** One finite trusted review; permission stores, identity checks and save policy stay with owners. */
export class ExtensionSetupOwner {
  private readonly sessions = new Set<SetupReviewSession>()
  private disposed = false
  constructor(
    private readonly scopes: Pick<RendererResourceScopes, 'assertCurrent' | 'register'>,
    private readonly activations: Pick<
      ExtensionActivationOwner,
      'active' | 'assertWritable'
    >,
    private readonly bindings: SetupBindingPorts,
    private readonly picker: ExtensionSetupFilePicker,
    private readonly foreground: (owner: RendererOwner) => boolean,
    private readonly windowVisible: (owner: RendererOwner) => boolean,
    private readonly publish: (
      owner: RendererOwner,
      review: ExtensionSetupReview,
    ) => void,
  ) {}

  template(owner: RendererOwner, installation: string): string {
    this.scopes.assertCurrent(owner)
    const activation = this.activations.active.get(installation)
    if (!activation || this.disposed)
      throw new Error('Enable this extension before getting its setup template')
    return extensionSetupTemplate(activation.revision.manifest)
  }

  async import(
    owner: RendererOwner,
    installation: string,
    request: string,
  ): Promise<ExtensionSetupReview | undefined> {
    extensionRequestIdentity(request)
    this.scopes.assertCurrent(owner)
    const activation = this.activations.active.get(installation)
    if (!activation || this.disposed || !this.foreground(owner))
      throw new Error('Open this enabled extension in Settings to review setup')
    if ([...this.sessions].some((entry) => entry.owner.id === owner.id))
      throw new Error('Finish or cancel the current setup review first')
    const controller = new AbortController()
    let lease: RendererResourceLease | undefined
    const current = () => {
      controller.signal.throwIfAborted()
      this.scopes.assertCurrent(owner)
      if (
        this.disposed ||
        this.activations.active.get(installation) !== activation ||
        Date.now() >= session.review.expires
      )
        throw new Error('Setup review ended; import the file again')
      if (session.selecting || session.awaitingForeground) {
        if (!this.windowVisible(owner)) throw new Error('Setup window is unavailable')
      } else if (!this.foreground(owner))
        throw new Error('Return to Settings and review setup again')
    }
    const deadline = setTimeout(
      () => this.retire(session, 'Setup review expired; import the file again'),
      SETUP_LIMITS.reviewMs,
    )
    const session: SetupReviewSession = {
      owner,
      activation,
      controller,
      current,
      bindings: [],
      working: true,
      selecting: true,
      review: {
        request,
        installationId: installation,
        name: activation.revision.manifest.name,
        file: '',
        expires: Date.now() + SETUP_LIMITS.reviewMs,
        phase: 'preparing',
        rows: [],
      },
      stop: () => {
        clearTimeout(deadline)
        lease?.release()
        this.sessions.delete(session)
      },
    }
    this.sessions.add(session)
    try {
      lease = this.scopes.register(
        owner,
        { lifetime: 'renderer', type: 'extension-setup' },
        () => this.retire(session, 'Setup window closed'),
      )
      await this.activations.assertWritable()
      current()
      const selected = await this.picker.choose(owner, current)
      current()
      if (!selected) {
        controller.abort()
        session.stop()
        return undefined
      }
      session.selecting = false
      await this.waitForForeground(session)
      current()
      const snapshot = await this.picker.read(selected, current)
      current()
      const proposal = parseExtensionSetup(snapshot.text, activation.revision.manifest)
      session.review = { ...session.review, file: snapshot.name }
      const add = async (
        id: string,
        title: string,
        kind: ExtensionSetupRow['kind'],
        work: () => SetupBinding | Promise<SetupBinding>,
      ) => {
        current()
        try {
          const binding = await work()
          current()
          session.bindings.push(binding)
          session.review = {
            ...session.review,
            rows: [...session.review.rows, binding.row],
          }
        } catch (reason) {
          current()
          session.review = {
            ...session.review,
            rows: [
              ...session.review.rows,
              {
                id,
                title,
                kind,
                state: 'blocked',
                selected: false,
                explanation: message(reason),
              },
            ],
          }
        }
      }
      for (const [index, entry] of proposal.connectors.entries()) {
        const id = `program-${index}`
        await add(
          id,
          `Run ${entry.connector} · ${entry.executable.hostId}`,
          'program',
          () => prepareSetupProgram(this.bindings, installation, entry, id, current),
        )
      }
      for (const [index, entry] of proposal.sources.entries()) {
        const id = `source-${index}`
        await add(id, `${entry.source} · ${entry.location.hostId}`, 'source', () =>
          prepareSetupSource(this.bindings, installation, entry, id, current),
        )
      }
      if (proposal.requestAgentAccess !== undefined)
        await add('agent', 'Agent access for this extension', 'agent', () =>
          prepareSetupAgent(
            this.bindings,
            installation,
            proposal.requestAgentAccess!,
            current,
          ),
        )
      current()
      this.capacity(session)
      session.review = { ...session.review, phase: 'ready' }
      this.emit(session)
      return session.review
    } catch (reason) {
      this.retire(session, message(reason))
      throw new Error(message(reason), { cause: reason })
    } finally {
      session.working = false
      if (controller.signal.aborted) session.stop()
    }
  }

  select(
    owner: RendererOwner,
    request: string,
    ids: readonly string[],
  ): ExtensionSetupReview {
    const session = this.find(owner, request)
    session.current()
    if (
      session.review.phase !== 'ready' ||
      !Array.isArray(ids) ||
      new Set(ids).size !== ids.length ||
      ids.some(
        (id) =>
          !session.review.rows.some((row) => row.id === id && row.state === 'ready'),
      )
    )
      throw new Error('Choose current setup changes')
    session.review = {
      ...session.review,
      rows: session.review.rows.map((row) => ({
        ...row,
        selected: ids.includes(row.id),
      })),
    }
    this.capacity(session)
    return session.review
  }

  async apply(owner: RendererOwner, request: string): Promise<ExtensionSetupReview> {
    const session = this.find(owner, request)
    session.current()
    if (session.review.phase !== 'ready') throw new Error('Setup review is not ready')
    this.capacity(session)
    if (session.review.capacityError) throw new Error(session.review.capacityError)
    session.working = true
    session.review = { ...session.review, phase: 'saving' }
    this.emit(session)
    let active: string | undefined,
      submitted = false
    const update = (
      id: string,
      state: ExtensionSetupRow['state'],
      explanation?: string,
    ) => {
      session.review = {
        ...session.review,
        rows: session.review.rows.map((row) =>
          row.id === id ? { ...row, state, explanation } : row,
        ),
      }
      this.emit(session)
    }
    try {
      // Reuse is checked before any changed row can write.
      for (const binding of session.bindings) {
        const row = session.review.rows.find((entry) => entry.id === binding.row.id)!
        if (row.selected || row.state === 'unchanged') binding.current()
        if (row.state === 'unchanged') {
          active = row.id
          await binding.recheck()
          active = undefined
        }
      }
      for (const binding of session.bindings) {
        const row = session.review.rows.find((entry) => entry.id === binding.row.id)!
        if (row.state === 'unchanged') continue
        if (!row.selected) {
          update(row.id, 'declined')
          continue
        }
        active = row.id
        submitted = false
        session.current()
        await this.activations.assertWritable()
        session.current()
        await binding.apply(() => {
          submitted = true
        })
        update(row.id, 'saved')
        active = undefined
        submitted = false
      }
      session.review = {
        ...session.review,
        phase: session.controller.signal.aborted ? 'ended' : 'finished',
      }
    } catch (reason) {
      if (active)
        update(
          active,
          submitted ? 'interrupted-uncertain' : 'failed',
          submitted ? 'Saving was interrupted.' : message(reason),
        )
      session.review = {
        ...session.review,
        phase: 'ended',
        explanation: session.controller.signal.aborted
          ? (session.review.explanation ?? 'Setup ended')
          : message(reason),
        rows: session.review.rows.map((row) =>
          row.state === 'ready'
            ? {
                ...row,
                state: 'declined',
                explanation: 'Review setup again to continue',
              }
            : row,
        ),
      }
    } finally {
      session.working = false
      session.controller.abort()
      session.stop()
      session.review = {
        ...session.review,
        rows: session.review.rows.map((row) => {
          const binding = session.bindings.find((entry) => entry.row.id === row.id)
          try {
            return binding ? { ...row, retainedSetting: binding.saved() } : row
          } catch {
            return row
          }
        }),
      }
      this.emit(session)
    }
    return session.review
  }

  cancel(owner: RendererOwner, request: string): void {
    const session = [...this.sessions].find((entry) => this.owns(entry, owner, request))
    if (session)
      this.retire(session, 'Setup cancelled; remaining changes were not applied.')
  }
  revoke(installation: string): void {
    for (const session of this.sessions)
      if (session.activation.installationId === installation)
        this.retire(session, 'Extension changed; review setup again')
  }
  revalidate(): void {
    for (const session of this.sessions) {
      try {
        session.current()
        if (session.awaitingForeground && this.foreground(session.owner))
          session.awaitingForeground()
        if (session.review.phase === 'ready')
          for (const binding of session.bindings) binding.current()
      } catch {
        this.retire(session, 'Setup access changed; review the file again')
      }
    }
  }
  dispose(): void {
    this.disposed = true
    for (const session of this.sessions) this.retire(session, 'Setup ended')
  }
  private waitForForeground(session: SetupReviewSession): Promise<void> {
    if (this.foreground(session.owner)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = () => {
        session.awaitingForeground = undefined
        session.controller.signal.removeEventListener('abort', aborted)
        resolve()
      }
      const aborted = () => {
        session.awaitingForeground = undefined
        reject(new Error('Setup selection ended'))
      }
      session.awaitingForeground = finish
      session.controller.signal.addEventListener('abort', aborted, { once: true })
      if (session.controller.signal.aborted) aborted()
      else this.revalidate()
    })
  }
  private capacity(session: SetupReviewSession): void {
    const selected = session.review.rows.filter((row) => row.selected)
    let capacityError: string | undefined
    try {
      const sources = session.review.rows.flatMap((row) =>
        row.source ? [row.source] : [],
      )
      if (sources.length) this.bindings.sources.assertDistinct(sources)
      const programs = selected.flatMap((row) => (row.program ? [row.program] : []))
      const selectedSources = selected.flatMap((row) => (row.source ? [row.source] : []))
      if (programs.length) this.bindings.programs.project(programs)
      if (selectedSources.length) this.bindings.sources.project(selectedSources)
    } catch (reason) {
      capacityError = message(reason)
    }
    session.review = { ...session.review, capacityError }
  }
  private retire(session: SetupReviewSession, explanation: string): void {
    session.controller.abort()
    const stopping =
      session.working &&
      (session.review.phase === 'saving' || session.review.phase === 'stopping')
    session.review = {
      ...session.review,
      phase: stopping ? 'stopping' : 'ended',
      explanation,
    }
    this.emit(session)
    if (!session.working) session.stop()
  }
  private emit(session: SetupReviewSession): void {
    try {
      this.scopes.assertCurrent(session.owner)
      this.publish(session.owner, session.review)
    } catch {
      /* Closed renderer cannot receive a late result. */
    }
  }
  private owns(
    session: SetupReviewSession,
    owner: RendererOwner,
    request: string,
  ): boolean {
    return (
      session.owner.id === owner.id &&
      session.owner.generation === owner.generation &&
      session.review.request === request
    )
  }
  private find(owner: RendererOwner, request: string): SetupReviewSession {
    this.scopes.assertCurrent(owner)
    const session = [...this.sessions].find((entry) => this.owns(entry, owner, request))
    if (!session) throw new Error('Setup review ended; import the file again')
    return session
  }
}
function message(reason: unknown): string {
  return reason instanceof Error
    ? reason.message.slice(0, 240)
    : 'Setup could not be completed'
}
