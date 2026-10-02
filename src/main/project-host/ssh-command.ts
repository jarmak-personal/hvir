import type { ExecOptions } from './project-host'

export function remoteCommand(
  command: string,
  args: readonly string[],
  opts: Pick<ExecOptions, 'cwd' | 'env' | 'unsetEnv'>,
): string {
  const executable = [command, ...args].map(quoteSshArgument).join(' ')
  const unset = (opts.unsetEnv ?? [])
    .map((key) => `-u ${quoteSshArgument(key)}`)
    .join(' ')
  const env = Object.entries(opts.env ?? {})
    .map(([k, v]) => `${k}=${quoteSshArgument(v)}`)
    .join(' ')
  const environment = [unset, env].filter(Boolean).join(' ')
  const invocation = environment ? `env ${environment} ${executable}` : executable
  return opts.cwd
    ? `cd -- ${quoteSshArgument(opts.cwd.path)} && ${invocation}`
    : invocation
}
export function quoteSshArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
