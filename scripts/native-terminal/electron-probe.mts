/** Standalone actual utility/Ghostty/OS-right/Electron proof, outside production sessions. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, sharedTexture } from 'electron'
import { localPath } from '../../src/shared/host-path'
import type { NativeTerminalSession } from '../../src/shared/native-terminal'
import {
  NativeTerminalHost,
  type NativeTerminalAcquiredFrame,
  type NativeTerminalAuthority,
} from '../../src/main/terminal/native-terminal-host'
import { NativeTerminalFrameImports } from '../../src/main/terminal/native-terminal-import'
import { NativeTerminalProcess } from '../../src/main/terminal/native-terminal-process'
import { UI_RESPONSIVENESS_BUDGET as budgets } from '../../src/shared/ui-responsiveness-budget'

const library = process.argv
  .find((arg) => arg.startsWith('--library='))
  ?.slice('--library='.length)
if (!library) throw new Error('native-probe requires --library=ABSOLUTE_TRUSTED_LIBRARY')
let window: BrowserWindow | undefined
let processPort: NativeTerminalProcess | undefined
let host: NativeTerminalHost | undefined
app.on('window-all-closed', () => {
  /* Qualification owns its asynchronous final cleanup. */
})
const timeout = setTimeout(() => {
  console.error('native-probe:deadline')
  app.exit(1)
}, 60000)
void app
  .whenReady()
  .then(async () => {
    let mainBeats = 0,
      rendererBeats = 0
    const phases: {
      id: number
      name: 'native' | 'transfer'
      main: number[]
      renderer: number[]
    }[] = []
    let measuring: (typeof phases)[number] | undefined
    let lastMainBeat = performance.now()
    const heartbeat = setInterval(() => {
      mainBeats++
      const now = performance.now()
      if (measuring) {
        assert(measuring.main.length < 12000)
        measuring.main.push(now - lastMainBeat)
      }
      lastMainBeat = now
    }, 5)
    window = new BrowserWindow({
      show: false,
      width: 640,
      height: 400,
      webPreferences: {
        preload: join(__dirname, '../preload/native-terminal-probe.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    const target = window
    const received: {
      bytes: number
      hash: number
      different: boolean
      redPixels: number
      readbackMs: number
      hashMaxSliceMs: number
    }[] = []
    let receiverSandboxed = false
    let receiverContextIsolated = false
    let readyCount = 0
    let ready!: () => void
    const receiverReady = new Promise<void>((resolve) => {
      ready = resolve
    })
    ipcMain.on(
      'native-probe-ready',
      (event, value: { sandboxed: boolean; contextIsolated: boolean }) => {
        if (event.sender === target.webContents) {
          assert.equal(value.sandboxed, true)
          assert.equal(value.contextIsolated, true)
          receiverSandboxed = value.sandboxed
          receiverContextIsolated = value.contextIsolated
          readyCount++
          ready()
        }
      },
    )
    ipcMain.on(
      'native-probe-heartbeat',
      (event, value: { phase?: number; gapMs: number }) => {
        if (event.sender !== target.webContents) return
        rendererBeats++
        const phase = phases.find((entry) => entry.id === value.phase)
        if (phase) {
          assert(Number.isFinite(value.gapMs) && value.gapMs >= 0)
          assert(phase.renderer.length < 12000)
          phase.renderer.push(value.gapMs)
        }
      },
    )
    let phaseId = 0
    const measure = async (name?: 'native' | 'transfer'): Promise<void> => {
      if (measuring) {
        await until(
          () =>
            !!measuring && measuring.main.length >= 2 && measuring.renderer.length >= 2,
        )
        measuring.main.push(performance.now() - lastMainBeat)
        measuring = undefined
      }
      const id = ++phaseId
      const next = name
        ? { id, name, main: [] as number[], renderer: [] as number[] }
        : undefined
      if (next) phases.push(next)
      const acknowledged = new Promise<void>((resolve) => {
        const done = (event: Electron.IpcMainEvent, value: { id: number }): void => {
          if (event.sender === target.webContents && value.id === id) {
            ipcMain.removeListener('native-probe-phase-ready', done)
            resolve()
          }
        }
        ipcMain.on('native-probe-phase-ready', done)
      })
      target.webContents.send('native-probe-phase', { id, name })
      await acknowledged
      measuring = next
      lastMainBeat = performance.now()
    }
    ipcMain.on(
      'native-probe-frame',
      (
        event,
        value: {
          bytes: number
          hash: number
          different: boolean
          redPixels: number
          readbackMs: number
          hashMaxSliceMs: number
        },
      ) => {
        if (event.sender === target.webContents) received.push(value)
      },
    )
    ipcMain.on('native-probe-failure', () => {
      throw new Error('native-probe-renderer-readback')
    })
    await target.loadURL(
      'data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27"><title>Native boundary probe</title>',
    )
    await receiverReady
    phase('prepare')
    await measure('native')
    const sessions = new Map<string, NativeTerminalSession>()
    const session = (id: string): NativeTerminalSession => ({
      sessionId: id,
      instanceId: `pty-${id}`,
      ownerId: target.webContents.id,
      ownerGeneration: 1,
      workspaceRoot: localPath('/native-probe'),
    })
    processPort = new NativeTerminalProcess(library, __dirname)
    let rendererGeneration = 1
    const authority: NativeTerminalAuthority = {
      resolve: (id) => sessions.get(id),
      isRendererCurrent: (id, generation) =>
        id === target.webContents.id &&
        generation === rendererGeneration &&
        !target.isDestroyed() &&
        !target.webContents.isCrashed(),
    }
    host = new NativeTerminalHost(processPort, authority)
    const first = session('first'),
      second = session('second')
    sessions.set(first.sessionId, first)
    sessions.set(second.sessionId, second)
    const [a, b] = await Promise.all([
      host.prepare(first, 640, 384),
      host.prepare(second, 640, 384),
    ])
    const epoch = processPort.epoch,
      utilityPid = processPort.pid
    assert(utilityPid && utilityPid !== process.pid)
    phase(`utility-ready pid=${utilityPid}`)
    const attachA = host.attach(a, first),
      attachB = host.attach(b, second)
    await Promise.all([
      host.feed(
        a,
        first.instanceId,
        Buffer.from('\x1b[48;2;255;0;0m NATIVE GHOSTTY BOUNDARY \x1b[0m\r\n'),
      ),
      host.feed(b, second.instanceId, Buffer.from('independent second terminal\r\n')),
    ])
    await host.inspect(a, first.ownerId, 1)
    await host.inspect(b, second.ownerId, 1)
    const frame = await completedFrame(host, a, first, attachA, 1)
    const kind = frame.metadata.kind
    const importTimes: number[] = []
    let importOrdinal = 0
    const measuredTextures: Pick<
      Electron.SharedTexture,
      'importSharedTexture' | 'sendSharedTexture'
    > = {
      importSharedTexture: (options) => {
        const start = performance.now()
        const ordinal = ++importOrdinal
        const result = sharedTexture.importSharedTexture({
          ...options,
          allReferencesReleased: () => {
            phase(`import-${ordinal}-all-references-released`)
            options.allReferencesReleased?.()
          },
        })
        importTimes.push(performance.now() - start)
        return {
          ...result,
          release: () => {
            phase(`import-${ordinal}-main-release-enter`)
            result.release()
            phase(`import-${ordinal}-main-release-return`)
          },
        }
      },
      sendSharedTexture: (...args) => sharedTexture.sendSharedTexture(...args),
    }
    let releasedReceipts = 0
    const resources = (port: NativeTerminalProcess) => ({
      receive: (ticket: string) => port.receive(ticket),
      release: (receipt: Parameters<NativeTerminalProcess['release']>[0]): void => {
        phase('receipt-release-enter')
        port.release(receipt)
        releasedReceipts++
        phase('receipt-release-return')
      },
    })
    const textures = new NativeTerminalFrameImports(
      resources(processPort),
      measuredTextures,
    )
    phase('import')
    await measure('transfer')
    if (kind === 1 || kind === 2) {
      assert.equal(frame.metadata.streamSequence, 1)
      const readback = Buffer.from(await host.read(a, first.ownerId, 1)).toString('utf8')
      assert(readback.includes('NATIVE GHOSTTY BOUNDARY'))
      const imported = await textures.acquire(frame, {
        frame: target.webContents.mainFrame,
        ready: true,
        isCurrent: () => !target.isDestroyed(),
      })
      await imported.send()
      await imported.released
      assert.equal(received.length, 1)
      assert(received[0]?.different, 'actual terminal frame has nonuniform pixels')
      assert(
        (received[0]?.redPixels ?? 0) > 100,
        'fed red ANSI background reached renderer',
      )
    } else {
      assert.equal(process.platform, 'linux')
      await frame.release()
    }
    await measure()
    // A retained second state remains independent; clean final-state shutdown is reusable.
    await host.resize(b, second.ownerId, 1, attachB, 2, 720, 384)
    await host.end(a, first.instanceId)
    await host.end(b, second.instanceId)
    assert.equal(processPort.pid, undefined)
    assert.notEqual(processPort.epoch, epoch)
    const c = await host.prepare(first, 640, 384)
    assert(processPort.pid && processPort.pid !== utilityPid)
    phase(`utility-ready pid=${String(processPort.pid)}`)
    let producerDeathHeld = 'not-applicable-owned-pixels'
    if (kind === 1 || kind === 2) {
      const attachment = host.attach(c, first)
      await host.feed(
        c,
        first.instanceId,
        Buffer.from('\x1b[48;2;255;0;0m HELD THROUGH PRODUCER DEATH \x1b[0m\r\n'),
      )
      await host.inspect(c, first.ownerId, 1)
      await armHold(target)
      const source = await completedFrame(host, c, first, attachment, 1)
      const importer = new NativeTerminalFrameImports(
        resources(processPort),
        measuredTextures,
      )
      const held = await importer.acquire(source, {
        frame: target.webContents.mainFrame,
        ready: true,
        isCurrent: () => !target.isDestroyed(),
      })
      const prior = received.length
      await held.send()
      await until(() => received.length > prior)
      const crashedPid = processPort.pid
      assert(crashedPid)
      phase('producer-death')
      process.kill(crashedPid, 'SIGKILL')
      await until(() => !processPort?.available)
      const checked = new Promise<{ redPixels: number }>((resolve) =>
        ipcMain.once('native-probe-held-valid', (_event, value: { redPixels: number }) =>
          resolve(value),
        ),
      )
      target.webContents.send('native-probe-check-held')
      assert(
        (await checked).redPixels > 100,
        'receiver retains real pixels after producer death',
      )
      const beforeRelease = releasedReceipts
      target.webContents.send('native-probe-release-held')
      await held.released
      assert.equal(
        processPort.hasExited(processPort.epoch),
        true,
        'owned producer exit confirmed for this epoch',
      )
      assert.equal(
        releasedReceipts,
        beforeRelease + 1,
        'main OS receipt released after final consumer and confirmed producer death',
      )
      assert.equal(processPort.available, false)
      producerDeathHeld =
        'passed-held-pixels-and-reclamation-after-confirmed-producer-exit'
    } else {
      const crashedPid = processPort.pid
      assert(crashedPid)
      phase('producer-death')
      process.kill(crashedPid, 'SIGKILL')
      await until(() => !processPort?.available)
    }
    await assert.rejects(
      host.feed(c, first.instanceId, Buffer.from('must not reach lost state')),
    )
    assert.equal(sessions.get(first.sessionId)?.instanceId, first.instanceId)
    host.dispose()
    const invalid = new NativeTerminalProcess(`${library}.missing`, __dirname)
    await assert.rejects(invalid.request({ kind: 'create', width: 640, height: 384 }))
    invalid.dispose()
    const shutdown = new NativeTerminalProcess(library, __dirname)
    const pending = shutdown.request({ kind: 'create', width: 640, height: 384 })
    shutdown.dispose()
    await assert.rejects(pending)
    let timeoutQuarantine: string = 'not-applicable-owned-pixels'
    processPort = new NativeTerminalProcess(library, __dirname)
    host = new NativeTerminalHost(processPort, authority)
    const d = await host.prepare(first, 640, 384)
    phase(`utility-ready pid=${String(processPort.pid)}`)
    let consumerDeathHeld = 'not-applicable-owned-pixels'
    if (kind === 1 || kind === 2) {
      const attachment = host.attach(d, first)
      await host.feed(d, first.instanceId, Buffer.from('consumer crash fixture\r\n'))
      await host.inspect(d, first.ownerId, 1)
      await armHold(target)
      const consumerSource = await completedFrame(host, d, first, attachment, 1)
      const importer = new NativeTerminalFrameImports(
        resources(processPort),
        measuredTextures,
      )
      const retained = await importer.acquire(consumerSource, {
        frame: target.webContents.mainFrame,
        ready: true,
        isCurrent: () => !target.isDestroyed(),
      })
      const prior = received.length
      await retained.send()
      await until(() => received.length > prior)
      const crashed = new Promise<void>((resolve) =>
        target.webContents.once('render-process-gone', () => resolve()),
      )
      phase('consumer-crash')
      target.webContents.forcefullyCrashRenderer()
      await crashed
      await retained.released
      // A fresh renderer reattaches to the same immutable parser; no PTY restart.
      rendererGeneration++
      const renewed = { ...first, ownerGeneration: rendererGeneration }
      sessions.set(first.sessionId, renewed)
      const priorReady = readyCount
      await target.webContents.loadURL(
        'data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27">',
      )
      await until(() => readyCount > priorReady)
      const renewedAttachment = host.attach(d, renewed)
      await host.feed(
        d,
        first.instanceId,
        Buffer.from('parser retained after consumer death\r\n'),
      )
      const acknowledged = await host.inspect(d, first.ownerId, rendererGeneration)
      assert.equal(acknowledged.appliedSequence, 2)
      const recovered = await completedFrame(host, d, renewed, renewedAttachment, 2)
      await recovered.release()
      consumerDeathHeld = 'passed-real-renderer-crash-and-source-pool-recovery'
      const delayed = await completedFrame(host, d, renewed, renewedAttachment, 2)
      const receiverFrame = target.webContents.mainFrame
      const observedSource: NativeTerminalAcquiredFrame = {
        ...delayed,
        retire: async () => {
          phase('quarantine-source-retire-enter')
          await delayed.retire()
          phase('quarantine-source-retire-settled')
        },
        release: async () => {
          phase('quarantine-source-release-enter')
          await delayed.release()
          phase('quarantine-source-release-settled')
        },
      }
      const held = await importer.acquire(observedSource, {
        frame: target.webContents.mainFrame,
        ready: true,
        isCurrent: () => !target.isDestroyed(),
      })
      phase('quarantine')
      const beforeLateFrame = received.length
      const blocking = new Promise<void>((resolve) =>
        ipcMain.once('native-probe-block-started', () => resolve()),
      )
      target.webContents.send('native-probe-block')
      await blocking
      await assert.rejects(held.send())
      let physicallyReleased = false
      void held.released.then(() => {
        physicallyReleased = true
      })
      held.release()
      await until(() => received.length > beforeLateFrame)
      assert.equal(physicallyReleased, false, 'late consumer cannot bypass quarantine')
      target.destroy()
      phase('quarantine-target-destroyed')
      let frameDestroyed: boolean
      try {
        frameDestroyed = receiverFrame.isDestroyed()
      } catch {
        frameDestroyed = true
      }
      console.error(
        'native-probe:quarantine-target',
        JSON.stringify({
          windowDestroyed: target.isDestroyed(),
          frameDestroyed,
          producerExited: processPort.hasExited(processPort.epoch),
        }),
      )
      await held.released
      timeoutQuarantine = 'passed-real-electron-timeout-and-late-consumer'
    }
    phase('final-idle')
    await host.end(d, first.instanceId)

    clearInterval(heartbeat)
    assert(mainBeats > 0)
    assert(rendererBeats > 0)
    const responsiveness = phases.map((phase) => ({
      phase: phase.name,
      main: gapSummary(phase.main),
      renderer: gapSummary(phase.renderer),
    }))
    console.error(
      'native-probe:responsiveness',
      JSON.stringify({
        responsiveness,
        importTimesMs: importTimes,
        readbacks: received.map(({ readbackMs, hashMaxSliceMs }) => ({
          readbackMs,
          hashMaxSliceMs,
        })),
      }),
    )
    assert.equal(responsiveness.length, 2)
    for (const phase of responsiveness)
      for (const loop of [phase.main, phase.renderer]) {
        assert(loop.samples >= 2)
        assert(loop.p99Ms < budgets.responsivenessP99Ms, 'native-probe-heartbeat-p99')
        assert(
          loop.maxMs <= budgets.responsivenessMaxMs,
          'native-probe-heartbeat-maximum',
        )
      }
    const importMaxMs = importTimes.length ? Math.max(...importTimes) : 0
    if (kind === 1 || kind === 2) assert(importTimes.length > 0)
    assert(importTimes.every((value) => Number.isFinite(value) && value >= 0))
    assert(importMaxMs <= budgets.responsivenessMaxMs, 'native-probe-main-import-maximum')
    phase('receipt-flush')
    const receipt = JSON.stringify({
      nativeUtilityBoundary: 'passed',
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      napi: process.versions.napi,
      gpuImport: kind === 1 || kind === 2 ? 'passed' : 'unavailable-owned-pixels',
      actualDmaBufImport: process.platform === 'linux' && kind === 2,
      hardwareGpuQualified: false,
      orientationQualified: false,
      receiverSandboxed,
      receiverContextIsolated,
      realGhostty: true,
      resourceKind: kind,
      independentStates: 2,
      cleanIdleRestart: true,
      hostCrashRevocation: true,
      initFailure: true,
      shutdownBeforeInitialization: true,
      producerDeathHeld,
      releasedReceipts,
      consumerDeathHeld,
      timeoutQuarantine,
      utilityPid,
      mainPid: process.pid,
      mainBeats,
      rendererBeats,
      importTimesMs: importTimes,
      responsiveness,
      responsivenessPolicy: {
        p99ExclusiveMs: budgets.responsivenessP99Ms,
        maximumInclusiveMs: budgets.responsivenessMaxMs,
        minimumSamplesPerLoop: 2,
      },
      mainImportMaxMs: importMaxMs,
      mainImportMaximumInclusiveMs: budgets.responsivenessMaxMs,
      responsivenessExcludesFaultPhases: true,
      frames: received,
    })
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${receipt}\n`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    phase('receipt-flushed')
    host.dispose()
    if (!target.isDestroyed()) target.destroy()
    clearTimeout(timeout)
    phase('exit')
    app.exit(0)
  })
  .catch((error: unknown) => {
    phase('failure')
    console.error(error)
    host?.dispose()
    processPort?.dispose()
    if (window && !window.isDestroyed()) window.destroy()
    clearTimeout(timeout)
    app.exit(1)
  })

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('native-probe-condition-timeout')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

async function armHold(target: BrowserWindow): Promise<void> {
  const armed = new Promise<void>((resolve) =>
    ipcMain.once('native-probe-held-armed', () => resolve()),
  )
  target.webContents.send('native-probe-hold')
  await armed
}
async function completedFrame(
  host: NativeTerminalHost,
  handle: string,
  session: NativeTerminalSession,
  attachment: number,
  expectedStream: number,
): Promise<NativeTerminalAcquiredFrame> {
  const expected = (await host.inspect(handle, session.ownerId, session.ownerGeneration))
    .geometry
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const frame = await host.takeFrame(
      handle,
      session.ownerId,
      session.ownerGeneration,
      attachment,
    )
    if (frame) {
      if (
        frame.metadata.streamSequence === expectedStream &&
        frame.metadata.geometrySerial === expected.serial &&
        frame.metadata.width === expected.width &&
        frame.metadata.height === expected.height
      )
        return frame
      await frame.release()
      assert(
        frame.metadata.streamSequence <= expectedStream,
        'native-probe-unexpected-future-frame',
      )
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('native-probe-frame-timeout')
}
function gapSummary(values: number[]): { samples: number; p99Ms: number; maxMs: number } {
  assert(
    values.length >= 2 && values.every((value) => Number.isFinite(value) && value >= 0),
  )
  const sorted = [...values].sort((a, b) => a - b)
  return {
    samples: sorted.length,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1]!,
    maxMs: sorted[sorted.length - 1]!,
  }
}

function phase(name: string): void {
  console.error(`native-probe:phase ${name}`)
}
