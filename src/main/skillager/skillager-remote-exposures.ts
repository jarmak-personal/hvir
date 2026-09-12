import { randomUUID } from 'node:crypto'
import type { Disposer } from '../../shared'
import { hostPathEquals, joinHostPath, type HostPath } from '../../shared/host-path'
import type {
  SkillagerMetadata,
  SkillagerRequest,
  SkillagerWorkspaceExposure,
} from '../../shared/skillager'
import type {
  SkillagerExposureCompletion,
  SkillagerExposureRequest,
} from '../../shared/skillager-exposure'
import type { ProjectHost } from '../project-host/project-host'
import type {
  ManagedDirectoryPort,
  ManagedDirectoryReceipt,
} from '../project-host/managed-directory'
import {
  inspectionLocation,
  ManagedDirectoryError,
} from '../project-host/managed-directory-contract'
import {
  SkillagerError,
  type SkillagerCliPort,
  type SkillagerCliSelection,
} from './skillager-port'
import type {
  SkillagerExposureCliPort,
  SkillagerExposureSnapshot,
} from './skillager-exposure-port'
import type {
  SkillagerNativePort,
  SkillagerNativeSnapshot,
} from './skillager-native-port'
import { validateExposureSelection } from './skillager-exposure-selection'
import { SkillagerDeploymentStore } from './skillager-deployment-store'
import {
  deploymentKey,
  deploymentRecordBytes,
  deploymentTree,
  SKILLAGER_DEPLOYMENT_RECORD,
  type SkillagerDeployment,
  type SkillagerStoredTarget,
} from './skillager-deployment-record'
import {
  assessDeployment,
  deploymentChecks,
  type DeploymentAssessment,
} from './skillager-deployment-reconciliation'
import { remoteExposurePreview } from './skillager-remote-preview'

type LocalCommands = SkillagerExposureCliPort &
  SkillagerNativePort &
  Pick<SkillagerCliPort, 'validate' | 'exposures'>
interface Preparation {
  readonly token: string
  readonly host: SkillagerRemoteHost
  readonly port: ManagedDirectoryPort
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly detach: Disposer
  readonly request: SkillagerExposureRequest
  readonly prepared: Promise<void>
  source?: SkillagerNativeSnapshot
  stored?: SkillagerStoredTarget
  key?: string
  snapshot?: SkillagerExposureSnapshot
  applying?: Promise<SkillagerExposureCompletion>
  releasing?: Promise<void>
  disposed: boolean
}
export type SkillagerRemoteHost = Pick<
  ProjectHost,
  'hostId' | 'connectionState' | 'onConnectionState' | 'managedDirectory'
>

/** Feature policy owns native sources, intent, reconciliation, and retry admission. */
export class SkillagerRemoteExposures implements SkillagerExposureCliPort {
  private readonly preparations = new Map<string, Preparation>()
  private disposed = false
  constructor(
    private readonly local: LocalCommands,
    private readonly store: SkillagerDeploymentStore,
    private readonly hostForRoot: (root: HostPath) => SkillagerRemoteHost | undefined,
  ) {}

  async previewExposure(
    selection: SkillagerCliSelection,
    request: SkillagerExposureRequest,
    signal: AbortSignal,
  ): Promise<SkillagerExposureSnapshot> {
    if (request.destination.root.hostId === 'local')
      return this.local.previewExposure(selection, request, signal)
    validateExposureSelection(request)
    if (request.mode !== 'native' || request.action === 'change')
      throw new SkillagerError(
        'unavailable',
        'SSH delivery supports Full skills. Stub requires a host-side Skillager runtime.',
      )
    if (this.disposed || signal.aborted) throw cancelled()
    if (this.preparations.size >= 2)
      throw new SkillagerError(
        'busy',
        'Close another remote skill preparation before continuing.',
      )
    const host = this.host(request.destination.root),
      port = host.managedDirectory!
    const token = randomUUID(),
      controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const detach = host.onConnectionState((state) => {
      if (state !== 'connected') controller.abort()
    })
    let finishPreparation: () => void = () => {}
    const prepared = new Promise<void>((resolve) => {
      finishPreparation = resolve
    })
    const preparation: Preparation = {
      token,
      host,
      port,
      controller,
      signal: combined,
      detach,
      request,
      prepared,
      disposed: false,
    }
    this.preparations.set(token, preparation)
    try {
      await this.local.validate(selection, combined)
      if (request.action !== 'remove') {
        preparation.source = await this.local.nativeSnapshot(
          selection,
          request.skillId,
          request.agent,
          combined,
        )
        if (request.action === 'update' && preparation.source.pinned)
          throw new SkillagerError(
            'review-refused',
            'Pinned source · update unavailable.',
          )
      }
      this.current(preparation)
      const source = preparation.source
      const targetEntry =
        source?.targetEntry ??
        request.exposure!.target.path.slice(request.destination.root.path.length + 1)
      const exposureId = source?.exposureId ?? request.exposure!.id
      if (
        request.action !== 'add' &&
        (!hostPathEquals(
          joinHostPath(request.destination.root, targetEntry),
          request.exposure!.target,
        ) ||
          exposureId !== request.exposure!.id)
      )
        throw new SkillagerError(
          'stale-review',
          'The native projection target changed. Select and preview the current workspace copy.',
        )
      const identity = {
        destination: request.destination,
        agent: request.agent,
        targetEntry,
        exposureId,
      }
      const key = deploymentKey(identity)
      if (
        [...this.preparations.values()].some(
          (other) => other !== preparation && other.key === key,
        )
      )
        throw new SkillagerError(
          'busy',
          'This target already has a remote skill preparation.',
        )
      preparation.key = key
      let existing = (await this.store.read()).find(
        (target) => deploymentKey(target.identity) === key,
      )
      if (existing?.intent) existing = await this.reconcile(preparation, existing)
      const incoming: SkillagerDeployment | undefined = source
        ? {
            id: token,
            library: selection.library!,
            skillId: request.skillId,
            sourceHash: source.sourceHash,
            ...identity,
            payload: source.tree,
          }
        : undefined
      const desiredTree = incoming
        ? deploymentTree(incoming)
        : existing?.installed?.receipt.tree
      if (!desiredTree)
        throw new SkillagerError(
          'review-refused',
          'No local deployment record grants authority for this remote copy.',
        )
      const observed = await port.inspect(
        request.destination.root,
        targetEntry,
        existing?.installed?.receipt.tree ?? desiredTree,
        combined,
      )
      let before: ManagedDirectoryReceipt | undefined
      if (request.action === 'add') {
        if (observed.status !== 'absent')
          throw new SkillagerError(
            'review-refused',
            'The remote target already exists. Existing or unmanaged copies are protected.',
          )
        if (existing) {
          const assessment = assessDeployment(existing, deploymentChecks(existing), [
            observed,
          ])
          if (assessment.status !== 'absent') throw uncertain()
          await this.store.save(key, existing.revision, undefined)
          existing = undefined
        }
      } else {
        if (
          !existing?.installed ||
          observed.status !== 'exact' ||
          !sameLibrary(existing.installed.deployment, selection) ||
          existing.installed.deployment.skillId !== request.skillId ||
          assessDeployment(existing, deploymentChecks(existing), [observed]).status !==
            'current'
        )
          throw new SkillagerError(
            'review-refused',
            'This remote copy is modified, unmanaged, or unverifiable. Its files are protected.',
          )
        before = observed.receipt
        if (
          request.action === 'update' &&
          incoming?.sourceHash === existing.installed.deployment.sourceHash
        )
          throw new SkillagerError(
            'stale-review',
            'This copy is already at the accepted source version. Refresh its status.',
          )
      }
      this.current(preparation)
      const parent = targetEntry.split('/').slice(0, -1).join('/')
      preparation.stored = await this.store.save(key, existing?.revision ?? 0, {
        identity,
        installed: existing?.installed,
        intent: {
          id: token,
          action: request.action,
          state: 'prepared',
          stageEntry: `${parent}/.hvir-skillager-stage-${token}`,
          quarantineEntry: `${parent}/.hvir-skillager-removed-${token}`,
          location: inspectionLocation(observed),
          incoming,
          removedDeployment:
            request.action === 'remove' ? existing?.installed?.deployment : undefined,
          before,
        },
      })
      this.current(preparation)
      const snapshot: SkillagerExposureSnapshot = {
        detail: remoteExposurePreview(
          request,
          preparation.stored!,
          source?.declarations ?? [],
        ),
        confirmationToken: token,
        dispose: () => this.release(preparation),
      }
      preparation.snapshot = snapshot
      finishPreparation()
      return snapshot
    } catch (error) {
      finishPreparation()
      await this.release(preparation)
      throw classify(error)
    }
  }

  async updateSourceHash(
    selection: SkillagerCliSelection,
    snapshot: SkillagerExposureSnapshot,
    signal: AbortSignal,
  ): Promise<string> {
    if (snapshot.detail.request.destination.root.hostId === 'local')
      return this.local.updateSourceHash(selection, snapshot, signal)
    const preparation = this.get(snapshot)
    signal.throwIfAborted()
    this.current(preparation)
    const installed = preparation.stored?.installed
    if (!installed || !sameLibrary(installed.deployment, selection))
      throw new SkillagerError(
        'review-refused',
        'The recorded old canonical version is unavailable.',
      )
    return installed.deployment.sourceHash
  }

  applyExposure(
    selection: SkillagerCliSelection,
    snapshot: SkillagerExposureSnapshot,
    signal: AbortSignal,
  ): Promise<SkillagerExposureCompletion> {
    if (snapshot.detail.request.destination.root.hostId === 'local')
      return this.local.applyExposure(selection, snapshot, signal)
    const preparation = this.get(snapshot)
    if (preparation.applying)
      throw new SkillagerError(
        'busy',
        'This remote confirmation is already being applied.',
      )
    signal.throwIfAborted()
    this.current(preparation)
    preparation.applying = this.apply(selection, preparation).catch((error) => {
      throw classify(error)
    })
    return preparation.applying
  }

  async observe(
    selection: SkillagerCliSelection,
    request: SkillagerRequest,
    sourceObservation: {
      readonly rows: readonly SkillagerMetadata[]
      readonly complete: boolean
    },
    signal: AbortSignal,
  ): Promise<readonly SkillagerWorkspaceExposure[] | undefined> {
    if (request.workspaceRoot.hostId === 'local')
      return this.local.exposures(selection, request, signal)
    let detach: Disposer = () => {}
    try {
      const host = this.host(request.workspaceRoot),
        controller = new AbortController()
      detach = host.onConnectionState((state) => {
        if (state !== 'connected') controller.abort()
      })
      const scoped = AbortSignal.any([signal, controller.signal])
      const targets = (await this.store.read()).filter(
        (target) =>
          hostPathEquals(target.identity.destination.root, request.workspaceRoot) &&
          target.identity.agent === request.agent &&
          sameLibrary(
            target.installed?.deployment ??
              target.intent?.incoming ??
              target.intent?.removedDeployment,
            selection,
          ),
      )
      const grouped = targets.map((target) => deploymentChecks(target))
      const observations = await host.managedDirectory!.inspectMany(
        request.workspaceRoot,
        grouped.flat(),
        scoped,
      )
      let offset = 0
      const exposures = targets.flatMap((target, index) => {
        const checks = grouped[index]!,
          results = observations.slice(offset, offset + checks.length)
        offset += checks.length
        const assessment = assessDeployment(target, checks, results)
        if (assessment.status === 'absent' && !target.intent) return []
        const deployment =
          assessment.status === 'current'
            ? assessment.installed?.deployment
            : (target.installed?.deployment ??
              target.intent?.incoming ??
              target.intent?.removedDeployment)
        if (!deployment) return []
        const source = sourceObservation.rows.find(
          (row) =>
            row.id === deployment.skillId &&
            row.source.libraryId === selection.library!.id,
        )
        const available =
          source && ['reviewed', 'trusted', 'pinned'].includes(source.trust)
        const status =
          assessment.status === 'absent'
            ? target.intent?.action === 'remove'
              ? 'removed'
              : 'absent'
            : assessment.status === 'modified'
              ? 'local_edit'
              : assessment.status === 'uncertain'
                ? 'uncertain'
                : !available
                  ? source || sourceObservation.complete
                    ? 'source_unavailable'
                    : 'source_unverified'
                  : source.contentHash === deployment.sourceHash
                    ? 'current'
                    : 'source_update'
        return [
          {
            id: target.identity.exposureId,
            skillId: deployment.skillId,
            target: joinHostPath(request.workspaceRoot, target.identity.targetEntry),
            mode: 'native',
            status,
            currentHash:
              assessment.status === 'absent' ? undefined : deployment.sourceHash,
            expectedSourceHash: available ? source.contentHash : undefined,
            reconciliation: target.intent
              ? (assessment.status === 'current' || assessment.status === 'absent') &&
                assessment.cleanup
                ? ('cleanup-pending' as const)
                : ('pending' as const)
              : undefined,
          },
        ]
      })
      scoped.throwIfAborted()
      return exposures
    } catch (error) {
      if (signal.aborted) throw cancelled()
      // Observation unavailability must not hide independent Personal-library metadata/review.
      if (error instanceof SkillagerError || error instanceof ManagedDirectoryError)
        return undefined
      throw classify(error)
    } finally {
      await detach()
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled(
      [...this.preparations.values()].map((preparation) => this.release(preparation)),
    )
  }

  private async apply(
    selection: SkillagerCliSelection,
    preparation: Preparation,
  ): Promise<SkillagerExposureCompletion> {
    const { request, port, signal } = preparation
    let staging = false,
      submitted = false
    try {
      await this.local.validate(selection, signal)
      if (preparation.source)
        await this.local.validateNativeSource(
          selection,
          preparation.source,
          request.action === 'update',
          signal,
        )
      this.current(preparation)
      let stored = preparation.stored!,
        intent = stored.intent!
      if (preparation.source && intent.incoming) {
        const bytes = new Map(preparation.source.bytes)
        bytes.set(SKILLAGER_DEPLOYMENT_RECORD, deploymentRecordBytes(intent.incoming))
        staging = true
        const candidate = await port.stage(
          request.destination.root,
          intent.stageEntry,
          deploymentTree(intent.incoming),
          bytes,
          intent.location,
          signal,
        )
        preparation.stored = stored = (await this.store.save(
          preparation.key!,
          stored.revision,
          {
            ...stored,
            intent: {
              ...intent,
              state: 'staged',
              candidate,
              location: inspectionLocation({ status: 'exact', receipt: candidate }),
            },
          },
        ))!
        intent = stored.intent!
        await this.local.validateNativeSource(
          selection,
          preparation.source,
          request.action === 'update',
          signal,
        )
      }
      this.current(preparation)
      preparation.stored = stored = (await this.store.save(
        preparation.key!,
        stored.revision,
        { ...stored, intent: { ...intent, state: 'submitted' } },
      ))!
      submitted = true
      const operation =
        request.action === 'add'
          ? {
              action: 'add' as const,
              candidate: intent.candidate!,
              target: stored.identity.targetEntry,
            }
          : request.action === 'update'
            ? {
                action: 'update' as const,
                candidate: intent.candidate!,
                before: intent.before!,
              }
            : {
                action: 'remove' as const,
                before: intent.before!,
                quarantine: intent.quarantineEntry,
              }
      const result = await port.commit(operation, { signal, onSubmitted: () => {} })
      if (result.status === 'uncertain') throw uncertain()
      if (result.status === 'not-applied') {
        await this.settle(preparation, {
          status: stored.installed ? 'current' : 'absent',
          installed: stored.installed,
          outcome: 'not-applied',
          cleanup: intent.candidate,
        })
        throw new SkillagerError(
          'stale-review',
          'The remote target changed before publication. Its current files were retained; refresh and preview again.',
        )
      }
      const installed =
        intent.incoming && result.published
          ? { deployment: intent.incoming, receipt: result.published }
          : undefined
      let notice: string | undefined
      try {
        await this.settle(preparation, {
          status: installed ? 'current' : 'absent',
          installed,
          outcome: 'completed',
          cleanup: result.displaced,
        })
      } catch {
        notice =
          'The remote change completed, but receipt reconciliation or exact temporary cleanup remains incomplete. Refresh before another action.'
      }
      return {
        status: request.action === 'remove' ? 'removed' : 'exposed',
        target: preparation.snapshot!.detail.target,
        skillId: request.skillId,
        mode: 'native',
        notice,
      }
    } catch (error) {
      const stored = preparation.stored
      if (stored?.intent) {
        if (!submitted && stored.intent.candidate) {
          await this.settle(preparation, {
            status: stored.installed ? 'current' : 'absent',
            installed: stored.installed,
            outcome: 'not-applied',
            cleanup: stored.intent.candidate,
          }).catch(() => undefined)
        } else if (
          submitted ||
          (staging &&
            !(error instanceof ManagedDirectoryError && error.reason === 'refused'))
        ) {
          preparation.stored = await this.store
            .save(preparation.key!, stored.revision, {
              ...stored,
              intent: { ...stored.intent, state: 'uncertain' },
            })
            .catch(() => stored)
        }
      }
      throw error
    }
  }

  private async reconcile(
    preparation: Preparation,
    target: SkillagerStoredTarget,
  ): Promise<SkillagerStoredTarget | undefined> {
    const checks = deploymentChecks(target)
    const observations = await preparation.port.inspectMany(
      preparation.request.destination.root,
      checks,
      preparation.signal,
    )
    const assessment = assessDeployment(target, checks, observations)
    if (
      assessment.status === 'modified' ||
      assessment.status === 'uncertain' ||
      !assessment.outcome
    )
      throw uncertain()
    preparation.stored = target
    await this.settle(preparation, assessment)
    return preparation.stored
  }

  private async settle(
    preparation: Preparation,
    assessment: Extract<DeploymentAssessment, { status: 'current' | 'absent' }>,
  ): Promise<void> {
    let stored = preparation.stored!
    if (assessment.cleanup) {
      preparation.stored = stored = (await this.store.save(
        preparation.key!,
        stored.revision,
        {
          ...stored,
          installed: assessment.installed,
          intent: { ...stored.intent!, state: 'completed', cleanup: assessment.cleanup },
        },
      ))!
      if (
        !(await preparation.port.cleanup(assessment.cleanup, AbortSignal.timeout(10_000)))
      )
        throw uncertain()
    }
    preparation.stored = await this.store.save(
      preparation.key!,
      stored.revision,
      assessment.installed
        ? { identity: stored.identity, installed: assessment.installed }
        : undefined,
    )
  }

  private host(root: HostPath): SkillagerRemoteHost {
    const host = this.hostForRoot(root)
    if (!host || host.connectionState !== 'connected' || !host.managedDirectory)
      throw new SkillagerError(
        'unavailable',
        'The registered SSH workspace is disconnected or does not support secure Full-skill delivery.',
      )
    return host
  }
  private get(snapshot: SkillagerExposureSnapshot): Preparation {
    const preparation = this.preparations.get(snapshot.confirmationToken)
    if (!preparation || preparation.snapshot !== snapshot)
      throw new SkillagerError(
        'review-expired',
        'This remote preparation expired. Preview again.',
      )
    return preparation
  }
  private current(preparation: Preparation): void {
    if (
      this.disposed ||
      preparation.disposed ||
      preparation.signal.aborted ||
      this.hostForRoot(preparation.request.destination.root) !== preparation.host ||
      preparation.host.connectionState !== 'connected'
    )
      throw cancelled()
  }
  private release(preparation: Preparation): Promise<void> {
    if (preparation.releasing) return preparation.releasing
    preparation.disposed = true
    preparation.controller.abort()
    preparation.releasing = this.disposePreparation(preparation)
    return preparation.releasing
  }
  private async disposePreparation(preparation: Preparation): Promise<void> {
    await preparation.detach()
    // A cancelled CLI/transport may return late. Wait for ownership assignment
    // before releasing retained source bytes and the unused persisted intent.
    await preparation.prepared
    await preparation.applying?.catch(() => undefined)
    const stored = preparation.stored
    if (stored?.intent?.state === 'prepared') {
      await this.store
        .save(
          preparation.key!,
          stored.revision,
          stored.installed
            ? { identity: stored.identity, installed: stored.installed }
            : undefined,
        )
        .catch(() => undefined)
    }
    try {
      await preparation.source?.dispose()
    } finally {
      this.preparations.delete(preparation.token)
    }
  }
}
function sameLibrary(
  deployment: SkillagerDeployment | undefined,
  selection: SkillagerCliSelection,
): boolean {
  return Boolean(
    deployment &&
    selection.library &&
    deployment.library.id === selection.library.id &&
    hostPathEquals(deployment.library.root, selection.library.root) &&
    hostPathEquals(deployment.library.skillsRoot, selection.library.skillsRoot),
  )
}
function cancelled(): SkillagerError {
  return new SkillagerError(
    'cancelled',
    'The remote skill workspace changed or disconnected.',
  )
}
function uncertain(): SkillagerError {
  return new SkillagerError(
    'uncertain',
    'The previous remote delivery cannot be verified. Its records and files are retained; reconcile the exact workspace before another action.',
  )
}
function classify(error: unknown): SkillagerError {
  if (error instanceof SkillagerError) return error
  if (error instanceof ManagedDirectoryError)
    return new SkillagerError(
      error.reason === 'refused' ? 'review-refused' : error.reason,
      error.message,
    )
  if (error instanceof Error && error.name === 'AbortError') return cancelled()
  return new SkillagerError(
    'command-failed',
    'The remote skill operation failed. Its existing files are protected.',
  )
}
