import {
  MAX_WORKBENCH_HEALTH_ITEMS,
  WORKBENCH_HEALTH_VERSION,
  isDiagnosticOpaqueId,
  isWorkbenchHealthRecoveryOutcome,
  type WorkbenchHealthItem,
  type WorkbenchHealthSnapshot,
} from '../../shared'
import type { StoredDiagnosticEvent } from '../diagnostics/diagnostic-event'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { WindowHealthDiagnostic } from './workbench-health-events'

const SATURATING_COUNT = Number.MAX_SAFE_INTEGER

/** Bounded app-lifetime policy for ratified high-confidence workbench faults. */
export class WorkbenchHealth {
  private readonly items = new Map<string, WorkbenchHealthItem>()
  private dropped = 0

  observe(event: StoredDiagnosticEvent): boolean {
    switch (event.kind) {
      case 'react-render-contained':
        return this.open(
          `react:${String(event['ownerId'])}:${event.ownerGeneration}`,
          event,
          'react-render-contained',
          'contained',
          'renderer-error-boundary',
          'degraded',
        )
      case 'main-document-load-failed':
        if (!isLoadFailure(event['failure'])) return false
        return this.open(
          occurrenceKey(event),
          event,
          'main-document-load-failed',
          event['failure'],
          'window-manager',
          event['impact'] === 'critical' ? 'critical' : 'degraded',
        )
      case 'renderer-process-exited':
        if (!isRendererExitReason(event['reason'])) return false
        return this.open(
          occurrenceKey(event),
          event,
          'renderer-process-exited',
          event['reason'],
          'window-manager',
          'critical',
        )
      case 'renderer-unresponsive':
        return this.open(
          occurrenceKey(event),
          event,
          'renderer-unresponsive',
          'unresponsive',
          'window-manager',
          'degraded',
        )
      case 'workbench-health-recovered':
        return this.recover(event)
      default:
        return false
    }
  }

  acknowledge(occurrenceId: string): boolean {
    if (!isDiagnosticOpaqueId(occurrenceId)) return false
    const entry = [...this.items.entries()].find(
      ([, item]) => item.occurrenceId === occurrenceId,
    )
    if (!entry || entry[1].state !== 'open') return false
    this.items.set(entry[0], { ...entry[1], state: 'acknowledged' })
    return true
  }

  rendererReady(owner: RendererOwner, occurredAt: string): WindowHealthDiagnostic[] {
    return this.resolveMatching(
      (item) =>
        item.ownerId === owner.id &&
        ((item.kind === 'main-document-load-failed' &&
          item.ownerGeneration <= owner.generation) ||
          ((item.kind === 'react-render-contained' ||
            item.kind === 'renderer-process-exited') &&
            item.ownerGeneration < owner.generation)),
      (item) =>
        item.kind === 'main-document-load-failed' &&
        item.ownerGeneration === owner.generation
          ? 'document-loaded'
          : 'renderer-reloaded',
      occurredAt,
    )
  }

  rendererClosed(owner: RendererOwner, occurredAt: string): WindowHealthDiagnostic[] {
    return this.resolveMatching(
      (item) => item.ownerId === owner.id && item.ownerGeneration <= owner.generation,
      () => 'window-closed',
      occurredAt,
    )
  }

  snapshot(evidence: WorkbenchHealthSnapshot['evidence']): WorkbenchHealthSnapshot {
    const stateOrder = { open: 0, acknowledged: 1, resolved: 2 } as const
    return {
      version: WORKBENCH_HEALTH_VERSION,
      evidence,
      items: [...this.items.values()].sort(
        (left, right) =>
          stateOrder[left.state] - stateOrder[right.state] ||
          Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt),
      ),
      dropped: this.dropped,
    }
  }

  private open(
    key: string,
    event: StoredDiagnosticEvent,
    kind: WorkbenchHealthItem['kind'],
    classification: WorkbenchHealthItem['classification'],
    owner: WorkbenchHealthItem['owner'],
    severity: WorkbenchHealthItem['severity'],
  ): boolean {
    const occurrenceId = event['occurrenceId']
    const ownerId = event['ownerId']
    if (!isDiagnosticOpaqueId(occurrenceId) || !isPositiveInteger(ownerId)) return false
    const current = this.items.get(key)
    const active = current ? withoutRecovery(current) : undefined
    this.items.set(
      key,
      active
        ? {
            ...active,
            state: 'open',
            lastObservedAt: event.occurredAt,
            count: saturatingAdd(active.count, 1),
            correlation: event.correlation,
          }
        : {
            occurrenceId,
            kind,
            classification,
            owner,
            ownerId,
            ownerGeneration: event.ownerGeneration,
            severity,
            state: 'open',
            firstObservedAt: event.occurredAt,
            lastObservedAt: event.occurredAt,
            count: 1,
            correlation: event.correlation,
          },
    )
    this.enforceBound()
    return true
  }

  private recover(event: StoredDiagnosticEvent): boolean {
    const occurrenceId = event['occurrenceId']
    const outcome = event['outcome']
    if (
      !isDiagnosticOpaqueId(occurrenceId) ||
      !isWorkbenchHealthRecoveryOutcome(outcome)
    ) {
      return false
    }
    const entry = [...this.items.entries()].find(
      ([, item]) =>
        item.occurrenceId === occurrenceId &&
        item.ownerId === event['ownerId'] &&
        item.ownerGeneration === event.ownerGeneration,
    )
    if (!entry || entry[1].state === 'resolved') return false
    this.items.set(entry[0], {
      ...entry[1],
      state: outcome === 'wait-selected' ? 'acknowledged' : 'resolved',
      lastObservedAt: event.occurredAt,
      recoveryOutcome: outcome,
    })
    return true
  }

  private resolveMatching(
    matches: (item: WorkbenchHealthItem) => boolean,
    outcomeFor: (
      item: WorkbenchHealthItem,
    ) => NonNullable<WorkbenchHealthItem['recoveryOutcome']>,
    occurredAt: string,
  ): WindowHealthDiagnostic[] {
    const events: WindowHealthDiagnostic[] = []
    for (const [key, item] of this.items) {
      if (item.state === 'resolved' || !matches(item)) continue
      const outcome = outcomeFor(item)
      this.items.set(key, {
        ...item,
        state: 'resolved',
        lastObservedAt: occurredAt,
        recoveryOutcome: outcome,
      })
      events.push({
        kind: 'workbench-health-recovered',
        ownerId: item.ownerId,
        ownerGeneration: item.ownerGeneration,
        occurrenceId: item.occurrenceId,
        outcome,
      })
    }
    return events
  }

  private enforceBound(): void {
    while (this.items.size > MAX_WORKBENCH_HEALTH_ITEMS) {
      const entries = [...this.items.entries()].sort(
        (left, right) =>
          Date.parse(left[1].lastObservedAt) - Date.parse(right[1].lastObservedAt),
      )
      const oldest = entries.find(([, item]) => item.state === 'resolved') ?? entries[0]
      if (!oldest) return
      this.items.delete(oldest[0])
      this.dropped = saturatingAdd(this.dropped, 1)
    }
  }
}

function withoutRecovery(item: WorkbenchHealthItem): WorkbenchHealthItem {
  const { recoveryOutcome: _recoveryOutcome, ...active } = item
  return active
}

function occurrenceKey(event: StoredDiagnosticEvent): string {
  return `occurrence:${String(event['occurrenceId'])}`
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isLoadFailure(
  value: unknown,
): value is Extract<
  WorkbenchHealthItem['classification'],
  'not-found' | 'connection' | 'certificate' | 'other'
> {
  return ['not-found', 'connection', 'certificate', 'other'].includes(String(value))
}

function isRendererExitReason(
  value: unknown,
): value is Extract<
  WorkbenchHealthItem['classification'],
  'crashed' | 'killed' | 'oom' | 'integrity' | 'launch' | 'other'
> {
  return ['crashed', 'killed', 'oom', 'integrity', 'launch', 'other'].includes(
    String(value),
  )
}

function saturatingAdd(current: number, increment: number): number {
  return Math.min(SATURATING_COUNT, current + increment)
}
