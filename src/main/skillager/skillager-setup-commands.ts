import { hostPathEquals, type HostPath } from '../../shared/host-path'
import type { SkillagerCliSelection } from './skillager-port'
import { SkillagerError } from './skillager-port'
import { parseSkillagerJson } from './skillager-cli-metadata'
import {
  parseLibraryInitialization,
  parseLibraryStatus,
} from './skillager-setup-contract'
import {
  SkillagerProcess,
  SKILLAGER_INVENTORY_LIMITS,
  SKILLAGER_PROBE_LIMITS,
} from './skillager-process'
import type {
  SkillagerInitialization,
  SkillagerLibraryStatus,
} from './skillager-setup-port'

/** Init owns its own result classification; read retries do not apply to mutations. */
export class SkillagerSetupCommands {
  constructor(
    private readonly process: SkillagerProcess,
    private readonly context: HostPath,
    private readonly validate: (
      selection: SkillagerCliSelection,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  async status(
    selection: SkillagerCliSelection,
    signal: AbortSignal,
  ): Promise<SkillagerLibraryStatus> {
    const output = await this.process.run(
      selection.executable.path,
      [...this.contextArgs(selection), 'library', 'status', '--json'],
      { cwd: this.context, signal, env: selection.environment },
      SKILLAGER_PROBE_LIMITS,
    )
    const status = parseLibraryStatus(parseSkillagerJson(output))
    if (status.library)
      await this.validate({ ...selection, library: status.library }, signal)
    return status
  }

  async initialize(
    selection: SkillagerCliSelection,
    root: HostPath,
    gitHistory: boolean,
    signal: AbortSignal,
  ): Promise<SkillagerInitialization> {
    if (
      root.hostId !== 'local' ||
      !root.path.startsWith('/') ||
      root.path.includes('\0') ||
      root.path.length > 16384 ||
      typeof gitHistory !== 'boolean'
    )
      return {
        kind: 'refused',
        message: 'Choose a local personal-library folder before creating it.',
      }
    if (signal.aborted)
      return {
        kind: 'refused',
        message: 'Library creation was cancelled before execution.',
      }
    let output
    try {
      output = await this.process.runResult(
        selection.executable.path,
        [
          ...this.contextArgs(selection),
          'library',
          'init',
          '--path',
          root.path,
          '--json',
          ...(gitHistory ? [] : ['--no-git']),
        ],
        { cwd: this.context, signal, env: selection.environment },
        SKILLAGER_INVENTORY_LIMITS,
      )
    } catch (error) {
      // Admission failure is the one runner failure proven to precede launch.
      if (error instanceof SkillagerError && error.reason === 'busy')
        return {
          kind: 'refused',
          message: 'Skillager is busy. Library creation did not start.',
        }
      throw error
    }
    if (
      output.code === 2 &&
      output.stdout.trim() === '' &&
      output.stderr.trim() ===
        'skillager: error: git executable is unavailable; install Git or run `skillager library init --no-git`'
    )
      return {
        kind: 'refused',
        message:
          'Git was not found in the selected Skillager environment. Install Git or explicitly turn off Keep Git history before creating the library.',
      }
    if (output.code !== 0)
      throw new SkillagerError('uncertain', 'Skillager could not finish library setup.')
    const initialized = parseLibraryInitialization(parseSkillagerJson(output.stdout))
    if (!initialized.library || !hostPathEquals(initialized.library.root, root))
      throw new SkillagerError(
        'library-changed',
        'The resulting library differs from the selected location.',
      )
    const status = await this.status(selection, signal)
    if (
      !status.library ||
      status.library.id !== initialized.library.id ||
      !hostPathEquals(status.library.root, initialized.library.root) ||
      status.gitHistory !== initialized.gitHistory
    )
      throw new SkillagerError(
        'library-changed',
        'The library changed while setup was completing.',
      )
    return { kind: 'ready', status }
  }

  private contextArgs(selection: SkillagerCliSelection): string[] {
    return [
      '--catalog-state-dir',
      selection.catalog.path,
      '--state-dir',
      this.context.path,
    ]
  }
}
