import type { HostPath } from '../host-path'
import { invoke, type IpcFeatureContract } from '../ipc-contract'
import type {
  SkillagerConnection,
  SkillagerMetadataResult,
  SkillagerProbe,
  SkillagerRequest,
  SkillagerResult,
  SkillagerSearchRequest,
} from '../skillager'

export const skillagerIpc = {
  invoke: {
    'skillager:configure': invoke<{ readonly enabled: boolean }, void>(),
    'skillager:probe': invoke<
      { readonly executable?: HostPath },
      SkillagerResult<SkillagerProbe>
    >(),
    'skillager:connect': invoke<
      { readonly probeId: string },
      SkillagerResult<SkillagerConnection>
    >(),
    'skillager:disconnect': invoke<Record<string, never>, void>(),
    'skillager:inventory': invoke<
      SkillagerRequest,
      SkillagerResult<SkillagerMetadataResult>
    >(),
    'skillager:search': invoke<
      SkillagerSearchRequest,
      SkillagerResult<SkillagerMetadataResult>
    >(),
    'skillager:cancel': invoke<
      { readonly kind: 'search' | 'inventory'; readonly requestId: number },
      void
    >(),
  },
  send: {},
  event: {},
} as const satisfies IpcFeatureContract
