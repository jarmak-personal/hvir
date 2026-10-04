import { unwrapOperation } from '../../../shared/operation-result'
import type { HostPath } from '../../../shared/host-path'
import type { ProjectHostOption } from '../../../shared/ipc/project'
import type {
  AddSshHostRequest,
  SshConfigurationDefaults,
} from '../../../shared/ssh-configuration'

export interface SshHostChooserPort {
  readonly snapshot: () => Promise<readonly ProjectHostOption[]>
  readonly defaults: () => Promise<SshConfigurationDefaults>
  readonly refresh: () => Promise<readonly ProjectHostOption[]>
  readonly save: (fields: AddSshHostRequest) => Promise<readonly ProjectHostOption[]>
  readonly pickIdentity: () => Promise<HostPath | undefined>
}

export const sshConfigurationClient: SshHostChooserPort = {
  snapshot: () => window.hvir.invoke('project:hosts', undefined),
  defaults: () => window.hvir.invoke('ssh:configuration-defaults', undefined),
  refresh: async () =>
    unwrapOperation(await window.hvir.invoke('ssh:refresh-hosts', undefined)),
  save: async (fields) =>
    unwrapOperation(await window.hvir.invoke('ssh:add-host', fields)),
  pickIdentity: async () =>
    unwrapOperation(await window.hvir.invoke('ssh:pick-identity', undefined)),
}
