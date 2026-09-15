import type { HostPath } from '../../shared/host-path'
import type { SkillagerAgent } from '../../shared/skillager'
import type {
  SkillagerProjectMetadata,
  SkillagerProjectStatus,
} from '../../shared/skillager-project'
import type { SkillagerCliSelection } from './skillager-port'
import { SkillagerError } from './skillager-port'
import {
  parseSkillagerJson,
  parseSkillagerProjectSkills,
  parseSkillagerProjectStatus,
} from './skillager-cli-metadata'
import { SkillagerProcess, SKILLAGER_INVENTORY_LIMITS } from './skillager-process'

export interface SkillagerProjectCliPort {
  projectMetadata(
    selection: SkillagerCliSelection,
    root: HostPath,
    agent: SkillagerAgent,
    signal: AbortSignal,
  ): Promise<SkillagerProjectMetadata>
  projectStatus(
    selection: SkillagerCliSelection,
    root: HostPath,
    agent: SkillagerAgent,
    signal: AbortSignal,
  ): Promise<SkillagerProjectStatus>
}

/** Public observation shares the selected CLI's real project state with interactive setup. */
export class SkillagerProjectCommands {
  constructor(
    private readonly process: SkillagerProcess,
    private readonly validate: (
      selection: SkillagerCliSelection,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  async status(
    selection: SkillagerCliSelection,
    root: HostPath,
    agent: SkillagerAgent,
    signal: AbortSignal,
  ): Promise<SkillagerProjectStatus> {
    if (root.hostId !== 'local')
      throw new SkillagerError(
        'unavailable',
        'Project Skillager setup is available only for local workspaces.',
      )
    await this.validate(selection, signal)
    const result = await this.process.runResult(
      selection.executable.path,
      [
        '--catalog-state-dir',
        selection.catalog.path,
        'doctor',
        '--agent',
        agent,
        '--json',
      ],
      { cwd: root, signal, env: selection.environment },
      SKILLAGER_INVENTORY_LIMITS,
    )
    if (result.code === null || ![0, 10, 11, 12, 13, 14].includes(result.code))
      throw new SkillagerError(
        'command-failed',
        'Skillager could not observe this project. Check it in your local terminal.',
      )
    return parseSkillagerProjectStatus(
      parseSkillagerJson(result.stdout),
      result.code,
      root,
      agent,
    )
  }

  async metadata(
    selection: SkillagerCliSelection,
    root: HostPath,
    agent: SkillagerAgent,
    signal: AbortSignal,
  ): Promise<SkillagerProjectMetadata> {
    const status = await this.status(selection, root, agent, signal)
    const output = await this.process.run(
      selection.executable.path,
      [
        '--catalog-state-dir',
        selection.catalog.path,
        'review',
        '--source',
        'project',
        '--include-blocked',
        '--include-lint-blocked',
        '--json',
      ],
      { cwd: root, signal, env: selection.environment },
      SKILLAGER_INVENTORY_LIMITS,
    )
    if (!selection.library)
      throw new SkillagerError('disconnected', 'Connect your Skillager library first.')
    return {
      status,
      rows: parseSkillagerProjectSkills(parseSkillagerJson(output), selection.library),
    }
  }
}
