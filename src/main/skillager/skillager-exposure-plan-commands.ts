import type {
  SkillagerLifecycleRequest,
  SkillagerRouterRemovalRequest,
  SkillagerExposureActionCompletion,
} from '../../shared/skillager-exposure-plan'
import {
  isProvenManagedRemovalRefusal,
  refusedExposure,
} from './skillager-exposure-contract'
import type { ProjectHost } from '../project-host/project-host'
import {
  SkillagerError,
  SKILLAGER_REQUEST_DEADLINE_MS,
  type SkillagerCliSelection,
} from './skillager-port'
import { SkillagerProcess } from './skillager-process'
import { parseSkillagerJson } from './skillager-cli-metadata'
import {
  parsePlanApplied,
  parsePlanPreview,
  planCommand,
  type SkillagerPlanSnapshot,
} from './skillager-exposure-plan-contract'
import {
  parseRouterRemoval,
  routerRemovalCommand,
  type SkillagerRouterRemovalSnapshot,
} from './skillager-router-removal-contract'
import { validateLifecycleSelection } from './skillager-exposure-plan-selection'
import {
  validateExposureDestination,
  validateExposureTarget,
} from './skillager-exposure-paths'

export type SkillagerLocalActionSnapshot =
  SkillagerPlanSnapshot | SkillagerRouterRemovalSnapshot
export interface SkillagerLocalActionPort {
  previewLocalAction(
    selection: SkillagerCliSelection,
    request: SkillagerLifecycleRequest | SkillagerRouterRemovalRequest,
    signal: AbortSignal,
  ): Promise<SkillagerLocalActionSnapshot>
  applyLocalAction(
    selection: SkillagerCliSelection,
    snapshot: SkillagerLocalActionSnapshot,
    signal: AbortSignal,
    submitted: () => void,
  ): Promise<SkillagerExposureActionCompletion>
}
const LIMITS = {
  stdout: 4 * 1024 * 1024,
  stderr: 64 * 1024,
  deadlineMs: SKILLAGER_REQUEST_DEADLINE_MS,
}

/** Uses the same process admission as direct exposure, review and metadata. */
export class SkillagerExposurePlanCommands implements SkillagerLocalActionPort {
  constructor(
    private readonly host: Pick<ProjectHost, 'realpath'>,
    private readonly process: SkillagerProcess,
    private readonly validate: (
      selection: SkillagerCliSelection,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}
  async previewLocalAction(
    selection: SkillagerCliSelection,
    request: SkillagerLifecycleRequest | SkillagerRouterRemovalRequest,
    signal: AbortSignal,
  ): Promise<SkillagerLocalActionSnapshot> {
    validateLifecycleSelection(request, selection)
    await this.validate(selection, signal)
    await validateExposureDestination(this.host, request.destination.root, signal)
    const output = await this.process.runResult(
      selection.executable.path,
      [
        '--catalog-state-dir',
        selection.catalog.path,
        ...command(request),
        ...(request.action === 'plan' ? ['--dry-run'] : []),
      ],
      { cwd: request.destination.root, signal, env: selection.environment },
      LIMITS,
    )
    if (request.action === 'plan' && output.code === 2 && !output.stdout.trim())
      throw new SkillagerError(
        'unsupported',
        'This action requires Skillager with the complete local lifecycle preview contract. Check your selected executable in a terminal.',
      )
    let snapshot: SkillagerLocalActionSnapshot
    if (request.action === 'plan')
      snapshot = parsePlanPreview(
        parseSkillagerJson(output.stdout),
        output.code,
        selection,
        request,
      )
    else {
      if (output.code !== 0) return refusedExposure(output.stderr)
      snapshot = parseRouterRemoval(
        parseSkillagerJson(output.stdout),
        request,
      ) as SkillagerRouterRemovalSnapshot
    }
    for (const target of paths(snapshot))
      await validateExposureTarget(this.host, target, request.destination.root, signal)
    await this.validate(selection, signal)
    signal.throwIfAborted()
    return snapshot
  }
  async applyLocalAction(
    selection: SkillagerCliSelection,
    snapshot: SkillagerLocalActionSnapshot,
    signal: AbortSignal,
    submitted: () => void,
  ): Promise<SkillagerExposureActionCompletion> {
    const request = snapshot.detail.request
    validateLifecycleSelection(request, selection)
    await this.validate(selection, signal)
    await validateExposureDestination(this.host, request.destination.root, signal)
    for (const target of paths(snapshot))
      await validateExposureTarget(this.host, target, request.destination.root, signal)
    signal.throwIfAborted()
    submitted()
    let provenRemovalRefusal = false
    try {
      const output = await this.process.runResult(
        selection.executable.path,
        [
          '--catalog-state-dir',
          selection.catalog.path,
          ...command(request),
          '--yes',
          '--confirmation-token',
          snapshot.confirmationToken,
        ],
        { cwd: request.destination.root, signal, env: selection.environment },
        LIMITS,
      )
      if (request.action === 'plan')
        return parsePlanApplied(
          parseSkillagerJson(output.stdout),
          output.code,
          snapshot as SkillagerPlanSnapshot,
        )
      if (output.code !== 0) {
        if (isProvenManagedRemovalRefusal(output)) {
          provenRemovalRefusal = true
          return refusedExposure(output.stderr)
        }
        throw new SkillagerError('uncertain', 'Router removal completion is unavailable.')
      }
      return parseRouterRemoval(
        parseSkillagerJson(output.stdout),
        request,
        snapshot as SkillagerRouterRemovalSnapshot,
      ) as import('../../shared/skillager-exposure-plan').SkillagerRouterRemovalCompletion
    } catch (error) {
      if (
        error instanceof SkillagerError &&
        (error.reason === 'busy' ||
          provenRemovalRefusal ||
          (request.action === 'plan' && error.reason === 'review-refused'))
      )
        throw error
      throw new SkillagerError(
        'uncertain',
        'Completion could not be verified. Project actions remain unavailable for this hvir session; Refresh and reconnect cannot establish the complete outcome. Inspect the actual targets, tags and recovery locations in Skillager.',
      )
    }
  }
}
function command(
  request: SkillagerLifecycleRequest | SkillagerRouterRemovalRequest,
): string[] {
  return request.action === 'plan' ? planCommand(request) : routerRemovalCommand(request)
}
function paths(snapshot: SkillagerLocalActionSnapshot) {
  return snapshot.detail.kind === 'plan'
    ? snapshot.detail.targets.map((target) => target.path)
    : [snapshot.detail.target]
}
