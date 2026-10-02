import { EXTENSION_LIMITS } from '../../shared/extensions/contract'
import type {
  ExtensionContributionState,
  ExtensionDemand,
  ExtensionView,
} from '../../shared/extensions/workbench'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ExtensionActivationOwner } from './activation'
import type { ExtensionContextOwner } from './context-owner'
import type { ExtensionGuestOwner } from './guest-owner'
import type { ExtensionPresentationState } from './presentation-state'

type QualifiedDemand = Omit<ExtensionDemand, 'surface'> & {
  readonly surface: ExtensionDemand['surface'] | 'viewer'
}
interface DemandRecord {
  readonly owner: RendererOwner
  readonly entries: readonly QualifiedDemand[]
}

/** Visible contribution demand owns one shared updater per active installation. */
export class ExtensionContributionOwner {
  private readonly demands = new Map<string, DemandRecord>()
  private readonly updaters = new Map<
    string,
    { owner: RendererOwner; view: ExtensionView; failure?: string }
  >()
  private pending?: Promise<void>
  private dirty = false
  private readonly errors = new Map<string, string>()
  private readonly leases = new Map<
    string,
    import('../renderer-resource-scopes').RendererResourceLease
  >()
  constructor(
    private readonly activations: ExtensionActivationOwner,
    private readonly guests: ExtensionGuestOwner,
    private readonly contexts: () => ExtensionContextOwner,
    private readonly presentation: ExtensionPresentationState,
    private readonly scopes: import('../renderer-resource-scopes').RendererResourceScopes,
    private readonly changed: () => void,
  ) {}

  snapshot(): readonly ExtensionContributionState[] {
    return [...this.activations.active.values()].map((activation) => ({
      installationId: activation.installationId,
      extensionName: activation.revision.manifest.name,
      manifest: activation.revision.manifest,
      values: this.presentation.values(activation),
      ...(this.errors.get(activation.installationId)
        ? { error: this.errors.get(activation.installationId) }
        : {}),
    }))
  }

  demand(owner: RendererOwner, values: readonly ExtensionDemand[]): Promise<void> {
    this.scopes.assertCurrent(owner)
    if (
      !Array.isArray(values) ||
      values.length > EXTENSION_LIMITS.installations * (EXTENSION_LIMITS.sessions + 16)
    )
      throw new Error('Contribution demand exceeds its bound')
    const entries = values.flatMap((value: ExtensionDemand) => {
      try {
        const activation = this.activations.active.get(value.installationId)
        if (!activation) throw new Error('Contribution activation is unavailable')
        if (value.surface === 'rail') {
          const item = activation.revision.manifest.railItems?.find(
            (item) => item.id === value.contributionId,
          )
          if (!item || (item.placement === 'session' && !value.sessionId))
            throw new Error('Invalid rail demand')
        } else {
          const view = activation.revision.manifest.views.find(
            (view) => view.id === value.contributionId,
          )
          if (!view || view.navigation !== value.surface)
            throw new Error('Invalid navigation demand')
        }
        this.contexts().admit(owner, {
          surface: value.surface === 'rail' ? 'viewer' : value.surface,
          ...(value.workspaceId ? { workspaceId: value.workspaceId } : {}),
          ...(value.sessionId ? { sessionId: value.sessionId } : {}),
        })
        return [value]
      } catch {
        return []
      }
    })
    this.demands.set(key(owner), { owner, entries })
    if (!this.leases.has(key(owner)))
      this.leases.set(
        key(owner),
        this.scopes.register(
          owner,
          { lifetime: 'renderer', type: 'extension-demand' },
          () => {
            this.revokeOwner(owner)
            return this.reconcile()
          },
        ),
      )
    return this.reconcile()
  }

  revokeOwner(owner: RendererOwner): void {
    this.demands.delete(key(owner))
    this.leases.get(key(owner))?.release()
    this.leases.delete(key(owner))
    void this.reconcile().catch(() => undefined)
  }
  failed(view: ExtensionView): void {
    const current = this.updaters.get(view.installationId)
    if (!current || current.view.id !== view.id) return
    current.failure = view.failure ?? 'Extension updater stopped'
    this.errors.set(view.installationId, current.failure)
    this.presentation.failed(view.installationId)
    this.changed()
  }
  revokeInstallation(id: string): void {
    this.errors.delete(id)
    this.updaters.delete(id)
    for (const [owner, demand] of this.demands)
      this.demands.set(owner, {
        ...demand,
        entries: demand.entries.filter((entry) => entry.installationId !== id),
      })
    this.presentation.revoke(id)
  }
  contextChanged(): void {
    for (const [owner, demand] of this.demands)
      this.demands.set(owner, {
        ...demand,
        entries: demand.entries.filter((entry) => {
          try {
            return this.contexts()
              .admit(demand.owner, {
                surface: entry.surface === 'rail' ? 'viewer' : entry.surface,
                ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
                ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
              })
              .current()
          } catch {
            return false
          }
        }),
      })
    void this.reconcile().catch(() => undefined)
  }

  updaterSessions(
    id: string,
  ): readonly import('../../shared/extensions/contract').ExtensionSessionContext[] {
    const sessions = new Map<
      string,
      import('../../shared/extensions/contract').ExtensionSessionContext
    >()
    for (const demand of this.currentDemands()) {
      if (!this.scopes.isCurrent(demand.owner)) continue
      for (const entry of demand.entries.filter((entry) => entry.installationId === id)) {
        for (const session of this.contexts().sessions(demand.owner)) {
          if (
            entry.sessionId === session.id ||
            (!entry.sessionId && entry.workspaceId === session.workspace.id)
          )
            sessions.set(session.id, session)
        }
      }
    }
    return [...sessions.values()].slice(0, EXTENSION_LIMITS.sessions)
  }

  private currentDemands(): readonly DemandRecord[] {
    return [
      ...this.demands.values(),
      ...this.guests.visibleViewContributions().map(({ owner, view }): DemandRecord => ({
        owner,
        entries: [
          {
            installationId: view.installationId,
            contributionId: view.contributionId,
            surface: 'viewer',
            ...(view.context?.workspace
              ? { workspaceId: view.context.workspace.id }
              : {}),
            ...(view.context?.session ? { sessionId: view.context.session.id } : {}),
          },
        ],
      })),
    ]
  }

  private reconcile(): Promise<void> {
    this.dirty = true
    if (this.pending) return this.pending
    const task = Promise.resolve().then(async () => {
      while (this.dirty) {
        this.dirty = false
        for (const activation of this.activations.active.values()) {
          if (!activation.revision.manifest.updater) continue
          try {
            const demand = this.currentDemands().find(
              (value) =>
                this.scopes.isCurrent(value.owner) &&
                value.entries.some(
                  (entry) => entry.installationId === activation.installationId,
                ),
            )
            let existing = this.updaters.get(activation.installationId)
            if (existing?.failure && this.scopes.isCurrent(existing.owner)) continue
            if (existing) {
              try {
                this.guests.assertView(existing.view.id)
              } catch {
                await this.guests.close(existing.owner, existing.view.id)
                this.updaters.delete(activation.installationId)
                existing = undefined
              }
            }
            if (!existing && demand) {
              const view = await this.guests.open(
                demand.owner,
                activation.installationId,
                'updater',
                () => {
                  if (
                    this.activations.active.get(activation.installationId) !==
                      activation ||
                    !this.currentDemands().some(
                      (current) =>
                        key(current.owner) === key(demand.owner) &&
                        current.entries.some(
                          (entry) => entry.installationId === activation.installationId,
                        ),
                    )
                  )
                    throw new Error('Updater demand was revoked')
                },
                { updater: true },
              )
              existing = { owner: demand.owner, view }
              this.updaters.set(activation.installationId, existing)
            }
            if (existing)
              this.guests.updaterDemand(existing.owner, existing.view.id, !!demand)
            if (!demand) this.presentation.stale(activation.installationId)
            this.errors.delete(activation.installationId)
          } catch (reason) {
            this.errors.set(
              activation.installationId,
              reason instanceof Error
                ? reason.message.slice(0, 240)
                : 'Extension updater unavailable',
            )
          }
        }
        this.changed()
      }
    })
    const completion = task.finally(() => {
      if (this.pending === completion) this.pending = undefined
      if (this.dirty) return this.reconcile()
    })
    this.pending = completion
    return completion
  }
}
function key(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}
