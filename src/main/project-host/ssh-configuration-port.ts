import type { HostPath } from '../../shared/host-path'
import type { ProjectHostOption } from '../../shared/ipc/project'
import type {
  AddSshHostRequest,
  SshConfigurationDefaults,
} from '../../shared/ssh-configuration'

export interface SshConfigurationPort {
  defaults(): SshConfigurationDefaults
  refreshHosts(): Promise<readonly ProjectHostOption[]>
  addSshHost(
    request: AddSshHostRequest,
    assertActive: () => void,
  ): Promise<readonly ProjectHostOption[]>
  pickIdentity(assertActive: () => void): Promise<HostPath | undefined>
}
