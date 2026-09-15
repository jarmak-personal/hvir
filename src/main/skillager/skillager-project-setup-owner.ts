import { hostPathEquals } from '../../shared/host-path'
import type { SkillagerCliSelection } from './skillager-port'
import { randomUUID } from 'node:crypto'
import type { SkillagerRequest } from '../../shared/skillager'
import type {
  SkillagerProjectSetup,
  SkillagerProjectStart,
} from '../../shared/skillager-project'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import { SkillagerError, SKILLAGER_REQUEST_DEADLINE_MS } from './skillager-port'
import type { SkillagerReviewGrant } from './skillager-review-owner'
import type { SkillagerProjectCliPort } from './skillager-project-commands'
import type { SkillagerProjectTerminalPort } from './skillager-project-terminal'

interface Setup {
  readonly owner: RendererOwner
  readonly request: SkillagerRequest
  readonly grant: SkillagerReviewGrant
  readonly controller: AbortController
  readonly value: SkillagerProjectSetup
  readonly timer: ReturnType<typeof setTimeout>
  lease?: RendererResourceLease
  pending?: Promise<unknown>
  consumed: boolean
}

/** A bounded, one-use initialization grant; handed-off terminals belong to their normal owner. */
export class SkillagerProjectSetupOwner {
  private readonly setups = new Map<string, Setup>()
  private readonly running = new Map<
    string,
    {
      readonly instanceId: string
      readonly request: SkillagerRequest
      readonly catalog: SkillagerCliSelection['catalog']
    }
  >()
  constructor(
    private readonly cli: SkillagerProjectCliPort,
    private readonly terminal: SkillagerProjectTerminalPort,
    private readonly resources: Pick<RendererResourceScopes, 'register'>,
  ) {}

  async prepare(
    owner: RendererOwner,
    request: SkillagerRequest,
    grant: SkillagerReviewGrant,
  ) {
    grant.assertCurrent()
    if (this.isRunning(grant.selection, request))
      throw new SkillagerError(
        'busy',
        'This project setup terminal is still running. Finish or close it first.',
      )
    if (request.workspaceRoot.hostId !== 'local')
      throw new SkillagerError(
        'unavailable',
        'Project setup is available only for local workspaces.',
      )
    if (
      [...this.setups.values()].some(
        (setup) =>
          sameOwner(setup.owner, owner) ||
          (hostPathEquals(setup.grant.selection.catalog, grant.selection.catalog) &&
            setup.request.agent === request.agent &&
            hostPathEquals(setup.request.workspaceRoot, request.workspaceRoot)),
      )
    )
      throw new SkillagerError(
        'busy',
        'Finish or cancel the pending setup terminal first.',
      )
    const setupId = randomUUID(),
      controller = new AbortController()
    const setup: Setup = {
      owner,
      request,
      grant,
      controller,
      consumed: false,
      value: {
        setupId,
        sessionId: randomUUID(),
        projectRoot: request.workspaceRoot,
        agent: request.agent,
        executable: grant.selection.executable,
        profile: this.terminal.profile(),
      },
      timer: setTimeout(() => {
        void this.release(owner, setupId)
      }, SKILLAGER_REQUEST_DEADLINE_MS),
    }
    this.setups.set(setupId, setup)
    setup.lease = this.resources.register(
      owner,
      {
        lifetime: 'workspace',
        type: 'skillager-request',
        root: request.workspaceRoot,
        id: setupId,
      },
      () => this.release(owner, setupId),
    )
    try {
      setup.pending = this.cli.projectStatus(
        grant.selection,
        request.workspaceRoot,
        request.agent,
        controller.signal,
      )
      await setup.pending
      this.current(setup)
      return setup.value
    } catch (error) {
      this.finish(setup)
      throw error
    } finally {
      setup.pending = undefined
    }
  }

  async start(owner: RendererOwner, request: SkillagerProjectStart) {
    const setup = this.setups.get(request.setupId)
    if (!setup || !sameOwner(setup.owner, owner) || setup.consumed || setup.pending)
      throw new SkillagerError(
        'cancelled',
        'Select project setup again to open a new terminal.',
      )
    this.current(setup)
    setup.consumed = true
    const start = async () => {
      await this.cli.projectStatus(
        setup.grant.selection,
        setup.request.workspaceRoot,
        setup.request.agent,
        setup.controller.signal,
      )
      this.current(setup)
      return this.terminal.start(
        owner,
        setup.value,
        setup.grant.selection,
        request,
        setup.controller.signal,
        () => this.current(setup),
      )
    }
    const pending = start()
    setup.pending = pending
    try {
      const response = await pending
      this.running.set(response.id, {
        instanceId: response.instanceId,
        request: setup.request,
        catalog: setup.grant.selection.catalog,
      })
      return response
    } finally {
      this.finish(setup)
    }
  }

  isRunning(selection: SkillagerCliSelection, request: SkillagerRequest): boolean {
    for (const [id, running] of this.running) {
      if (!this.terminal.isRunning(id, running.instanceId)) this.running.delete(id)
    }
    return [...this.running.values()].some(
      (running) =>
        hostPathEquals(running.catalog, selection.catalog) &&
        running.request.agent === request.agent &&
        hostPathEquals(running.request.workspaceRoot, request.workspaceRoot),
    )
  }

  async release(owner: RendererOwner, id: string): Promise<void> {
    const setup = this.setups.get(id)
    if (!setup || !sameOwner(setup.owner, owner)) return
    setup.controller.abort()
    await Promise.allSettled(setup.pending ? [setup.pending] : [])
    this.finish(setup)
  }

  async revoke(owner?: RendererOwner): Promise<void> {
    if (!owner) this.running.clear()
    await Promise.allSettled(
      [...this.setups]
        .filter(([, setup]) => !owner || sameOwner(setup.owner, owner))
        .map(([id, setup]) => this.release(setup.owner, id)),
    )
  }

  private current(setup: Setup): void {
    setup.grant.assertCurrent()
    if (setup.controller.signal.aborted || this.setups.get(setup.value.setupId) !== setup)
      throw new SkillagerError('cancelled', 'The project setup request changed.')
  }

  private finish(setup: Setup): void {
    clearTimeout(setup.timer)
    this.setups.delete(setup.value.setupId)
    setup.lease?.release()
  }
}

function sameOwner(a: RendererOwner, b: RendererOwner): boolean {
  return a.id === b.id && a.generation === b.generation
}
