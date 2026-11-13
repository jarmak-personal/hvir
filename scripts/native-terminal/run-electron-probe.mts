import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { repository } from './artifacts.mts'

interface ProbeLaunch {
  /** Fixture-only injection; the CLI always uses the installed Electron and fixed entry. */
  binary: string
  entry: string
  timeoutMs: number
}
/** Own one probe process group, including descendants that retain inherited pipes. */
export async function runNativeElectronProbe(
  library: string,
  launch?: ProbeLaunch,
): Promise<Record<string, unknown>> {
  if (!isAbsolute(library))
    throw new Error('native-electron-probe: absolute library required')
  const binary: unknown = launch?.binary ?? createRequire(import.meta.url)('electron')
  if (typeof binary !== 'string')
    throw new Error('native-electron-probe: missing Electron')
  const timeoutMs = launch?.timeoutMs ?? 75_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 75_000)
    throw new Error('native-electron-probe: invalid deadline')
  const started = performance.now()
  const child = spawn(
    binary,
    [
      launch?.entry ?? resolve(repository, 'out/main/native-terminal-probe.js'),
      `--library=${library}`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const pid = child.pid
  let expired = false
  const killOwnedGroup = (): void => {
    if (!pid) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  let watchdog: NodeJS.Timeout | undefined
  let interrupt: ((signal: NodeJS.Signals) => void) | undefined
  const sigint = (): void => interrupt?.('SIGINT')
  const sigterm = (): void => interrupt?.('SIGTERM')
  const execution = new Promise<string>((resolveOutput, reject) => {
    const stdout: Buffer[] = []
    let bytes = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    interrupt = (signal) =>
      fail(new Error(`native-electron-probe: interrupted ${signal}`))
    process.once('SIGINT', sigint)
    process.once('SIGTERM', sigterm)
    const capture = (data: Buffer, output: NodeJS.WriteStream, retain: boolean): void => {
      if (settled) return
      bytes += data.length
      if (bytes > 256 * 1024) {
        fail(new Error('native-electron-probe: output bound exceeded'))
        return
      }
      output.write(data)
      if (retain) stdout.push(data)
    }
    child.stdout?.on('data', (data: Buffer) => capture(data, process.stdout, true))
    child.stderr?.on('data', (data: Buffer) => capture(data, process.stderr, false))
    child.once('error', fail)
    child.once('close', (code, signal) => {
      if (settled) return
      if (code !== 0 || signal) {
        fail(new Error('native-electron-probe: unsuccessful exit'))
        return
      }
      settled = true
      resolveOutput(Buffer.concat(stdout).toString('utf8'))
    })
    // This deadline remains live after the main child exits: inherited pipes may
    // still belong to utility descendants in this same owned process group.
    watchdog = setTimeout(() => {
      expired = true
      fail(new Error('native-electron-probe: deadline exceeded'))
    }, timeoutMs)
  })
  try {
    const stdout = await execution
    if (expired || performance.now() - started > timeoutMs)
      throw new Error('native-electron-probe: deadline exceeded')
    if (!pid) throw new Error('native-electron-probe: incomplete process')
    const records: Record<string, unknown>[] = stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((value) => value.nativeUtilityBoundary === 'passed')
    if (records.length !== 1)
      throw new Error('native-electron-probe: exactly one receipt required')
    const proof = records[0]!
    if (
      proof.mainPid !== pid ||
      proof.platform !== process.platform ||
      proof.arch !== process.arch ||
      proof.hardwareGpuQualified !== false ||
      proof.orientationQualified !== false ||
      proof.receiverSandboxed !== true ||
      proof.receiverContextIsolated !== true ||
      proof.realGhostty !== true ||
      !Number.isSafeInteger(proof.utilityPid) ||
      (proof.utilityPid as number) <= 0 ||
      proof.utilityPid === pid
    )
      throw new Error('native-electron-probe: invalid receipt identity or isolation')
    return proof
  } finally {
    process.off('SIGINT', sigint)
    process.off('SIGTERM', sigterm)
    if (watchdog) clearTimeout(watchdog)
    killOwnedGroup()
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.unref()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv[2]
  if (process.argv.length !== 3 || !argument?.startsWith('--library='))
    throw new Error('Usage: run-electron-probe.mts --library=ABS_PATH')
  await runNativeElectronProbe(argument.slice('--library='.length))
}
