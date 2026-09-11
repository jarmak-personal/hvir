import type { HostPath } from '../../shared/host-path'
import type {
  SkillagerFailureReason,
  SkillagerLibrary,
  SkillagerMetadata,
  SkillagerRequest,
  SkillagerSearchRequest,
  SkillagerWorkspaceExposure,
} from '../../shared/skillager'

export interface SkillagerCliSelection {
  readonly executable: HostPath
  readonly catalog: HostPath
  readonly version: string
  readonly environment: Readonly<Record<string, string>>
  readonly library?: SkillagerLibrary
}

export interface SkillagerCliPort {
  probe(
    executable: HostPath | undefined,
    signal: AbortSignal,
  ): Promise<SkillagerCliSelection>
  validate(selection: SkillagerCliSelection, signal: AbortSignal): Promise<void>
  inventory(
    selection: SkillagerCliSelection,
    signal: AbortSignal,
  ): Promise<readonly SkillagerMetadata[]>
  search(
    selection: SkillagerCliSelection,
    request: SkillagerSearchRequest,
    signal: AbortSignal,
  ): Promise<readonly SkillagerMetadata[]>
  exposures(
    selection: SkillagerCliSelection,
    request: SkillagerRequest,
    signal: AbortSignal,
  ): Promise<readonly SkillagerWorkspaceExposure[] | undefined>
}

export class SkillagerError extends Error {
  constructor(
    readonly reason: SkillagerFailureReason,
    message: string,
  ) {
    super(message)
  }
}

export const SKILLAGER_REQUEST_DEADLINE_MS = 30_000
