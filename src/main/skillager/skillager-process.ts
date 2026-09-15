import { SkillagerError, SKILLAGER_REQUEST_DEADLINE_MS } from './skillager-port'
import type { ExecResult } from '../../shared/fs-types'
import type { ExecOptions, ProjectHost } from '../project-host/project-host'

export interface SkillagerProcessLimits {
  readonly stdout: number
  readonly stderr: number
  readonly deadlineMs: number
}

export const SKILLAGER_PROBE_LIMITS = {
  stdout: 256 * 1024,
  stderr: 64 * 1024,
  deadlineMs: 10_000,
}
export const SKILLAGER_SEARCH_LIMITS = {
  stdout: 4 * 1024 * 1024,
  stderr: 64 * 1024,
  deadlineMs: SKILLAGER_REQUEST_DEADLINE_MS,
}
export const SKILLAGER_INVENTORY_LIMITS = {
  stdout: 32 * 1024 * 1024,
  stderr: 64 * 1024,
  deadlineMs: SKILLAGER_REQUEST_DEADLINE_MS,
}

/** One application-wide admission bound; replacement requests cancel, never accumulate. */
export class SkillagerProcess {
  private active = 0
  private disposed = false
  private readonly controllers = new Set<AbortController>()
  private readonly pending = new Set<Promise<ExecResult>>()

  constructor(private readonly host: Pick<ProjectHost, 'exec'>) {}

  run(
    command: string,
    args: readonly string[],
    options: ExecOptions,
    limits: SkillagerProcessLimits,
  ): Promise<string> {
    return this.runResult(command, args, options, limits).then((output) => {
      if (output.code !== 0)
        throw new SkillagerError(
          'command-failed',
          'Skillager command failed. Check it in your local terminal.',
        )
      return output.stdout
    })
  }

  /** Preserves bounded exit evidence for the feature-owned mutation classifier. */
  runResult(
    command: string,
    args: readonly string[],
    options: ExecOptions,
    limits: SkillagerProcessLimits,
  ): Promise<ExecResult> {
    const task = this.perform(command, args, options, limits)
    this.pending.add(task)
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    )
    return task
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled([...this.pending])
  }

  private async perform(
    command: string,
    args: readonly string[],
    options: ExecOptions,
    limits: SkillagerProcessLimits,
  ): Promise<ExecResult> {
    if (this.disposed || options.signal?.aborted)
      throw new SkillagerError('cancelled', 'Skillager request cancelled.')
    if (this.active >= 2)
      throw new SkillagerError('busy', 'Skillager is busy. Try again shortly.')
    this.active++
    const controller = new AbortController()
    this.controllers.add(controller)
    let timedOut = false
    const cancel = (): void => controller.abort()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, limits.deadlineMs)
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const output = await this.host.exec(command, args, {
        ...options,
        signal: controller.signal,
        maxBuffer: limits.stdout + limits.stderr,
        maxStdoutBytes: limits.stdout,
        maxStderrBytes: limits.stderr,
      })
      return output
    } catch (error) {
      if (timedOut)
        throw new SkillagerError('timeout', 'Skillager took too long. Try again.')
      if (this.disposed || options.signal?.aborted)
        throw new SkillagerError('cancelled', 'Skillager request cancelled.')
      if (error instanceof SkillagerError) throw error
      if (error instanceof Error && /exceeded maxBuffer/.test(error.message))
        throw new SkillagerError(
          'output-limit',
          'Skillager output exceeded the supported size.',
        )
      throw new SkillagerError(
        'command-failed',
        'Skillager could not run. Check it in your local terminal.',
      )
    } finally {
      this.controllers.delete(controller)
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
      // ProjectHost resolves only after the local process group and pipes close.
      this.active--
    }
  }
}
