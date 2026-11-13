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
    const heartbeat = setInterval(() => mainBeats++, 5)
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
    ipcMain.on('native-probe-heartbeat', (event) => {
      if (event.sender === target.webContents) rendererBeats++
    })
    ipcMain.on(
      'native-probe-frame',
      (
        event,
        value: { bytes: number; hash: number; different: boolean; redPixels: number },
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
    let frame: NativeTerminalAcquiredFrame | undefined
    for (let i = 0; i < 100 && !frame; i++) {
      frame = await host.takeFrame(a, first.ownerId, 1, attachA)
      if (!frame) await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    assert(frame)
    const kind = frame.metadata.kind
    const importTimes: number[] = []
    const textures = new NativeTerminalFrameImports(processPort, {
      importSharedTexture: (options) => {
        const start = performance.now()
        const result = sharedTexture.importSharedTexture(options)
        importTimes.push(performance.now() - start)
        return result
      },
      sendSharedTexture: (...args) => sharedTexture.sendSharedTexture(...args),
    })
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
    // A retained second state remains independent; clean final-state shutdown is reusable.
    await host.resize(b, second.ownerId, 1, attachB, 2, 720, 384)
    await host.end(a, first.instanceId)
    await host.end(b, second.instanceId)
    assert.equal(processPort.pid, undefined)
    assert.notEqual(processPort.epoch, epoch)
    const c = await host.prepare(first, 640, 384)
    assert(processPort.pid && processPort.pid !== utilityPid)
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
      const source = await completedFrame(host, c, first, attachment)
      const importer = new NativeTerminalFrameImports(processPort, sharedTexture)
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
      target.webContents.send('native-probe-release-held')
      await held.released
      producerDeathHeld = 'passed-real-held-video-frame-survives-producer-death'
    } else {
      const crashedPid = processPort.pid
      assert(crashedPid)
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
    let consumerDeathHeld = 'not-applicable-owned-pixels'
    if (kind === 1 || kind === 2) {
      const attachment = host.attach(d, first)
      await host.feed(d, first.instanceId, Buffer.from('consumer crash fixture\r\n'))
      await host.inspect(d, first.ownerId, 1)
      await armHold(target)
      const consumerSource = await completedFrame(host, d, first, attachment)
      const importer = new NativeTerminalFrameImports(processPort, sharedTexture)
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
      const recovered = await completedFrame(host, d, renewed, renewedAttachment)
      await recovered.release()
      consumerDeathHeld = 'passed-real-renderer-crash-and-source-pool-recovery'
      const delayed = await completedFrame(host, d, renewed, renewedAttachment)
      const held = await importer.acquire(delayed, {
        frame: target.webContents.mainFrame,
        ready: true,
        isCurrent: () => !target.isDestroyed(),
      })
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
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      assert.equal(physicallyReleased, false, 'late consumer cannot bypass quarantine')
      target.destroy()
      await held.released
      timeoutQuarantine = 'passed-real-electron-timeout-and-late-consumer'
    }
    await host.end(d, first.instanceId)

    clearInterval(heartbeat)
    assert(mainBeats > 0)
    assert(rendererBeats > 0)
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
      consumerDeathHeld,
      timeoutQuarantine,
      utilityPid,
      mainPid: process.pid,
      mainBeats,
      rendererBeats,
      importTimesMs: importTimes,
      frames: received,
    })
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${receipt}\n`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    host.dispose()
    if (!target.isDestroyed()) target.destroy()
    clearTimeout(timeout)
    app.exit(0)
  })
  .catch((error: unknown) => {
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
): Promise<NativeTerminalAcquiredFrame> {
  for (let i = 0; i < 100; i++) {
    const frame = await host.takeFrame(
      handle,
      session.ownerId,
      session.ownerGeneration,
      attachment,
    )
    if (frame) return frame
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('native-probe-frame-timeout')
}
