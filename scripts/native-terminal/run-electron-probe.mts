import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
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
  const dumpOwnedGroup = (): void => {
    if (!pid) return
    const snapshot = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,comm='], {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 1024 * 1024,
    })
    const members = (snapshot.stdout ?? '').split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
      return match && Number(match[3]) === pid
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              group: Number(match[3]),
              state: match[4],
              command: match[5],
            },
          ]
        : []
    })
    const identities = members.length
      ? (spawnSync(
          'ps',
          ['-p', members.map((member) => member.pid).join(','), '-o', 'pid=,args='],
          {
            encoding: 'utf8',
            timeout: 1000,
            maxBuffer: 1024 * 1024,
          },
        ).stdout ?? '')
      : ''
    const types = identities.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (!match || !members.some((member) => member.pid === Number(match[1]))) return []
      return [
        {
          pid: Number(match[1]),
          type: /(?:^|\s)--type=([a-z-]+)(?:\s|$)/.exec(match[2]!)?.[1] ?? 'browser',
          utilitySubtype: /(?:^|\s)--utility-sub-type=([A-Za-z0-9._-]+)(?:\s|$)/.exec(
            match[2]!,
          )?.[1],
        },
      ]
    })
    console.error(
      'native-probe:owned-group',
      JSON.stringify({
        leader: pid,
        exitCode: child.exitCode,
        signal: child.signalCode,
        members,
        types,
        snapshotError: snapshot.error?.message,
      }),
    )
  }
  // Failure-only Linux CI evidence. This timer cannot extend the acceptance deadline.
  let debuggerChild: ReturnType<typeof spawn> | undefined
  let diagnosticsClosed = false
  const stackTimer =
    !launch && process.platform === 'linux' && process.env.CI && pid
      ? setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) return
          const capture = (elevated: boolean): void => {
            const arguments_ = [
              '--nx',
              '-iex',
              'set auto-load off',
              '--batch',
              '-ex',
              'set pagination off',
              '-ex',
              'set print frame-arguments none',
              '-ex',
              'set print entry-values no',
              '-ex',
              'thread apply all bt',
              '-p',
              String(pid),
            ]
            const diagnostic = spawn(
              elevated ? 'sudo' : 'gdb',
              elevated ? ['-n', 'gdb', ...arguments_] : arguments_,
              { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
            )
            debuggerChild = diagnostic
            const chunks: Buffer[] = []
            let bytes = 0
            const stop = (): void => {
              if (!diagnostic.pid) return
              try {
                process.kill(-diagnostic.pid, 'SIGKILL')
              } catch {
                /* Already exited. */
              }
            }
            const timer = setTimeout(stop, 3000)
            const collect = (data: Buffer): void => {
              if (bytes + data.length > 64 * 1024) {
                stop()
                return
              }
              bytes += data.length
              chunks.push(data)
            }
            diagnostic.stdout?.on('data', collect)
            diagnostic.stderr?.on('data', collect)
            diagnostic.once('error', (error) => collect(Buffer.from(error.message)))
            diagnostic.once('close', (code, signal) => {
              clearTimeout(timer)
              const output = Buffer.concat(chunks).toString('utf8')
              try {
                console.error(
                  'native-probe:owned-main-stack',
                  JSON.stringify({
                    pid,
                    elevated,
                    code,
                    signal,
                    output,
                  }),
                )
              } catch {
                /* Diagnostic sinks cannot own acceptance. */
              }
              if (
                !diagnosticsClosed &&
                !expired &&
                !elevated &&
                /ptrace|operation not permitted/i.test(output)
              )
                capture(true)
            })
          }
          capture(false)
        }, 65000)
      : undefined
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
    child.once('exit', (code, signal) => {
      try {
        console.error('native-probe:process-exit', JSON.stringify({ pid, code, signal }))
      } catch {
        /* Diagnostics never own process settlement. */
      }
    })
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
      try {
        dumpOwnedGroup()
      } catch {
        /* Preserve the deadline even if its diagnostic sink fails. */
      } finally {
        fail(new Error('native-electron-probe: deadline exceeded'))
      }
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
    diagnosticsClosed = true
    if (stackTimer) clearTimeout(stackTimer)
    if (debuggerChild?.pid) {
      try {
        process.kill(-debuggerChild.pid, 'SIGKILL')
      } catch {
        /* Diagnostic exited. */
      }
    }
    debuggerChild?.stdout?.destroy()
    debuggerChild?.stderr?.destroy()
    debuggerChild?.unref()
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
