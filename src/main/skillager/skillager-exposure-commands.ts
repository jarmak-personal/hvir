import { parseUpdateSourceHash } from './skillager-update-status'
import { validateExposureSelection } from './skillager-exposure-selection'
import {
  containsHostPath,
  dirnameHostPath,
  hostPathEquals,
  type HostPath,
} from '../../shared/host-path'
import type { SkillagerExposureRequest } from '../../shared/skillager-exposure'
import type { ProjectHost } from '../project-host/project-host'
import {
  SkillagerError,
  SKILLAGER_REQUEST_DEADLINE_MS,
  type SkillagerCliSelection,
  type SkillagerCliPort,
} from './skillager-port'
import type {
  SkillagerExposureCliPort,
  SkillagerExposureSnapshot,
} from './skillager-exposure-port'
import { SkillagerProcess } from './skillager-process'
import { parseSkillagerJson } from './skillager-cli-metadata'
import {
  exposureCommand,
  parseExposureApplied,
  parseExposurePreview,
  refusedExposure,
} from './skillager-exposure-contract'

const LIMITS = {
  stdout: 4 * 1024 * 1024,
  stderr: 64 * 1024,
  deadlineMs: SKILLAGER_REQUEST_DEADLINE_MS,
}

/** Local projection writes belong to Skillager; only fixed argv and bound tokens reach exec. */
export class SkillagerExposureCommands implements SkillagerExposureCliPort {
  constructor(
    private readonly host: Pick<ProjectHost, 'realpath'>,
    private readonly process: SkillagerProcess,
    private readonly validate: (
      selection: SkillagerCliSelection,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly observe: SkillagerCliPort['exposures'],
  ) {}

  async previewExposure(
    selection: SkillagerCliSelection,
    request: SkillagerExposureRequest,
    signal: AbortSignal,
  ) {
    validateExposureSelection(request)
    await this.validate(selection, signal)
    await this.validateDestination(request.destination.root, signal)
    const output = await this.process.runResult(
      selection.executable.path,
      [
        '--catalog-state-dir',
        selection.catalog.path,
        ...exposureCommand(request),
        ...(request.action === 'remove' ? [] : ['--dry-run']),
      ],
      { cwd: request.destination.root, signal, env: selection.environment },
      LIMITS,
    )
    if (output.code !== 0) return refusedExposure(output.stderr)
    const snapshot = parseExposurePreview(
      parseSkillagerJson(output.stdout),
      selection,
      request,
    )
    await this.validateTarget(snapshot.detail.target, request.destination.root, signal)
    await this.validate(selection, signal)
    signal.throwIfAborted()
    return snapshot
  }

  async updateSourceHash(
    selection: SkillagerCliSelection,
    snapshot: SkillagerExposureSnapshot,
    signal: AbortSignal,
  ): Promise<string> {
    const { request } = snapshot.detail
    await this.validate(selection, signal)
    await this.validateDestination(request.destination.root, signal)
    const exposures = await this.observe(
      selection,
      { ...request, workspaceRoot: request.destination.root },
      signal,
    )
    const status = parseSkillagerJson(
      await this.process.run(
        selection.executable.path,
        [
          '--catalog-state-dir',
          selection.catalog.path,
          'library',
          'status',
          request.skillId,
          '--json',
        ],
        { cwd: request.destination.root, signal, env: selection.environment },
        {
          stdout: 2 * 1024 * 1024,
          stderr: 64 * 1024,
          deadlineMs: SKILLAGER_REQUEST_DEADLINE_MS,
        },
      ),
    )
    await this.validate(selection, signal)
    signal.throwIfAborted()
    return parseUpdateSourceHash(status, selection, snapshot, exposures ?? [])
  }

  async applyExposure(
    selection: SkillagerCliSelection,
    snapshot: SkillagerExposureSnapshot,
    signal: AbortSignal,
  ) {
    const { request, target } = snapshot.detail
    validateExposureSelection(request)
    await this.validate(selection, signal)
    await this.validateDestination(request.destination.root, signal)
    await this.validateTarget(target, request.destination.root, signal)
    signal.throwIfAborted()
    let output
    try {
      output = await this.process.runResult(
        selection.executable.path,
        [
          '--catalog-state-dir',
          selection.catalog.path,
          ...exposureCommand(request),
          '--yes',
          '--confirmation-token',
          snapshot.confirmationToken,
        ],
        { cwd: request.destination.root, signal, env: selection.environment },
        LIMITS,
      )
    } catch (error) {
      if (error instanceof SkillagerError && error.reason === 'busy') throw error
      throw uncertainExposure()
    }
    if (output.code !== 0) {
      if (
        /preview is stale|source identity or approval changed|exposure not found|ambiguous exposure id|managed exposure has local edits/.test(
          output.stderr,
        )
      )
        return refusedExposure(output.stderr)
      throw uncertainExposure()
    }
    try {
      return parseExposureApplied(parseSkillagerJson(output.stdout), snapshot)
    } catch (error) {
      if (
        error instanceof SkillagerError &&
        ['review-refused', 'stale-review'].includes(error.reason)
      )
        throw error
      throw uncertainExposure()
    }
  }

  private async validateDestination(root: HostPath, signal: AbortSignal): Promise<void> {
    if (root.hostId !== 'local' || !hostPathEquals(await this.host.realpath(root), root))
      throw new SkillagerError(
        'unavailable',
        'The selected local workspace location changed. Select its registered location again.',
      )
    signal.throwIfAborted()
  }
  private async validateTarget(
    target: HostPath,
    root: HostPath,
    signal: AbortSignal,
  ): Promise<void> {
    let path = target
    for (;;) {
      signal.throwIfAborted()
      try {
        const canonical = await this.host.realpath(path)
        if (!containsHostPath(root, canonical) || !hostPathEquals(path, canonical))
          throw new SkillagerError(
            'unavailable',
            'The selected exposure resolves through a changed or outside workspace path.',
          )
        return
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'ENOENT' ||
          hostPathEquals(path, root)
        )
          throw error
        path = dirnameHostPath(path)
        if (!containsHostPath(root, path)) throw error
      }
    }
  }
}
function uncertainExposure(): SkillagerError {
  return new SkillagerError(
    'uncertain',
    'The workspace action may have completed. Refresh its actual state before starting a new preview; do not retry this confirmation.',
  )
}
