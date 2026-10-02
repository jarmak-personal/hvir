import type { HostPath } from './host-path'

/** Connection fields only: configuration destination and directives belong to main. */
export interface AddSshHostRequest {
  readonly alias: string
  readonly hostname: string
  readonly username: string
  readonly port: number
  readonly identityFile?: HostPath
}

export interface SshConfigurationDefaults {
  readonly username: string
  readonly port: number
}
