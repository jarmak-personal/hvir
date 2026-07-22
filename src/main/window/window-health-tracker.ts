import { randomUUID } from 'node:crypto'

import type { WindowHealthDiagnostic } from '../health/workbench-health-events'
import type { RendererOwner } from '../renderer-resource-scopes'

export interface WindowUnresponsiveEpisode {
  readonly occurrenceId: string
  readonly owner: RendererOwner
}

/** Sanitizes and correlates Electron window signals without owning recovery policy. */
export class WindowHealthTracker {
  private documentFailureId?: string
  private unresponsiveEpisode?: WindowUnresponsiveEpisode

  constructor(private readonly record: (event: WindowHealthDiagnostic) => void) {}

  documentStarted(): void {
    this.documentFailureId = undefined
  }

  documentReady(): void {
    this.documentFailureId = undefined
  }

  documentFailed(owner: RendererOwner, code: number, usableDocument: boolean): void {
    if (code === -3 || this.documentFailureId) return
    this.documentFailureId = randomUUID()
    this.record({
      kind: 'main-document-load-failed',
      ownerId: owner.id,
      ownerGeneration: owner.generation,
      occurrenceId: this.documentFailureId,
      failure: loadFailureBucket(code),
      impact: usableDocument ? 'degraded' : 'critical',
    })
  }

  rendererGone(
    owner: RendererOwner,
    reason: Electron.RenderProcessGoneDetails['reason'],
    recoveryRequested = false,
  ): void {
    const unresponsive = this.unresponsiveEpisode
    this.unresponsiveEpisode = undefined
    if (unresponsive) this.recover(unresponsive, 'renderer-exited')
    if (recoveryRequested || reason === 'clean-exit') return
    this.record({
      kind: 'renderer-process-exited',
      ownerId: owner.id,
      ownerGeneration: owner.generation,
      occurrenceId: randomUUID(),
      reason: rendererExitBucket(reason),
    })
  }

  unresponsive(owner: RendererOwner): WindowUnresponsiveEpisode {
    const episode =
      this.unresponsiveEpisode ??
      ({ occurrenceId: randomUUID(), owner } satisfies WindowUnresponsiveEpisode)
    this.unresponsiveEpisode = episode
    this.record({
      kind: 'renderer-unresponsive',
      ownerId: episode.owner.id,
      ownerGeneration: episode.owner.generation,
      occurrenceId: episode.occurrenceId,
    })
    return episode
  }

  recoverUnresponsive(
    episode: WindowUnresponsiveEpisode,
    outcome: RecoveryOutcome,
  ): void {
    if (this.unresponsiveEpisode !== episode) return
    if (outcome !== 'wait-selected') this.unresponsiveEpisode = undefined
    this.recover(episode, outcome)
  }

  responsive(): void {
    const episode = this.unresponsiveEpisode
    if (episode) this.recoverUnresponsive(episode, 'responsive')
  }

  private recover(episode: WindowUnresponsiveEpisode, outcome: RecoveryOutcome): void {
    this.record({
      kind: 'workbench-health-recovered',
      ownerId: episode.owner.id,
      ownerGeneration: episode.owner.generation,
      occurrenceId: episode.occurrenceId,
      outcome,
    })
  }
}

type RecoveryOutcome = Extract<
  WindowHealthDiagnostic,
  { kind: 'workbench-health-recovered' }
>['outcome']

function loadFailureBucket(
  code: number,
): Extract<WindowHealthDiagnostic, { kind: 'main-document-load-failed' }>['failure'] {
  if (code === -6) return 'not-found'
  if (code <= -200 && code >= -299) return 'certificate'
  if ([-102, -105, -106, -118].includes(code)) return 'connection'
  return 'other'
}

function rendererExitBucket(
  reason: Electron.RenderProcessGoneDetails['reason'],
): Extract<WindowHealthDiagnostic, { kind: 'renderer-process-exited' }>['reason'] {
  if (reason === 'crashed' || reason === 'abnormal-exit') return 'crashed'
  if (reason === 'killed') return 'killed'
  if (reason === 'oom') return 'oom'
  if (reason === 'integrity-failure') return 'integrity'
  if (reason === 'launch-failed') return 'launch'
  return 'other'
}
