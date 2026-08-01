import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

import {
  parseRequiredElectronPlatform,
  requiredElectronSuites,
  type RequiredElectronPlatform,
  type RequiredElectronSuite,
  type RequiredElectronSuiteGroup,
} from './required-electron-suites.mts'

export interface RequiredElectronSuiteResult {
  readonly id: string
  readonly scenarios: readonly string[]
  readonly status: 'passed' | 'failed'
  readonly durationMs: number
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly failure: 'timed-out' | 'spawn-failed' | 'nonzero-exit' | null
}

export interface RequiredElectronInvocationResult {
  readonly status: 'passed' | 'failed'
  readonly suites: readonly RequiredElectronSuiteResult[]
}

export interface RequiredElectronRunOptions {
  readonly group?: RequiredElectronSuiteGroup
  readonly cwd?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly artifactDirectory?: string
  readonly invoke?: InvokeRequiredElectronSuite
}

export type InvokeRequiredElectronSuite = (
  platform: RequiredElectronPlatform,
  suite: RequiredElectronSuite,
  options: {
    readonly cwd: string
    readonly environment: NodeJS.ProcessEnv
    readonly artifactDirectory?: string
  },
) => Promise<RequiredElectronSuiteResult>

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

export async function runRequiredElectronSuites(
  platform: RequiredElectronPlatform,
  options: RequiredElectronRunOptions = {},
): Promise<RequiredElectronInvocationResult> {
  const suites = requiredElectronSuites(platform, options.group)
  if (suites.length === 0) {
    throw new Error(`No required Electron suites selected for ${platform}`)
  }
  const results: RequiredElectronSuiteResult[] = []
  for (const suite of suites) {
    console.log(`[electron:required] ${platform} · ${suite.id} starting`)
    results.push(
      await (options.invoke ?? invokeRequiredElectronSuite)(platform, suite, {
        cwd: options.cwd ?? repositoryRoot,
        environment: options.environment ?? process.env,
        ...(options.artifactDirectory
          ? { artifactDirectory: join(options.artifactDirectory, suite.id) }
          : {}),
      }),
    )
  }
  const result = {
    status: results.every((suite) => suite.status === 'passed') ? 'passed' : 'failed',
    suites: results,
  } as const
  console.log(formatRequiredElectronResult(platform, result))
  return result
}

export function invokeRequiredElectronSuite(
  platform: RequiredElectronPlatform,
  suite: RequiredElectronSuite,
  options: {
    readonly cwd: string
    readonly environment: NodeJS.ProcessEnv
    readonly artifactDirectory?: string
  },
): Promise<RequiredElectronSuiteResult> {
  const [baseCommand, ...baseArgs] = suite.command
  const command = platform === 'linux-x64' ? 'xvfb-run' : baseCommand
  const args = platform === 'linux-x64' ? ['-a', baseCommand, ...baseArgs] : baseArgs
  const startedAt = performance.now()
  return new Promise((resolveResult) => {
    let settled = false
    let timedOut = false
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: {
        ...options.environment,
        ...(options.artifactDirectory
          ? { HVIR_SMOKE_ARTIFACT_DIR: options.artifactDirectory }
          : {}),
      },
      stdio: 'inherit',
    })
    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      terminateProcessGroup(child.pid)
    }, suite.timeoutMs)
    child.once('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult({
        id: suite.id,
        scenarios: suite.scenarios,
        status: 'failed',
        durationMs: performance.now() - startedAt,
        exitCode: null,
        signal: null,
        failure: 'spawn-failed',
      })
    })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const passed = !timedOut && exitCode === 0 && signal === null
      resolveResult({
        id: suite.id,
        scenarios: suite.scenarios,
        status: passed ? 'passed' : 'failed',
        durationMs: performance.now() - startedAt,
        exitCode,
        signal,
        failure: passed ? null : timedOut ? 'timed-out' : 'nonzero-exit',
      })
    })
  })
}

function terminateProcessGroup(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') process.kill(pid, 'SIGKILL')
    else process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.error('[electron:required] failed to terminate timed-out process group')
    }
  }
}

export function formatRequiredElectronResult(
  platform: RequiredElectronPlatform,
  result: RequiredElectronInvocationResult,
): string {
  return [
    `[electron:required:summary] platform=${platform} suites=${result.suites.length} status=${result.status}`,
    ...result.suites.map(
      (suite) =>
        `- ${suite.id}: ${suite.status} (${suite.scenarios.length} scenarios · ${Math.round(suite.durationMs)}ms · ${suite.failure ?? `exit-${suite.exitCode}`})`,
    ),
  ].join('\n')
}

function parseArguments(args: readonly string[]): {
  readonly platform: RequiredElectronPlatform
  readonly group?: RequiredElectronSuiteGroup
} {
  let platform: RequiredElectronPlatform | undefined
  let group: RequiredElectronSuiteGroup | undefined
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[index + 1]
    if (flag === '--platform' && value) {
      platform = parseRequiredElectronPlatform(value)
      index += 1
    } else if (flag === '--group' && (value === 'core' || value === 'capacity')) {
      group = value
      index += 1
    } else {
      throw new Error(`Unknown required Electron suite argument ${JSON.stringify(flag)}`)
    }
  }
  if (!platform) throw new Error('--platform is required')
  return { platform, ...(group ? { group } : {}) }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const result = await runRequiredElectronSuites(options.platform, options)
  if (result.status === 'failed') process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    console.error('[electron:required] suite runner failed')
    process.exitCode = 1
  })
}
