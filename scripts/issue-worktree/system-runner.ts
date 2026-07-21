import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface CommandOptions {
  cwd: string
  acceptedExitCodes?: readonly number[]
}

export interface SystemRunner {
  run(
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult>
  pathExists(path: string): Promise<boolean>
}

export class CommandExecutionError extends Error {
  readonly exitCode: number

  constructor(
    command: string,
    args: readonly string[],
    exitCode: number,
    stderr: string,
  ) {
    const detail = stderr.trim()
    super(
      `${command} ${args.join(' ')} exited ${exitCode}${detail === '' ? '' : `: ${detail}`}`,
    )
    this.name = 'CommandExecutionError'
    this.exitCode = exitCode
  }
}

export class NodeSystemRunner implements SystemRunner {
  async run(
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    const acceptedExitCodes = options.acceptedExitCodes ?? [0]
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          cwd: options.cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            GH_PROMPT_DISABLED: '1',
            GIT_TERMINAL_PROMPT: '0',
          },
          maxBuffer: MAX_OUTPUT_BYTES,
        },
        (error, stdout, stderr) => {
          const exitCode = numericExitCode(error)
          const result = { stdout, stderr, exitCode }
          if (acceptedExitCodes.includes(exitCode)) {
            resolve(result)
            return
          }
          reject(new CommandExecutionError(command, args, exitCode, stderr))
        },
      )
    })
  }

  async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch (error) {
      if (isMissingPathError(error)) return false
      throw error
    }
  }
}

function numericExitCode(
  error: (Error & { code?: string | number | null }) | null,
): number {
  if (error === null) return 0
  return typeof error.code === 'number' ? error.code : 1
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
