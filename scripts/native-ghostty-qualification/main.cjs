/* global performance, process, __dirname, console, setInterval, clearInterval, setTimeout, Buffer */
// Explicitly invoked experiment; this is not an hvir application entry point.
const { app, BrowserWindow, ipcMain, sharedTexture, screen } = require('electron')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const bridge = require(process.env.HVIR_QUALIFICATION_BRIDGE)
const pty = require('node-pty')

let window
let timer
let closing = false
let external
let sent = 0
let released = 0
let transferring = false
const started = performance.now()
const observations = []
const lifetime = new Set()

function record(event) {
  const item = { atMs: Math.round(performance.now() - started), ...event }
  observations.push(item)
  console.log(JSON.stringify(item))
}

async function finish() {
  if (closing) return
  closing = true
  clearInterval(timer)
  external?.kill()
  external = undefined
  window?.destroy()
  const deadline = performance.now() + 5000
  while (lifetime.size && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20))
  record({ event: 'cleanup', sent, released, held: lifetime.size })
  if (!sent || lifetime.size) process.exitCode = 1
  try {
    bridge.stop()
  } catch (error) {
    record({ event: 'cleanup-error', error: String(error) })
    process.exitCode = 1
  }
  if (process.env.HVIR_QUALIFICATION_LOG)
    writeFileSync(
      process.env.HVIR_QUALIFICATION_LOG,
      JSON.stringify(observations, null, 2),
    )
  app.quit()
}

app.on('window-all-closed', () => void finish())
app.on('before-quit', () => clearInterval(timer))
process.on('SIGINT', () => void finish())
process.on('SIGTERM', () => void finish())
for (const failure of ['uncaughtException', 'unhandledRejection'])
  process.on(failure, (error) => {
    record({ event: 'failure', error: String(error) })
    process.exitCode = 1
    void finish()
  })
setTimeout(() => {
  if (!timer && !closing) {
    record({ event: 'failure', error: 'Receiver did not become ready within 20 seconds' })
    process.exitCode = 1
    void finish()
  }
}, 20000)
ipcMain.on('qualification:observation', (_event, data) => record(data))
ipcMain.on('qualification:key', (_event, text) => {
  if (!closing && typeof text === 'string' && text.length < 64)
    bridge.input(Buffer.from(text))
})
ipcMain.on('qualification:ready', () => {
  bridge.start()
  bridge.feed(
    Buffer.from('\x1b[2J\x1b[HNative Ghostty 1.4 → Metal → IOSurface → Electron\r\n'),
  )
  const initialSize = bridge.size()
  record({ event: 'native-size', ...initialSize })
  external = pty.spawn(
    '/bin/sh',
    [
      '-c',
      'stty -echo; printf "\\033[6n"; IFS= read -r reply; printf "RECEIVED:%s\\r\\n" "$reply"; stty size',
    ],
    {
      name: 'xterm-256color',
      cols: initialSize.cols,
      rows: initialSize.rows,
      cwd: '/tmp',
      env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
    },
  )
  external.onData((data) => {
    record({ event: 'local-pty-output', data })
    bridge.feed(Buffer.from(data))
  })
  external.onExit((exit) => {
    record({ event: 'local-pty-exit', ...exit })
    external = undefined
  })
  setTimeout(() => {
    if (closing || !external) return
    bridge.resize(1600, 1000)
    const size = bridge.size()
    external.resize(size.cols, size.rows)
    record({ event: 'local-pty-resize', ...size })
    bridge.input(Buffer.from('native-input\r'))
  }, 250)
  setTimeout(() => {
    if (!closing) bridge.resize(1920, 1200)
  }, 500)
  const workloadStart = performance.now()
  let lines = 0
  timer = setInterval(async () => {
    if (closing) return
    bridge.tick()
    const reply = bridge.drain()
    if (reply.length) {
      record({ event: 'native-output', data: reply.toString() })
      external?.write(reply.toString())
    }
    const elapsed = performance.now() - workloadStart
    if (elapsed > 750 && elapsed < 10000) {
      const output = Array.from(
        { length: 10 },
        () =>
          `\x1b[38;5;${16 + (lines++ % 216)}m${String(lines).padStart(6)} Ghostty native qualification αβ 🚀\x1b[0m\r\n`,
      ).join('')
      bridge.feed(Buffer.from(output))
    }
    if (transferring) return
    const frame = bridge.take()
    if (frame.copyErrors) throw new Error(`GPU copies failed: ${frame.copyErrors}`)
    if (!frame.ioSurface) return
    transferring = true
    const token = `${frame.slot}:${frame.serial}`
    lifetime.add(token)
    const imported = sharedTexture.importSharedTexture({
      textureInfo: {
        handle: { ioSurface: frame.ioSurface },
        codedSize: { width: frame.width, height: frame.height },
        pixelFormat: 'bgra',
        timestamp: Math.round(performance.now() * 1000),
      },
      allReferencesReleased() {
        bridge.release(frame.slot, frame.serial)
        lifetime.delete(token)
        released++
      },
    })
    try {
      await sharedTexture.sendSharedTexture(
        {
          frame: window.webContents.mainFrame,
          importedSharedTexture: imported,
        },
        {
          serial: frame.serial,
          produced: frame.produced,
          dropped: frame.dropped,
          copyMeanMs: frame.copyMeanMs,
          copyMaxMs: frame.copyMaxMs,
        },
      )
      sent++
    } catch (error) {
      // Destroying the receiver during normal shutdown may reject an in-flight send.
      if (!closing) {
        record({ event: 'transfer-error', error: String(error) })
        process.exitCode = 1
        void finish()
      }
    } finally {
      imported.release()
      transferring = false
    }
  }, 8)
  setTimeout(async () => {
    if (closing) return
    const image = await window.webContents.capturePage()
    const path = process.env.HVIR_QUALIFICATION_SCREENSHOT
    if (path) writeFileSync(path, image.toPNG())
    record({
      event: 'capture',
      size: image.getSize(),
      sent,
      released,
      gpu: app.getGPUFeatureStatus(),
    })
  }, 3500)
  setTimeout(() => {
    if (!closing) {
      window.hide()
      record({ event: 'hidden' })
    }
  }, 6500)
  setTimeout(() => {
    if (!closing) {
      window.show()
      record({ event: 'shown' })
    }
  }, 7500)
  setTimeout(() => void finish(), 13000)
})

app
  .whenReady()
  .then(async () => {
    record({
      event: 'environment',
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      display: screen.getPrimaryDisplay(),
      gpu: app.getGPUFeatureStatus(),
    })
    window = new BrowserWindow({
      width: 1000,
      height: 680,
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    window.on('close', (event) => {
      if (!closing) {
        event.preventDefault()
        void finish()
      }
    })
    await window.loadFile(join(__dirname, 'window.html'))
  })
  .catch((error) => {
    record({ event: 'failure', error: String(error) })
    void finish()
  })
