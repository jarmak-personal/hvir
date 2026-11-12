/* global process, __dirname, console, performance, setInterval, clearInterval, clearTimeout, setTimeout, Buffer */
// Explicit experiment entry point, shared by the native and installed-web comparisons.
const { app, BrowserWindow, ipcMain, sharedTexture, screen } = require('electron')
const { join } = require('node:path')
const { writeFileSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const engine = process.env.HVIR_QUALIFICATION_ENGINE || 'native'
const interactive = process.env.HVIR_QUALIFICATION_INTERACTIVE === '1'
if (!['native', 'web'].includes(engine)) throw new Error('Expected native or web engine')
const bridge =
  engine === 'native' ? require(process.env.HVIR_QUALIFICATION_BRIDGE) : undefined
const scratch = mkdtempSync(join(tmpdir(), 'hvir-qualification-window-'))
app.setPath('userData', join(scratch, 'user-data'))
const configPath = join(scratch, 'ghostty-config')
writeFileSync(
  configPath,
  'font-family = Menlo\nfont-size = 14\nadjust-cell-width = 1\nadjust-cell-height = -3\nwindow-padding-x = 0\nwindow-padding-y = 0\ncursor-style-blink = false\nshell-integration = none\nscrollback-limit = 10000000\n',
)
let window, timer, watchdog
let closing = false,
  transferring = false,
  initialized = false
let sent = 0,
  released = 0
let lastFrame
const leases = new Set()
const result = { engine, interactive, phases: [], observations: [] }
function observe(data) {
  result.observations.push(data)
  console.log(JSON.stringify(data))
}
async function finish() {
  if (closing) return
  closing = true
  clearInterval(timer)
  clearTimeout(watchdog)
  window?.destroy()
  const deadline = performance.now() + 5000
  while (leases.size && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20))
  const cleanup = { event: 'cleanup', sent, released, held: leases.size }
  if ((bridge && !sent) || leases.size) process.exitCode = 1
  try {
    if (initialized) bridge?.stop()
  } catch (error) {
    cleanup.error = String(error)
    process.exitCode = 1
  }
  observe(cleanup)
  result.exitCode = process.exitCode || 0
  if (process.env.HVIR_QUALIFICATION_LOG)
    writeFileSync(
      process.env.HVIR_QUALIFICATION_LOG,
      JSON.stringify(result, null, 2) + '\n',
    )
  app.quit()
}
async function pump() {
  if (closing || !initialized) return
  bridge.tick()
  if (transferring) return
  const frame = bridge.take()
  if (frame.copyErrors) throw new Error('Native export copy failed')
  if (!frame.ioSurface) return
  transferring = true
  const token = `${frame.slot}:${frame.serial}`
  leases.add(token)
  const imported = sharedTexture.importSharedTexture({
    textureInfo: {
      handle: { ioSurface: frame.ioSurface },
      codedSize: { width: frame.width, height: frame.height },
      pixelFormat: 'bgra',
    },
    allReferencesReleased() {
      bridge.release(frame.slot, frame.serial)
      leases.delete(token)
      released++
    },
  })
  const metadata = {
    serial: frame.serial,
    width: frame.width,
    height: frame.height,
    copyMeanMs: frame.copyMeanMs,
    copyMaxMs: frame.copyMaxMs,
    dropped: frame.dropped,
  }
  try {
    await sharedTexture.sendSharedTexture(
      { frame: window.webContents.mainFrame, importedSharedTexture: imported },
      metadata,
    )
    sent++
  } catch (error) {
    if (!closing) throw error
  } finally {
    imported.release()
    transferring = false
  }
}
async function resize(cols, rows) {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 20 ||
    cols > 180 ||
    rows < 10 ||
    rows > 60
  )
    throw new Error('Grid outside experiment bounds')
  const metrics = bridge.size()
  const ticket = bridge.resize(cols * metrics.cellWidth, rows * metrics.cellHeight)
  const deadline = performance.now() + 5000
  while (bridge.appliedResize().ticket !== ticket) {
    if (bridge.appliedResize().ticket > ticket)
      throw new Error('Replay resize superseded')
    if (performance.now() > deadline)
      throw new Error('Replay native resize did not apply')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  const applied = bridge.appliedResize()
  if (
    applied.failed ||
    applied.cols !== cols ||
    applied.rows !== rows ||
    applied.width !== cols * metrics.cellWidth ||
    applied.height !== rows * metrics.cellHeight
  )
    throw new Error('Replay applied resize differs from its request')
  const actual = bridge.size()
  if (actual.cols !== cols || actual.rows !== rows)
    throw new Error('Native grid did not match request')
  return actual
}
function requireMatchedGeometry(geometry) {
  if (
    geometry?.cols !== 100 ||
    geometry?.rows !== 30 ||
    geometry?.width !== 1800 ||
    geometry?.height !== 900
  )
    throw new Error('Comparison requires a 100×30 grid with an 1800×900 pixel canvas')
}
ipcMain.handle('qualification:call', async (_event, op, args = []) => {
  if (closing && op !== 'finish') throw new Error('Experiment is closing')
  switch (op) {
    case 'initialize': {
      if (bridge) {
        bridge.start(configPath)
        initialized = true
        const geometry = await resize(100, 30)
        requireMatchedGeometry(geometry)
        result.geometry = geometry
        timer = setInterval(() => void pump().catch(fail), 4)
      }
      return {
        engine,
        interactive,
        interactiveProbe: process.env.HVIR_QUALIFICATION_INTERACTIVE_PROBE === '1',
        cols: 100,
        rows: 30,
        font: 'Menlo',
        fontSize: 14,
        scale: screen.getPrimaryDisplay().scaleFactor,
        geometry: result.geometry,
      }
    }
    case 'feed': {
      if (typeof args[0] !== 'string' || Buffer.byteLength(args[0]) > 2 * 1024 * 1024)
        throw new Error('Output outside experiment bound')
      return bridge.feed(Buffer.from(args[0]))
    }
    case 'snapshot':
      return bridge.snapshot(Boolean(args[0]))
    case 'scroll':
      bridge.scroll(args[0], args[1])
      return null
    case 'binding':
      if (
        ![
          'scroll_to_top',
          'scroll_to_bottom',
          'scroll_page_up',
          'scroll_page_down',
        ].includes(args[0])
      )
        throw new Error('Only the four scrolling bindings are allowed')
      return bridge.binding(args[0])
    case 'resize':
      return resize(args[0], args[1])
    case 'record':
      result.phases.push(args[0])
      return null
    case 'geometry':
      requireMatchedGeometry(args[0])
      result.geometry = args[0]
      return null
    case 'input-wheel': {
      window.webContents.sendInputEvent({
        type: 'mouseWheel',
        x: 150,
        y: 180,
        deltaX: 0,
        deltaY: args[0],
        canScroll: true,
      })
      return null
    }
    case 'capture': {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (process.env.HVIR_QUALIFICATION_SCREENSHOT) {
        const image = await window.webContents.capturePage()
        const label = ['top', 'scrolled'].includes(args[0]) ? `.${args[0]}` : ''
        writeFileSync(
          process.env.HVIR_QUALIFICATION_SCREENSHOT + label + '.png',
          image.toPNG(),
        )
      }
      return { gpu: app.getGPUFeatureStatus(), lastFrame }
    }
    case 'finish':
      await finish()
      return null
    case 'fail':
      fail(new Error(args[0]))
      return null
    default:
      throw new Error('Unknown experiment operation')
  }
})
ipcMain.on('qualification:draw', (_event, metadata) => {
  lastFrame = metadata
})
ipcMain.on('qualification:observe', (_event, data) => observe(data))
function fail(error) {
  observe({ event: 'failure', error: String(error) })
  process.exitCode = 1
  void finish()
}
for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, fail)
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => void finish())
app.on('window-all-closed', () => void finish())
app.on('will-quit', () => rmSync(scratch, { recursive: true, force: true }))
app
  .whenReady()
  .then(async () => {
    result.environment = {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      display: screen.getPrimaryDisplay(),
      platform: process.platform,
      architecture: process.arch,
    }
    window = new BrowserWindow({
      width: 1050,
      height: 780,
      title: `${engine} Ghostty qualification`,
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
    if (!interactive)
      watchdog = setTimeout(() => fail(new Error('Comparison deadline exceeded')), 90000)
    await window.loadFile(join(__dirname, 'window.html'))
  })
  .catch(fail)
