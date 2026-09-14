import type { HostPath } from '../../shared/host-path'
import type {
  SkillagerSyncCompletion,
  SkillagerSyncStatus,
} from '../../shared/skillager-library-sync'
import type { SkillagerCliSelection } from './skillager-port'
import { SkillagerError } from './skillager-port'
import { parseSkillagerJson } from './skillager-cli-metadata'
import {
  parseSkillagerSyncCompletion,
  parseSkillagerSyncStatus,
} from './skillager-library-sync-contract'
import { SkillagerProcess, SKILLAGER_INVENTORY_LIMITS } from './skillager-process'

/** Selected public CLI only: SSH contributes no local cwd, state path, or discovery root. */
export class SkillagerLibrarySyncCommands {
  constructor(
    private readonly process: SkillagerProcess,
    private readonly personalContext: HostPath,
    private readonly validate: (
      selection: SkillagerCliSelection,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  async status(
    selection: SkillagerCliSelection,
    workspace: HostPath,
    signal: AbortSignal,
  ): Promise<SkillagerSyncStatus> {
    await this.validate(selection, signal)
    const context = this.context(workspace)
    const output = await this.process.runResult(
      selection.executable.path,
      this.args(selection, workspace, '--status'),
      { cwd: context, signal, env: selection.environment },
      SKILLAGER_INVENTORY_LIMITS,
    )
    if (output.code !== 0 && output.code !== 2)
      throw new SkillagerError(
        'command-failed',
        'Skillager command failed. Check it in your local terminal.',
      )
    if (output.code === 2 && !output.stdout.trim())
      throw new SkillagerError(
        'unsupported',
        'Approved-skill sync is unavailable from the selected Skillager executable. Check it in your local terminal.',
      )
    return parseSkillagerSyncStatus(
      parseSkillagerJson(output.stdout),
      output.code,
      selection.library!,
      context,
    )
  }

  async apply(
    selection: SkillagerCliSelection,
    workspace: HostPath,
    signal: AbortSignal,
    submitted: () => void,
  ): Promise<SkillagerSyncCompletion> {
    await this.validate(selection, signal)
    const args = this.args(selection, workspace, '--approved')
    if (signal.aborted)
      throw new SkillagerError(
        'cancelled',
        'Library sync was cancelled before execution.',
      )
    const context = this.context(workspace)
    submitted()
    try {
      const output = await this.process.runResult(
        selection.executable.path,
        args,
        { cwd: context, signal, env: selection.environment },
        SKILLAGER_INVENTORY_LIMITS,
      )
      return parseSkillagerSyncCompletion(
        parseSkillagerJson(output.stdout),
        output.code,
        selection.library!,
        context,
      )
    } catch (error) {
      // Shared process admission is the only runner refusal known to precede launch.
      if (error instanceof SkillagerError && error.reason === 'busy') throw error
      throw new SkillagerError(
        'uncertain',
        'Skillager sync could not be verified. Library files may have changed. Check current state before another sync.',
      )
    }
  }

  private context(workspace: HostPath): HostPath {
    return workspace.hostId === 'local' ? workspace : this.personalContext
  }
  private args(
    selection: SkillagerCliSelection,
    workspace: HostPath,
    action: '--status' | '--approved',
  ): string[] {
    if (!selection.library)
      throw new SkillagerError(
        'disconnected',
        'Connect your personal library before syncing.',
      )
    return [
      '--catalog-state-dir',
      selection.catalog.path,
      ...(workspace.hostId === 'local' ? [] : ['--state-dir', selection.catalog.path]),
      'library',
      'sync',
      action,
      '--expected-library-id',
      selection.library.id,
      '--expected-library-root',
      selection.library.root.path,
      '--json',
    ]
  }
}
