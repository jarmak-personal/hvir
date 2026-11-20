import { createRequire } from 'node:module'
import { isAbsolute, resolve, join, dirname } from 'node:path'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { digest, repository } from './artifacts.mts'
import { execute } from './source.mts'

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
  presentation?: 'gpu' | 'pixels',
  ozone?: 'x11' | 'wayland',
  largeViewport = false,
): Promise<Record<string, unknown>> {
  if (typeof largeViewport !== 'boolean' || (largeViewport && presentation !== 'pixels'))
    throw new Error('native-electron-probe: large viewport requires explicit pixels')
  const selectedOzone: string | undefined =
    ozone ?? process.env['HVIR_NATIVE_TERMINAL_OZONE']
  if (
    selectedOzone !== undefined &&
    selectedOzone !== 'x11' &&
    selectedOzone !== 'wayland'
  )
    throw new Error('native-electron-probe: Ozone must be x11|wayland')
  if (selectedOzone && process.platform !== 'linux' && !launch)
    throw new Error('native-electron-probe: explicit Ozone requires Linux')
  if (!isAbsolute(library))
    throw new Error('native-electron-probe: absolute library required')
  const binary: unknown = launch?.binary ?? createRequire(import.meta.url)('electron')
  if (typeof binary !== 'string')
    throw new Error('native-electron-probe: missing Electron')
  const timeoutMs = launch?.timeoutMs ?? 75_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 75_000)
    throw new Error('native-electron-probe: invalid deadline')
  const entry =
    launch?.entry ??
    resolve(
      repository,
      presentation
        ? 'out/main/native-terminal-presenter-probe.js'
        : 'out/main/native-terminal-probe.js',
    )
  let entryIsFile = false
  try {
    entryIsFile = (await stat(entry)).isFile()
  } catch {
    // A missing build entry must not open Electron's blocking error dialog.
  }
  if (!entryIsFile)
    throw new Error(
      'native-electron-probe: regular built entry required; build mode native-terminal-probe',
    )
  const started = performance.now()
  const profile = await mkdtemp(join(tmpdir(), 'hvir-native-electron-'))
  const child = spawn(
    binary,
    [
      entry,
      `--library=${library}`,
      `--user-data-dir=${profile}`,
      ...(presentation === 'pixels' ? ['--compatibility'] : []),
      ...(largeViewport ? ['--large-viewport'] : []),
      ...(selectedOzone ? [`--ozone-platform=${selectedOzone}`] : []),
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(selectedOzone ? { HVIR_NATIVE_TERMINAL_OZONE: selectedOzone } : {}),
      },
    },
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
    let fatal = false
    let stderrTail = ''
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
      if (!retain) {
        const diagnostic = stderrTail + data.toString('utf8')
        fatal ||= diagnostic.includes('native-probe:uncaught')
        stderrTail = diagnostic.slice(-32)
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
      if (code !== 0 || signal || fatal) {
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
      proof.orientationQualified !== Boolean(presentation) ||
      proof.receiverSandboxed !== true ||
      proof.receiverContextIsolated !== true ||
      proof.realGhostty !== true ||
      !Number.isSafeInteger(proof.utilityPid) ||
      (proof.utilityPid as number) <= 0 ||
      proof.utilityPid === pid
    )
      throw new Error('native-electron-probe: invalid receipt identity or isolation')
    if (
      presentation &&
      !nativePresenterReceiptMatches(
        proof,
        presentation === 'pixels' ||
          (process.platform === 'linux' &&
            process.env['HVIR_NATIVE_TERMINAL_PRESENTATION'] === 'pixels')
          ? 'pixels'
          : 'auto',
        process.platform,
        largeViewport,
      )
    )
      throw new Error('native-electron-probe: invalid presenter receipt')
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
    await rm(profile, { recursive: true, force: true })
  }
}

/** Auto may use Linux compatibility; an explicit pixels request must actually copy. */
export function nativePresenterReceiptMatches(
  proof: Record<string, unknown>,
  requested: 'auto' | 'pixels',
  platform: string,
  largeViewport = false,
): boolean {
  if (
    proof.nativePresenter !== 'passed' ||
    proof.finalUtilityExit !== true ||
    proof.requestedPresentation !== requested ||
    (largeViewport &&
      (requested !== 'pixels' ||
        !largeViewportReceiptMatches(proof.largeViewportDiagnostic)))
  )
    return false
  if (proof.mode === 'native-gpu')
    return (
      requested === 'auto' &&
      proof.routineGpuReadbacks === 0 &&
      proof.frameCopies === 0 &&
      proof.nativePixelFrames === 0
    )
  return (
    proof.mode === 'native-pixels' &&
    (requested === 'pixels' || platform === 'linux') &&
    typeof proof.frameCopies === 'number' &&
    proof.frameCopies > 0 &&
    proof.routineGpuReadbacks === null &&
    proof.compatibilityInvalidExtentRefused === true &&
    proof.compatibilitySampleUploadBytes === 2050 * 2048 * 4 &&
    compatibilityExtentMatches(proof.compatibilityExtent)
  )
}

function presenterFields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function compatibilityExtentMatches(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const row = presenterFields(value),
    grant = presenterFields(row.grant),
    drawn = presenterFields(row.drawn),
    invalid = presenterFields(row.invalidExtent)
  return (
    row.byteLength === 2050 * 2048 * 4 &&
    row.stride === 2050 * 4 &&
    grant.width === 2050 &&
    grant.height === 2048 &&
    grant.backingScale === 2 &&
    drawn.geometrySerial === grant.geometrySerial &&
    Number.isSafeInteger(grant.geometrySerial) &&
    Number(grant.geometrySerial) > 0 &&
    drawn.nativeEpoch === grant.nativeEpoch &&
    drawn.attachment === grant.attachment &&
    typeof grant.nativeEpoch === 'string' &&
    grant.nativeEpoch.length > 0 &&
    Number.isSafeInteger(grant.attachment) &&
    Number(grant.attachment) > 0 &&
    row.parserProgress === true &&
    row.sameActorRecovered === true &&
    invalid.code === 'native-presentation-geometry-invalid' &&
    Number.isSafeInteger(invalid.frameCopiesBefore) &&
    Number(invalid.frameCopiesBefore) > 0 &&
    invalid.frameCopiesAfter === invalid.frameCopiesBefore
  )
}

/** Bare presenter successes do not qualify workbench UI, memory or physical displays. */
function largeViewportReceiptMatches(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const report = value as Record<string, unknown>
  return (
    report.observationOwner === 'presenter' &&
    report.uiShrinkRecoveryQualified === false &&
    report.physicalDisplayQualified === false &&
    Array.isArray(report.cases) &&
    report.cases.length === 2 &&
    report.cases.every((value: unknown, index: number) => {
      if (!value || typeof value !== 'object') return false
      const row = value as Record<string, unknown>
      const applied = row.applied as Record<string, unknown> | undefined
      const grant = row.grant as Record<string, unknown> | undefined
      const upload = presenterFields(row.upload),
        uploadedGrant = presenterFields(upload.grant)
      const drawn = row.drawn as Record<string, unknown> | undefined
      const after = row.after as Record<string, unknown> | undefined
      const parserAfter = presenterFields(row.parserAfter)
      const before = row.before as Record<string, unknown> | undefined
      const pixels = row.pixels as Record<string, number> | undefined
      const canvas = row.canvas as Record<string, number> | undefined
      const width = [3840, 5120][index]!,
        height = [2160, 2880][index]!
      const recovered = (value: unknown): boolean => {
        if (!value || typeof value !== 'object') return false
        const recovery = presenterFields(value),
          pixels = presenterFields(recovery.pixels),
          facts = presenterFields(recovery.facts),
          geometry = presenterFields(facts.geometry)
        return (
          recovery.stage === 'complete' &&
          recovery.outcome === 'drawn' &&
          recovery.error === null &&
          recovery.observation === 'presenter-compositor-colors' &&
          Number.isFinite(pixels.redTop) &&
          Number(pixels.redTop) > 100 &&
          Number.isFinite(pixels.blueBottom) &&
          Number(pixels.blueBottom) > 100 &&
          geometry.width === 320 &&
          geometry.height === 192 &&
          facts.failure === 0 &&
          facts.rendererHealth === 0
        )
      }
      return (
        row.actor === 'presenter-first' &&
        row.instance === 'presenter-first-instance' &&
        typeof row.view === 'string' &&
        row.view.length > 0 &&
        row.stage === 'complete' &&
        row.outcome === 'drawn' &&
        row.sameActor === true &&
        row.failure === undefined &&
        row.error === undefined &&
        !!applied &&
        applied.width === width &&
        applied.height === height &&
        applied.backingScale === 1 &&
        Number.isSafeInteger(applied.serial) &&
        Number(applied.serial) > 0 &&
        grant?.viewId === row.view &&
        grant?.width === width &&
        grant?.height === height &&
        grant?.backingScale === 1 &&
        grant?.geometrySerial === applied.serial &&
        typeof grant?.nativeEpoch === 'string' &&
        grant.nativeEpoch.length > 0 &&
        Number.isSafeInteger(grant?.attachment) &&
        Number(grant?.attachment) > 0 &&
        upload.stride === width * 4 &&
        upload.byteLength === width * height * 4 &&
        uploadedGrant.viewId === row.view &&
        uploadedGrant.geometrySerial === applied.serial &&
        uploadedGrant.width === width &&
        uploadedGrant.height === height &&
        uploadedGrant.backingScale === 1 &&
        uploadedGrant.attachment === grant?.attachment &&
        uploadedGrant.nativeEpoch === grant?.nativeEpoch &&
        drawn?.geometrySerial === applied.serial &&
        drawn?.attachment === grant?.attachment &&
        drawn?.nativeEpoch === grant?.nativeEpoch &&
        canvas?.width === width &&
        canvas?.height === height &&
        !!before &&
        !!after &&
        Number.isSafeInteger(before.frameCopies) &&
        Number.isSafeInteger(after.frameCopies) &&
        Number(after.frameCopies) > Number(before.frameCopies) &&
        after.failure === 0 &&
        after.rendererHealth === 0 &&
        parserAfter.failure === 0 &&
        parserAfter.rendererHealth === 0 &&
        Number.isSafeInteger(after.ioAppliedSequence) &&
        Number.isSafeInteger(parserAfter.ioAppliedSequence) &&
        Number(parserAfter.ioAppliedSequence) > Number(after.ioAppliedSequence) &&
        !!pixels &&
        Number.isFinite(pixels.redTop) &&
        pixels.redTop! > 100 &&
        Number.isFinite(pixels.blueBottom) &&
        pixels.blueBottom! > 100 &&
        row.parserProgress === true &&
        recovered(row.initial) &&
        recovered(row.shrink) &&
        recovered(row.hideReveal)
      )
    })
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const argument = args.find((value) => value.startsWith('--library='))
  const presenter = args.includes('--presenter')
  const compatibility = args.includes('--compatibility')
  const largeViewport = args.includes('--large-viewport')
  const ozoneArgument = args.find((value) => value.startsWith('--ozone-platform='))
  const ozone = ozoneArgument?.slice('--ozone-platform='.length)
  if (ozone !== undefined && ozone !== 'x11' && ozone !== 'wayland')
    throw new Error('native-electron-probe: Ozone must be x11|wayland')
  if (
    ozone &&
    process.env['HVIR_NATIVE_TERMINAL_OZONE'] &&
    process.env['HVIR_NATIVE_TERMINAL_OZONE'] !== ozone
  )
    throw new Error('native-electron-probe: conflicting Ozone selections')
  if (
    !argument ||
    args.length !==
      1 +
        Number(presenter) +
        Number(compatibility) +
        Number(largeViewport) +
        Number(Boolean(ozoneArgument)) ||
    (compatibility && !presenter) ||
    (largeViewport && !compatibility)
  )
    throw new Error(
      'Usage: run-electron-probe.mts --library=ABS_PATH [--presenter [--compatibility [--large-viewport]]] [--ozone-platform=x11|wayland]',
    )
  const library = argument.slice('--library='.length)
  const source = (
    await execute('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      timeout: 5000,
      maxBuffer: 65536,
    })
  ).stdout.trim()
  const dirty = Boolean(
    (
      await execute('git', ['status', '--porcelain'], {
        cwd: repository,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim(),
  )
  const manifestSha256 = await digest(join(dirname(library), 'manifest.json')).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    },
  )
  console.log(
    'HVIR_NATIVE_PROBE_INPUT ' +
      JSON.stringify({
        source,
        dirty,
        librarySha256: await digest(library),
        manifestSha256,
      }),
  )
  await runNativeElectronProbe(
    library,
    undefined,
    presenter ? (compatibility ? 'pixels' : 'gpu') : undefined,
    ozone,
    largeViewport,
  )
}
