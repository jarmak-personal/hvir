import type { HostPath } from '../../shared/host-path'
import type { ExecOptions } from './project-host'

export function remoteCommand(
  command: string,
  args: readonly string[],
  opts: Pick<ExecOptions, 'cwd' | 'env' | 'unsetEnv'> & {
    readonly pathPrefix?: HostPath
  },
): string {
  const executable = [command, ...args].map(quoteSshArgument).join(' ')
  const unset = (opts.unsetEnv ?? [])
    .map((key) => `-u ${quoteSshArgument(key)}`)
    .join(' ')
  const prefix = opts.pathPrefix
  if (prefix && prefix.hostId !== opts.cwd?.hostId)
    throw new Error('Command directory belongs to another host')
  const env = Object.entries(opts.env ?? {})
    .filter(([key]) => !prefix || key !== 'PATH')
    .map(([k, v]) => `${k}=${quoteSshArgument(v)}`)
    .join(' ')
  const path = prefix
    ? `PATH=${quoteSshArgument(prefix.path)}:${opts.env?.['PATH'] !== undefined ? quoteSshArgument(opts.env['PATH']) : '"$PATH"'}`
    : ''
  const environment = [unset, env, path].filter(Boolean).join(' ')
  const invocation = environment ? `env ${environment} ${executable}` : executable
  return opts.cwd
    ? `cd -- ${quoteSshArgument(opts.cwd.path)} && ${invocation}`
    : invocation
}
export function quoteSshArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
