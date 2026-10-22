import type { ExecResult } from '../../shared/fs-types'
import type { ExecOptions, FiniteExecPort } from './project-host'

export const FINITE_EXEC_HOST_LIMIT = 4

/** Local finite commands use existing closed-drain execution, with independent immediate admission. */
export class FiniteExecAdmission implements FiniteExecPort {
  private active = 0
  constructor(
    private readonly execute: (
      command: string,
      args: readonly string[],
      opts?: ExecOptions,
    ) => Promise<ExecResult>,
  ) {}
  tryExec(
    command: string,
    args: readonly string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> | undefined {
    if (this.active >= FINITE_EXEC_HOST_LIMIT) return undefined
    this.active++
    return Promise.resolve()
      .then(() => this.execute(command, args, opts))
      .finally(() => this.active--)
  }
}
