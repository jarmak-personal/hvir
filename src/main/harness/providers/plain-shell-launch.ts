import { PROTECTED_TERMINAL_ENVIRONMENT } from '../protected-terminal-environment'
import type {
  HarnessLaunchSpec,
  PlainShellCommandOnce,
} from '../harness-provider-contract'

/** Fixed POSIX bootstrap; command data is positional argv, never shell program text. */
export function plainShellLaunch(
  defaultShell: string,
  command?: PlainShellCommandOnce,
): HarnessLaunchSpec {
  if (!command) return { file: defaultShell, args: ['-l'] }
  const strings = [defaultShell, command.executable, ...command.args]
  if (
    strings.some((value) => value.includes('\0')) ||
    !defaultShell.startsWith('/') ||
    !command.executable.startsWith('/')
  )
    throw new Error('Command handoff needs absolute executable and shell paths')
  const environment = Object.entries(command.environment).map(([name, value]) => {
    if (
      PROTECTED_TERMINAL_ENVIRONMENT.has(name) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      value.includes('\0')
    )
      throw new Error('Invalid command handoff environment')
    return `${name}=${value}`
  })
  return {
    file: '/bin/sh',
    args: [
      '-c',
      'hvir_default_shell=$1; shift; /usr/bin/env -- "$@"; exec "$hvir_default_shell" -l',
      'hvir-command-once',
      defaultShell,
      ...environment,
      command.executable,
      ...command.args,
    ],
  }
}
