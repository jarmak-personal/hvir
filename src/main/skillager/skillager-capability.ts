import type { SkillagerProjectStart } from '../../shared/skillager-project'
import type { SkillagerProjectCliPort } from './skillager-project-commands'
import type { SkillagerProjectTerminalPort } from './skillager-project-terminal'
import { SkillagerProjectSetupOwner } from './skillager-project-setup-owner'
import type { SkillagerSetupTarget } from '../../shared/skillager-setup'
import type { SkillagerFolderPicker, SkillagerSetupCliPort } from './skillager-setup-port'
import type { SkillagerExposureRequest } from '../../shared/skillager-exposure'
import type {
  SkillagerExposureCliPort,
  SkillagerDestinationAvailable,
  SkillagerExposureObserver,
} from './skillager-exposure-port'
import { SkillagerExposureOwner } from './skillager-exposure-owner'
import { skillagerLibrarySkillRoot } from './skillager-library-identity'
import type {
  SkillagerSkillRequest,
  SkillagerReviewRequest,
} from '../../shared/skillager-review'
import { SkillagerReviewOwner } from './skillager-review-owner'
import type {
  SkillagerReviewCliPort,
  SkillagerReviewPreviewPort,
} from './skillager-review-port'
import { randomUUID } from 'node:crypto'
import { hostPathEquals, type HostPath } from '../../shared/host-path'
import {
  SKILLAGER_QUERY_BYTES,
  SKILLAGER_INVENTORY_LIMIT,
  SKILLAGER_AGENTS,
  type SkillagerConnection,
  type SkillagerMetadataResult,
  type SkillagerProbe,
  type SkillagerRequest,
  type SkillagerResult,
  type SkillagerSearchRequest,
  type SkillagerSetupCompletion,
} from '../../shared/skillager'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import type { SkillagerCliPort, SkillagerCliSelection } from './skillager-port'
import { SkillagerError, SKILLAGER_REQUEST_DEADLINE_MS } from './skillager-port'

interface RequestState {
  readonly id: number
  readonly controller: AbortController
  readonly start: () => Promise<void>
  readonly discard: () => void
}
interface RequestLane {
  active?: RequestState
  pending?: RequestState
}
interface OwnerState {
  enabled: boolean
  generation: number
  selection?: SkillagerCliSelection
  probeId?: string
  connectionId?: string
  probe?: AbortController
  setupTarget?: SkillagerSetupTarget
  choosingFolder?: boolean
  setupGitHistory?: boolean
  setupMessage?: string
  readonly lanes: { search: RequestLane; inventory: RequestLane; project: RequestLane }
  latest: { search: number; inventory: number; project: number }
}

export class SkillagerCapability {
  private readonly owners = new Map<string, OwnerState>()
  private readonly jobs = new Map<Promise<unknown>, string>()
  private disposed = false
  // Application lifetime: renderer/configuration revocation must not erase an
  // uncertain mutation. Only an explicit public status reconciliation clears it.
  private readonly uncertainCatalogs = new Map<string, HostPath>()
  private initializing?: AbortController
  private readonly exposures: SkillagerExposureOwner
  private readonly reviews: SkillagerReviewOwner
  private readonly projectSetup?: SkillagerProjectSetupOwner

  constructor(
    private readonly cli: SkillagerCliPort,
    private readonly resources: Pick<
      RendererResourceScopes,
      'assertCurrent' | 'isCurrent' | 'register'
    >,
    private readonly workspaceAvailable: (root: HostPath) => boolean,
    review: {
      readonly cli: SkillagerReviewCliPort
      readonly previews: SkillagerReviewPreviewPort
    },
    private readonly exposure: {
      readonly cli: SkillagerExposureCliPort
      readonly destinationAvailable: SkillagerDestinationAvailable
      readonly observe: SkillagerExposureObserver
    },
    private readonly setup: {
      readonly cli: SkillagerSetupCliPort
      readonly picker: SkillagerFolderPicker
    },
    private readonly project?: {
      readonly cli: SkillagerProjectCliPort
      readonly terminal: SkillagerProjectTerminalPort
    },
  ) {
    if (project)
      this.projectSetup = new SkillagerProjectSetupOwner(
        project.cli,
        project.terminal,
        resources,
      )
    this.exposures = new SkillagerExposureOwner(exposure.cli, resources)
    this.reviews = new SkillagerReviewOwner(
      review.cli,
      resources,
      review.previews,
      exposure.cli,
    )
  }

  configure(owner: RendererOwner, enabled: boolean): void {
    this.resources.assertCurrent(owner)
    if (this.disposed) return
    void this.revoke(owner)
    if (!enabled) return
    this.owners.set(key(owner), {
      enabled: true,
      generation: 0,
      latest: { search: 0, inventory: 0, project: 0 },
      lanes: { search: {}, inventory: {}, project: {} },
    })
    this.resources.register(
      owner,
      { lifetime: 'renderer', type: 'skillager' },
      () => this.revoke(owner),
      { duplicate: 'reuse' },
    )
  }

  probe(
    owner: RendererOwner,
    executable?: HostPath,
  ): Promise<SkillagerResult<SkillagerProbe>> {
    return this.track(
      owner,
      result(async () => {
        const state = this.state(owner)
        this.disconnect(owner)
        const generation = state.generation
        const controller = new AbortController()
        state.probe = controller
        try {
          const selection = await this.cli.probe(executable, controller.signal)
          this.current(owner, state, generation)
          let root = selection.library
            ? undefined
            : this.uncertainCatalogs.get(selection.catalog.path)
          let setupMessage: string | undefined
          if (!selection.library && !root) {
            try {
              root = await this.setup.cli.defaultLibraryRoot(selection)
            } catch (error) {
              this.current(owner, state, generation)
              setupMessage =
                error instanceof SkillagerError
                  ? error.message
                  : 'The local library location could not be determined. Check Skillager again.'
            }
          }
          this.current(owner, state, generation)
          state.selection = selection
          state.probeId = randomUUID()
          state.setupTarget = root ? { selectionId: randomUUID(), root } : undefined
          state.setupMessage = setupMessage
          return this.probed(state)
        } catch (error) {
          this.current(owner, state, generation)
          throw error
        } finally {
          if (state.probe === controller) state.probe = undefined
        }
      }),
    )
  }

  connect(
    owner: RendererOwner,
    probeId: string,
  ): Promise<SkillagerResult<SkillagerConnection>> {
    return this.track(
      owner,
      result(async () => {
        const state = this.state(owner)
        if (!state.selection || probeId !== state.probeId)
          throw new SkillagerError(
            'disconnected',
            'Check Skillager again before connecting.',
          )
        if (this.uncertainCatalogs.has(state.selection.catalog.path) || this.initializing)
          throw new SkillagerError(
            'uncertain',
            'Check library status before connecting after interrupted setup.',
          )
        if (!state.selection.library)
          throw new SkillagerError(
            'not-initialized',
            'Set up your personal library before connecting.',
          )
        const generation = ++state.generation
        state.probe?.abort()
        const controller = new AbortController()
        state.probe = controller
        try {
          await this.cli.validate(state.selection, controller.signal)
        } catch (error) {
          this.current(owner, state, generation)
          throw error
        } finally {
          if (state.probe === controller) state.probe = undefined
        }
        this.current(owner, state, generation)
        state.connectionId = randomUUID()
        return {
          connectionId: state.connectionId,
          executable: state.selection.executable,
          version: state.selection.version,
          library: state.selection.library,
        }
      }),
    )
  }

  disconnect(owner: RendererOwner): void {
    const state = this.owners.get(key(owner))
    if (!state) return
    state.generation++
    if (this.projectSetup) void this.track(owner, this.projectSetup.revoke(owner))
    void this.track(owner, this.reviews.revoke(owner))
    void this.track(owner, this.exposures.revoke(owner))
    state.probe?.abort()
    this.cancelLane(state.lanes.search)
    this.cancelLane(state.lanes.inventory)
    this.cancelLane(state.lanes.project)
    state.connectionId = undefined
    state.probeId = undefined
    state.selection = undefined
    state.setupTarget = undefined
    state.setupGitHistory = undefined
    state.setupMessage = undefined
    state.choosingFolder = false
  }

  chooseLibraryFolder(
    owner: RendererOwner,
    probeId: string,
  ): Promise<SkillagerResult<SkillagerProbe>> {
    return this.track(
      owner,
      result(async () => {
        const state = this.setupState(owner, probeId)
        if (
          !state.setupTarget ||
          state.selection!.library ||
          this.initializing ||
          state.choosingFolder
        )
          throw new SkillagerError(
            'busy',
            'Finish the current library setup action first.',
          )
        const generation = ++state.generation
        const controller = new AbortController()
        state.probe?.abort()
        state.probe = controller
        state.choosingFolder = true
        try {
          const root = await this.setup.picker.choose(
            owner,
            state.setupTarget.root,
            controller.signal,
          )
          this.current(owner, state, generation)
          if (root) {
            if (
              root.hostId !== 'local' ||
              !root.path.startsWith('/') ||
              root.path.includes('\0') ||
              root.path.length > 16384
            )
              throw new SkillagerError(
                'invalid-request',
                'Choose an existing local library folder.',
              )
            state.setupTarget = { selectionId: randomUUID(), root }
          }
          return this.probed(state)
        } catch (error) {
          this.current(owner, state, generation)
          throw error
        } finally {
          if (state.generation === generation) state.choosingFolder = false
          if (state.probe === controller) state.probe = undefined
        }
      }),
    )
  }

  initializeLibrary(
    owner: RendererOwner,
    selectionId: string,
    gitHistory: boolean,
  ): Promise<SkillagerResult<SkillagerSetupCompletion>> {
    return this.track(
      owner,
      result(async () => {
        const state = this.state(owner),
          selection = state.selection
        if (
          !selection ||
          !state.probeId ||
          selection.library ||
          !state.setupTarget ||
          state.setupTarget.selectionId !== selectionId ||
          typeof gitHistory !== 'boolean'
        )
          throw new SkillagerError(
            'invalid-request',
            'Check and select your personal-library location before creating it.',
          )
        if (this.initializing || state.choosingFolder)
          throw new SkillagerError(
            'busy',
            'Finish the current library setup action first.',
          )
        if (this.uncertainCatalogs.has(selection.catalog.path))
          throw new SkillagerError(
            'uncertain',
            'Library setup may already have changed files or registration. Check library status before continuing.',
          )
        const generation = ++state.generation,
          controller = new AbortController()
        state.probe?.abort()
        state.probe = controller
        this.initializing = controller
        this.uncertainCatalogs.set(selection.catalog.path, state.setupTarget.root)
        try {
          const initialized = await this.setup.cli.initializeLibrary(
            selection,
            state.setupTarget.root,
            gitHistory,
            controller.signal,
          )
          if (initialized.kind === 'refused') {
            this.uncertainCatalogs.delete(selection.catalog.path)
            this.current(owner, state, generation)
            throw new SkillagerError('command-failed', initialized.message)
          }
          this.current(owner, state, generation)
          if (
            !initialized.status.library ||
            !hostPathEquals(initialized.status.library.root, state.setupTarget.root)
          )
            throw new SkillagerError(
              'library-changed',
              'The resulting library differs from the selected location.',
            )
          state.selection = { ...selection, library: initialized.status.library }
          state.setupGitHistory = initialized.status.gitHistory
          state.setupTarget = undefined
          state.probeId = randomUUID()
          this.uncertainCatalogs.delete(selection.catalog.path)
          if (initialized.status.gitHistory !== gitHistory) {
            state.setupMessage =
              'This existing library has a different Git history setting. Connect with its actual setting to continue.'
            return { probe: this.probed(state) }
          }
          state.connectionId = randomUUID()
          return {
            probe: this.probed(state),
            connection: {
              connectionId: state.connectionId,
              executable: selection.executable,
              version: selection.version,
              library: initialized.status.library,
            },
          }
        } catch (error) {
          this.current(owner, state, generation)
          if (!this.uncertainCatalogs.has(selection.catalog.path)) throw error
          const detail =
            error instanceof SkillagerError
              ? error.reason === 'timeout'
                ? 'Skillager took too long while setting up the library.'
                : error.reason === 'output-limit'
                  ? 'The library setup response exceeded the supported size.'
                  : error.reason === 'command-failed'
                    ? 'Skillager could not finish library setup.'
                    : error.message
              : 'Library setup could not be verified.'
          throw new SkillagerError(
            'uncertain',
            `${detail} Files or registration may already exist. Check library status before continuing.`,
          )
        } finally {
          if (state.probe === controller) state.probe = undefined
          if (this.initializing === controller) this.initializing = undefined
        }
      }),
    )
  }

  reconcileLibrary(
    owner: RendererOwner,
    probeId: string,
  ): Promise<SkillagerResult<SkillagerProbe>> {
    return this.track(
      owner,
      result(async () => {
        const state = this.setupState(owner, probeId),
          selection = state.selection!
        if (state.connectionId)
          throw new SkillagerError(
            'invalid-request',
            'Disconnect before reconciling library setup.',
          )
        if (this.initializing || state.choosingFolder)
          throw new SkillagerError(
            'busy',
            'Wait for library setup to stop before checking its status.',
          )
        const generation = ++state.generation,
          controller = new AbortController()
        state.probe?.abort()
        state.probe = controller
        try {
          const status = await this.setup.cli.libraryStatus(selection, controller.signal)
          const root = status.library
            ? undefined
            : (this.uncertainCatalogs.get(selection.catalog.path) ??
              state.setupTarget?.root ??
              (await this.setup.cli.defaultLibraryRoot(selection)))
          this.current(owner, state, generation)
          state.selection = { ...selection, library: status.library }
          state.setupTarget = root ? { selectionId: randomUUID(), root } : undefined
          state.setupGitHistory = status.gitHistory
          state.setupMessage = status.library
            ? 'Library status is verified. Connect to browse its metadata.'
            : 'No personal library is registered. Files from an interrupted setup may still exist at the selected location.'
          state.probeId = randomUUID()
          this.uncertainCatalogs.delete(selection.catalog.path)
          return this.probed(state)
        } catch (error) {
          this.current(owner, state, generation)
          throw error
        } finally {
          if (state.probe === controller) state.probe = undefined
        }
      }),
    )
  }

  private setupState(owner: RendererOwner, probeId: string): OwnerState {
    const state = this.state(owner)
    if (!state.selection || state.probeId !== probeId)
      throw new SkillagerError(
        'invalid-request',
        'Check Skillager again before selecting library setup.',
      )
    return state
  }

  private probed(state: OwnerState): SkillagerProbe {
    const selection = state.selection!
    return {
      probeId: state.probeId!,
      executable: selection.executable,
      version: selection.version,
      library: selection.library,
      setup: {
        target: state.setupTarget,
        needsReconciliation: this.uncertainCatalogs.has(selection.catalog.path),
        gitHistory: state.setupGitHistory,
        message: state.setupMessage,
      },
    }
  }

  search(
    owner: RendererOwner,
    request: SkillagerSearchRequest,
  ): Promise<SkillagerResult<SkillagerMetadataResult>> {
    return this.read(owner, 'search', request, async (selection, signal) => {
      if (
        typeof request.query !== 'string' ||
        request.query.trim().length === 0 ||
        Buffer.byteLength(request.query) > SKILLAGER_QUERY_BYTES ||
        request.query.includes('\0') ||
        !['library', 'workspace'].includes(request.scope)
      )
        throw new SkillagerError(
          'invalid-request',
          'Enter a search of at most 1,000 UTF-8 bytes.',
        )
      if (request.scope === 'workspace' && request.workspaceRoot.hostId !== 'local') {
        throw new SkillagerError(
          'unavailable',
          'Use Personal library for an SSH workspace.',
        )
      }
      return { rows: await this.cli.search(selection, request, signal) }
    })
  }

  inventory(
    owner: RendererOwner,
    request: SkillagerRequest,
  ): Promise<SkillagerResult<SkillagerMetadataResult>> {
    return this.read(owner, 'inventory', request, async (selection, signal) => ({
      rows: await this.cli.inventory(selection, signal),
    }))
  }

  projectMetadata(owner: RendererOwner, request: SkillagerRequest) {
    return this.track(
      owner,
      result(async () => {
        const grant = this.reviewGrant(owner, request)
        const observed = await this.read(
          owner,
          'project',
          request,
          (selection, signal) => {
            if (!this.project)
              throw new SkillagerError('unavailable', 'Project metadata is unavailable.')
            return this.project.cli.projectMetadata(
              selection,
              request.workspaceRoot,
              request.agent,
              signal,
            )
          },
        )
        if (!observed.ok) throw new SkillagerError(observed.reason, observed.message)
        grant.assertCurrent()
        return {
          ...observed.value,
          setupRunning: this.projectSetup?.isRunning(grant.selection, request) ?? false,
        }
      }),
    )
  }

  prepareProjectSetup(owner: RendererOwner, request: SkillagerRequest) {
    return this.track(
      owner,
      result(async () => {
        if (!this.projectSetup)
          throw new SkillagerError('unavailable', 'Project setup is unavailable.')
        return this.projectSetup.prepare(owner, request, this.reviewGrant(owner, request))
      }),
    )
  }

  startProjectSetup(owner: RendererOwner, request: SkillagerProjectStart) {
    return this.track(
      owner,
      result(async () => {
        this.state(owner)
        if (!this.projectSetup)
          throw new SkillagerError('unavailable', 'Project setup is unavailable.')
        return this.projectSetup.start(owner, request)
      }),
    )
  }

  releaseProjectSetup(owner: RendererOwner, id: string) {
    return this.projectSetup?.release(owner, id)
  }

  cancel(
    owner: RendererOwner,
    kind: 'search' | 'inventory' | 'project',
    requestId: number,
  ): void {
    const state = this.owners.get(key(owner))
    if (!state || !Number.isSafeInteger(requestId) || requestId < 1) return
    state.latest[kind] = Math.max(state.latest[kind], requestId)
    const lane = state.lanes[kind]
    if (lane.active && lane.active.id <= requestId) lane.active.controller.abort()
    if (lane.pending && lane.pending.id <= requestId) {
      lane.pending.discard()
      lane.pending = undefined
    }
  }

  async revoke(owner: RendererOwner): Promise<void> {
    this.disconnect(owner)
    this.owners.delete(key(owner))
    await Promise.allSettled(
      [...this.jobs]
        .filter(([, ownerKey]) => ownerKey === key(owner))
        .map(([job]) => job),
    )
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const state of this.owners.values()) {
      state.generation++
      state.probe?.abort()
      this.cancelLane(state.lanes.search)
      this.cancelLane(state.lanes.inventory)
      this.cancelLane(state.lanes.project)
    }
    this.owners.clear()
    await this.projectSetup?.revoke()
    await this.exposures.revoke()
    await this.reviews.revoke()
    await Promise.allSettled([...this.jobs.keys()])
  }

  previewExposure(owner: RendererOwner, request: SkillagerExposureRequest) {
    return this.track(
      owner,
      result(async () => {
        const grant = this.reviewGrant(owner, request)
        skillagerLibrarySkillRoot(grant.selection.library!, request.skillId)
        if (
          !['add', 'change', 'remove', 'update'].includes(request.action) ||
          !['native', 'stub'].includes(request.mode) ||
          (request.action !== 'add' &&
            (!request.exposure ||
              request.exposure.skillId !== request.skillId ||
              !['native', 'stub'].includes(request.exposure.mode)))
        )
          throw new SkillagerError(
            'invalid-request',
            'Select an owned direct workspace skill action.',
          )
        const update =
          request.action === 'update'
            ? this.reviews.updateGrant(owner, request)
            : undefined
        const assertCurrent = () => {
          grant.assertCurrent()
          update?.assertCurrent()
          if (!this.exposure.destinationAvailable(request.destination))
            throw new SkillagerError(
              'unavailable',
              'The selected destination is disconnected, closed, missing, or no longer registered.',
            )
        }
        assertCurrent()
        return this.exposures.preview(owner, request, {
          selection: grant.selection,
          assertCurrent,
          validatePreview: update?.validatePreview,
        })
      }),
    )
  }
  applyExposure(owner: RendererOwner, previewId: string) {
    return this.track(
      owner,
      result(() => this.exposures.apply(owner, previewId)),
    )
  }
  releaseExposure(owner: RendererOwner, previewId: string) {
    return this.exposures.release(owner, previewId)
  }
  cancelExposure(owner: RendererOwner, requestId: number) {
    return this.exposures.cancel(owner, requestId)
  }

  review(owner: RendererOwner, request: SkillagerSkillRequest) {
    return this.track(
      owner,
      result(() => {
        const grant = this.reviewGrant(owner, request)
        if (request.update) {
          const update = request.update
          if (
            update.action !== 'update' ||
            update.skillId !== request.skillId ||
            update.connectionId !== request.connectionId ||
            update.agent !== request.agent ||
            !hostPathEquals(update.workspaceRoot, request.workspaceRoot) ||
            !hostPathEquals(update.destination.root, request.workspaceRoot) ||
            !this.exposure.destinationAvailable(update.destination) ||
            update.exposure?.skillId !== request.skillId ||
            update.mode !== update.exposure.mode ||
            !['native', 'stub'].includes(update.mode)
          )
            throw new SkillagerError(
              'invalid-request',
              'Select one current workspace copy to review.',
            )
        }
        return this.reviews.review(owner, request, grant)
      }),
    )
  }
  history(owner: RendererOwner, request: SkillagerSkillRequest) {
    return this.track(
      owner,
      result(() =>
        this.reviews.history(owner, request, this.reviewGrant(owner, request)),
      ),
    )
  }
  reviewContent(
    owner: RendererOwner,
    request: SkillagerReviewRequest & {
      readonly entry: string
      readonly documentEntry?: string
    },
  ) {
    return result(() => Promise.resolve(this.reviews.content(owner, request)))
  }
  reviewDiff(
    owner: RendererOwner,
    request: SkillagerReviewRequest & { readonly fromHash?: string },
  ) {
    return this.track(
      owner,
      result(() => this.reviews.diff(owner, request)),
    )
  }
  acceptReview(owner: RendererOwner, request: SkillagerReviewRequest) {
    return this.track(
      owner,
      result(() => this.reviews.accept(owner, request)),
    )
  }
  cancelReview(owner: RendererOwner, requestId: number): Promise<void> {
    return this.reviews.cancel(owner, requestId)
  }
  releaseReview(owner: RendererOwner, reviewId: string): Promise<void> {
    return this.reviews.release(owner, reviewId)
  }
  private reviewGrant(owner: RendererOwner, request: SkillagerRequest) {
    const state = this.state(owner),
      generation = state.generation
    if (
      !state.selection ||
      !state.connectionId ||
      request.connectionId !== state.connectionId ||
      !Number.isSafeInteger(request.requestId) ||
      request.requestId < 1 ||
      !SKILLAGER_AGENTS.some((agent) => agent.id === request.agent) ||
      !this.workspaceAvailable(request.workspaceRoot)
    )
      throw new SkillagerError(
        'invalid-request',
        'The connected skill workspace is unavailable.',
      )
    return {
      selection: state.selection,
      assertCurrent: () => {
        this.current(owner, state, generation)
        if (!this.workspaceAvailable(request.workspaceRoot))
          throw new SkillagerError('cancelled', 'The skill workspace changed.')
      },
    }
  }

  private track<T>(owner: RendererOwner, job: Promise<T>): Promise<T> {
    this.jobs.set(job, key(owner))
    void job.then(
      () => this.jobs.delete(job),
      () => this.jobs.delete(job),
    )
    return job
  }

  private cancelLane(lane: RequestLane): void {
    lane.active?.controller.abort()
    lane.pending?.discard()
    lane.pending = undefined
  }

  private pump(lane: RequestLane): void {
    if (lane.active || !lane.pending) return
    const active = lane.pending
    lane.pending = undefined
    lane.active = active
    void active.start().finally(() => {
      lane.active = undefined
      this.pump(lane)
    })
  }

  private read<T extends { readonly rows: SkillagerMetadataResult['rows'] }>(
    owner: RendererOwner,
    kind: 'search' | 'inventory' | 'project',
    request: SkillagerRequest,
    operation: (selection: SkillagerCliSelection, signal: AbortSignal) => Promise<T>,
  ): Promise<SkillagerResult<T & SkillagerMetadataResult>> {
    return this.track(
      owner,
      result(async () => {
        const state = this.state(owner)
        const generation = state.generation
        if (
          !state.selection ||
          !state.connectionId ||
          state.connectionId !== request.connectionId
        )
          throw new SkillagerError(
            'disconnected',
            'Connect your Skillager library first.',
          )
        if (
          !Number.isSafeInteger(request.requestId) ||
          request.requestId <= state.latest[kind] ||
          !SKILLAGER_AGENTS.some((agent) => agent.id === request.agent) ||
          !this.workspaceAvailable(request.workspaceRoot)
        ) {
          throw new SkillagerError(
            'invalid-request',
            'The Skillager workspace or request is no longer available.',
          )
        }
        const selection = state.selection
        const lane = state.lanes[kind]
        this.cancelLane(lane)
        state.latest[kind] = request.requestId
        return new Promise<T & SkillagerMetadataResult>((resolve, reject) => {
          const controller = new AbortController()
          const cancelled = (): SkillagerError =>
            new SkillagerError('cancelled', 'Skillager request cancelled.')
          let finish = (): void => undefined
          const completed = new Promise<void>((resolveDone) => {
            finish = resolveDone
          })
          const lease = this.resources.register(
            owner,
            {
              lifetime: 'workspace',
              type: 'skillager-request',
              root: request.workspaceRoot,
              id: `${kind}:${request.requestId}`,
            },
            () => {
              controller.abort()
              return completed
            },
          )
          const active: RequestState = {
            id: request.requestId,
            controller,
            discard: () => {
              controller.abort()
              lease.release()
              finish()
              reject(cancelled())
            },
            start: async () => {
              const started = performance.now()
              let timedOut = false
              const deadline = setTimeout(() => {
                timedOut = true
                controller.abort()
              }, SKILLAGER_REQUEST_DEADLINE_MS)
              try {
                this.current(owner, state, generation)
                if (controller.signal.aborted) throw cancelled()
                let payload = await operation(selection, controller.signal)
                const exposures = await this.exposure.observe(
                  selection,
                  request,
                  { rows: payload.rows, complete: kind === 'inventory' },
                  controller.signal,
                )
                if (
                  kind === 'project' &&
                  exposures?.some((copy) => copy.skillId?.startsWith('lib/'))
                ) {
                  const ids = new Set(exposures.map((copy) => copy.skillId))
                  const canonical = await this.cli.inventory(selection, controller.signal)
                  const rows = [
                    ...payload.rows,
                    ...canonical.filter((row) => ids.has(row.id)),
                  ]
                  if (rows.length > SKILLAGER_INVENTORY_LIMIT)
                    throw new SkillagerError(
                      'output-limit',
                      'Project metadata exceeds the supported number of entries.',
                    )
                  payload = { ...payload, rows }
                }
                this.current(owner, state, generation)
                if (
                  controller.signal.aborted ||
                  state.latest[kind] !== request.requestId ||
                  !this.workspaceAvailable(request.workspaceRoot)
                )
                  throw cancelled()
                resolve({
                  ...payload,
                  exposures,
                  checkedAt: Date.now(),
                  durationMs: performance.now() - started,
                })
              } catch (error) {
                if (error instanceof SkillagerError && error.reason === 'library-changed')
                  this.disconnect(owner)
                reject(
                  timedOut
                    ? new SkillagerError('timeout', 'Skillager took too long. Try again.')
                    : controller.signal.aborted || !this.resources.isCurrent(owner)
                      ? cancelled()
                      : error instanceof Error
                        ? error
                        : new Error('Skillager request failed.'),
                )
              } finally {
                clearTimeout(deadline)
                lease.release()
                finish()
              }
            },
          }
          lane.pending = active
          this.pump(lane)
        })
      }),
    )
  }

  private state(owner: RendererOwner): OwnerState {
    if (!this.resources.isCurrent(owner))
      throw new SkillagerError('cancelled', 'Skillager request cancelled.')
    const state = this.owners.get(key(owner))
    if (this.disposed || !state?.enabled)
      throw new SkillagerError('disabled', 'Skillager is disabled.')
    return state
  }

  private current(owner: RendererOwner, state: OwnerState, generation: number): void {
    if (
      !this.resources.isCurrent(owner) ||
      this.owners.get(key(owner)) !== state ||
      state.generation !== generation
    )
      throw new SkillagerError('cancelled', 'Skillager request cancelled.')
  }
}

function key(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}

export async function result<T>(
  operation: () => Promise<T>,
): Promise<SkillagerResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (error instanceof SkillagerError)
      return { ok: false, reason: error.reason, message: error.message }
    return {
      ok: false,
      reason: 'command-failed',
      message: 'Skillager request failed. Try again.',
    }
  }
}
