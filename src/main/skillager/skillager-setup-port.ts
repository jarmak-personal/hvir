import type { RendererOwner } from '../renderer-resource-scopes'
import type { HostPath } from '../../shared/host-path'
import type { SkillagerLibrary } from '../../shared/skillager'
import type { SkillagerCliSelection } from './skillager-port'

export interface SkillagerLibraryStatus {
  readonly library?: SkillagerLibrary
  readonly gitHistory?: boolean
}
export type SkillagerInitialization =
  | { readonly kind: 'ready'; readonly status: SkillagerLibraryStatus }
  | { readonly kind: 'refused'; readonly message: string }

export interface SkillagerSetupCliPort {
  defaultLibraryRoot(selection: SkillagerCliSelection): Promise<HostPath>
  initializeLibrary(
    selection: SkillagerCliSelection,
    root: HostPath,
    gitHistory: boolean,
    signal: AbortSignal,
  ): Promise<SkillagerInitialization>
  libraryStatus(
    selection: SkillagerCliSelection,
    signal: AbortSignal,
  ): Promise<SkillagerLibraryStatus>
}

export interface SkillagerFolderPicker {
  choose(
    owner: RendererOwner,
    current: HostPath,
    signal: AbortSignal,
  ): Promise<HostPath | undefined>
}
