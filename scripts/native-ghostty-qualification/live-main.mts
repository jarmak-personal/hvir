import { app, BrowserWindow, ipcMain, screen, sharedTexture, clipboard } from 'electron'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { hostPath, LOCAL_HOST_ID } from '../../src/shared'
import { LivePtys, processAlive } from './live-pty.mts'
import { runLiveProbe } from './live-probe.mts'
import { runResizeProbe } from './resize-probe.mts'

export interface Geometry {
  width: number
  height: number
  cellWidth: number
  cellHeight: number
  cols: number
  rows: number
}
interface NativeFrame {
  ioSurface?: Buffer
  slot: number
  serial: number
  width: number
  height: number
  copyErrors: number
  produced: number
  dropped: number
}
export interface NativeSession {
  create(): NativeSession
  start(path: string): void
  tick(): void
  feed(bytes: Buffer): number
  input(bytes: Buffer): void
  key(code: number, mods: number, text: string): void
  mouse(x: number, y: number, pressed: boolean): void
  visible(value: boolean): void
  drain(): Buffer
  size(): Geometry
  resize(width: number, height: number): number
  appliedResize(): {
    ticket: number
    cols: number
    rows: number
    width: number
    height: number
    failed: number
  }
  snapshot(viewport?: boolean): string
  scroll(x: number, y: number): void
  binding(name: string): boolean
  take(): NativeFrame
  release(slot: number, serial: number): void
  stats(): {
    idlePid: number
    held: number
    pending: number
    copying: number
    slots: number
    produced: number
    dropped: number
    copyErrors: number
    outputBytes: number
    outputOverflow: number
  }
  stop(): void
}
export interface LiveSurface {
  id: string
  native: NativeSession
  owner: number
  window?: BrowserWindow
  generation: number
  presenting: boolean
  transferring: boolean
  closed: boolean
  leases: Set<string>
  imported: number
  idlePid?: number
  sent: number
  released: number
  maxLeases: number
  draws: number
  staleDraws: number
  geometryEpoch: number
  pendingResize?: { ticket: number; geometry: Geometry; epoch: number }
  appliedResizeTicket?: number
  resizeNotifications: {
    ticket: number
    cols: number
    rows: number
    epoch: number
    notified: boolean
  }[]
  lastDraw?: {
    width: number
    height: number
    generation: number
    geometryEpoch: number
    serial: number
  }
  heartbeat: number[]
}
const require = createRequire(join(process.env.HVIR_QUALIFICATION_ROOT!, 'package.json'))
const bridge: NativeSession = require(
  process.env.HVIR_QUALIFICATION_BRIDGE!,
) as NativeSession
const root = process.env.HVIR_QUALIFICATION_ROOT!
const probe = process.env.HVIR_QUALIFICATION_LIVE_PROBE === '1'
const resizeProbe = process.env.HVIR_QUALIFICATION_RESIZE_PROBE === '1'
const harnessProbe = process.env.HVIR_QUALIFICATION_HARNESS_PROBE === '1'
const provider = process.env.HVIR_QUALIFICATION_PROVIDER ?? 'plain-shell'
if (!['plain-shell', 'claude-code'].includes(provider))
  throw new Error('Unsupported demo provider')
const scratch = process.env.HVIR_QUALIFICATION_LIVE_SCRATCH!
app.setPath('userData', join(scratch, 'user-data'))
const cwd = join(scratch, 'workspace')
const config = join(scratch, 'ghostty-config')
const ptys = new LivePtys()
const surfaces: LiveSurface[] = []
const mainIntervals: number[] = []
let timer: ReturnType<typeof setInterval> | undefined
let finishing = false
let lastTick = performance.now()
let watchdog: ReturnType<typeof setTimeout> | undefined
const result: Record<string, unknown> = {
  schema: 1,
  mode: resizeProbe ? 'resize-probe' : probe ? 'live-probe' : 'live-demo',
  provider,
  timing:
    'Main/renderer scheduling and synchronous PTY-feed service; no physical presentation claim',
  checks: [],
}
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
export async function until(
  test: () => boolean,
  message: string,
  timeout = 10000,
): Promise<void> {
  const deadline = performance.now() + timeout
  while (!test()) {
    if (performance.now() > deadline) throw new Error(message)
    await delay(5)
  }
}
export function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
  ;(result.checks as string[]).push(message)
}
function fail(error: unknown): void {
  if (finishing) return
  result.error = String(error)
  process.exitCode = 1
  void finish()
}
async function finish(): Promise<void> {
  if (finishing) return
  finishing = true
  if (timer) clearInterval(timer)
  if (watchdog) clearTimeout(watchdog)
  for (const s of surfaces) {
    s.presenting = false
    s.closed = true
    s.pendingResize = undefined
    s.generation++
    s.window?.destroy()
  }
  await ptys.stop().catch((error) => {
    result.ptyStopError = String(error)
    process.exitCode = 1
  })
  await until(
    () =>
      [...ptys.streams.values()].every(
        (stream) => !stream.pid || !processAlive(stream.pid),
      ),
    'Owned PTY process survived cleanup',
    3000,
  ).catch((error) => {
    result.ptyCleanupError = String(error)
    process.exitCode = 1
  })
  await until(
    () => surfaces.every((s) => s.leases.size === 0),
    'Texture leases did not drain',
    5000,
  ).catch((error) => {
    result.cleanupError = String(error)
    process.exitCode = 1
  })
  result.resources = surfaces.map((s) => ({
    id: s.id,
    imported: s.imported,
    sent: s.sent,
    released: s.released,
    held: s.leases.size,
    maxLeases: s.maxLeases,
    draws: s.draws,
    staleDraws: s.staleDraws,
    native: s.native.stats(),
    resizeNotifications: s.resizeNotifications,
    pendingResizeTicket: s.pendingResize?.ticket ?? null,
    appliedResizeTicket: s.appliedResizeTicket ?? null,
    rendererRafIntervalsMs: s.heartbeat,
  }))
  for (const s of surfaces) {
    try {
      s.native.stop()
    } catch (error) {
      result.stopError = String(error)
      process.exitCode = 1
    }
  }
  await until(
    () => surfaces.every((s) => !s.idlePid || !processAlive(s.idlePid)),
    'Idle Ghostty child survived stop',
    3000,
  ).catch((error) => {
    result.idleCleanupError = String(error)
    process.exitCode = 1
  })
  result.idleChildrenAliveAfterStop = surfaces.map((s) => ({
    id: s.id,
    alive: s.idlePid ? processAlive(s.idlePid) : null,
  }))
  result.ptyStreams = ptys.evidence()
  result.livePtysAfterCleanup = ptys.supervisor.observationSnapshot().length
  result.mainTimerIntervalsMs = mainIntervals
  result.ptyFeedServiceMs = ptys.samples
  result.exitCode = process.exitCode || 0
  if (process.env.HVIR_QUALIFICATION_LOG)
    await ptys.host.writeFile(
      hostPath(LOCAL_HOST_ID, process.env.HVIR_QUALIFICATION_LOG),
      Buffer.from(JSON.stringify(result, null, 2) + '\n'),
    )
  await ptys.host.dispose()
  console.log(
    JSON.stringify({
      event: 'live-finished',
      exitCode: result.exitCode,
      checks: result.checks,
    }),
  )
  app.quit()
}
async function pump(s: LiveSurface): Promise<void> {
  if (s.closed) return
  s.native.tick()
  applyResize(s)
  const reply = s.native.drain()
  if (reply.length && ptys.supervisor.get(s.id))
    ptys.write(s.id, s.owner, reply.toString('utf8'))
  if (!s.presenting || s.transferring || !s.window || s.window.isDestroyed()) return
  const frame = s.native.take()
  if (frame.copyErrors) throw new Error('Native frame copy failed')
  if (!frame.ioSurface) return
  const geometry = s.native.size()
  if (frame.width !== geometry.width || frame.height !== geometry.height) {
    s.native.release(frame.slot, frame.serial)
    return
  }
  const generation = s.generation
  const target = s.window.webContents.mainFrame
  const token = `${frame.slot}:${frame.serial}`
  s.leases.add(token)
  s.maxLeases = Math.max(s.maxLeases, s.leases.size)
  s.transferring = true
  let imported: ReturnType<typeof sharedTexture.importSharedTexture> | undefined
  try {
    imported = sharedTexture.importSharedTexture({
      textureInfo: {
        handle: { ioSurface: frame.ioSurface },
        codedSize: { width: frame.width, height: frame.height },
        pixelFormat: 'bgra',
      },
      allReferencesReleased: () => {
        s.native.release(frame.slot, frame.serial)
        s.leases.delete(token)
        s.released++
      },
    })
    s.imported++
    await sharedTexture.sendSharedTexture(
      { frame: target, importedSharedTexture: imported },
      {
        session: s.id,
        generation,
        serial: frame.serial,
        width: frame.width,
        height: frame.height,
        geometryEpoch: s.geometryEpoch,
      },
    )
    s.sent++
  } catch (error) {
    if (!imported) {
      s.native.release(frame.slot, frame.serial)
      s.leases.delete(token)
    }
    if (!finishing && s.generation === generation && s.presenting) throw error
  } finally {
    imported?.release()
    s.transferring = false
  }
}
export function resize(s: LiveSurface, cols: number, rows: number): Geometry {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 40 ||
    cols > 120 ||
    rows < 10 ||
    rows > 50
  )
    throw new Error('Grid outside live experiment bounds')
  const old = s.native.size()
  const ticket = s.native.resize(cols * old.cellWidth, rows * old.cellHeight)
  const geometry = s.native.size()
  if (geometry.cols !== cols || geometry.rows !== rows) throw new Error('Grid mismatch')
  s.geometryEpoch++
  s.pendingResize = { ticket, geometry, epoch: s.geometryEpoch }
  return geometry
}
// One replaceable request per session; an equal-size old acknowledgement cannot
// notify the PTY for a newer ticket. Output bytes are never queued or discarded here.
function applyResize(s: LiveSurface): void {
  const pending = s.pendingResize
  if (!pending || s.closed || finishing) return
  const applied = s.native.appliedResize()
  if (applied.ticket !== pending.ticket) return
  if (
    applied.failed ||
    applied.cols !== pending.geometry.cols ||
    applied.rows !== pending.geometry.rows ||
    applied.width !== pending.geometry.width ||
    applied.height !== pending.geometry.height
  )
    throw new Error('Applied native resize differs from its request')
  const notified = ptys.supervisor.get(s.id) !== undefined
  if (notified) ptys.resize(s.id, s.owner, applied.cols, applied.rows)
  s.appliedResizeTicket = applied.ticket
  s.pendingResize = undefined
  if (s.resizeNotifications.length < 512)
    s.resizeNotifications.push({
      ticket: applied.ticket,
      cols: applied.cols,
      rows: applied.rows,
      epoch: pending.epoch,
      notified,
    })
}
export async function receiver(s: LiveSurface, delayMs = 0): Promise<void> {
  s.generation++
  const window = new BrowserWindow({
    width: 960,
    height: 650,
    show: true,
    webPreferences: {
      preload: join(root, 'scripts/native-ghostty-qualification/live-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  s.window = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.on('closed', () => {
    if (!probe && !resizeProbe && !finishing) void finish()
  })
  await window.loadFile(join(root, 'scripts/native-ghostty-qualification/live.html'), {
    query: { session: s.id, generation: String(s.generation), delay: String(delayMs) },
  })
  s.presenting = true
  s.native.visible(true)
}
export function destroyReceiver(s: LiveSurface): void {
  s.presenting = false
  s.generation++
  s.window?.destroy()
  s.window = undefined
}
function sender(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  generation: unknown,
): LiveSurface {
  const s = surfaces.find((candidate) => candidate.window?.webContents === event.sender)
  if (
    !s ||
    s.closed ||
    generation !== s.generation ||
    event.senderFrame !== event.sender.mainFrame
  )
    throw new Error('Stale or foreign live experiment sender')
  return s
}
ipcMain.handle('qualification:live', (event, generation, op, args: unknown[]) => {
  const s = sender(event, generation)
  if (!Array.isArray(args)) throw new Error('Expected arguments')
  const [a, b, c] = args
  if (op === 'key' && Number.isInteger(a) && Number.isInteger(b) && typeof c === 'string')
    return s.native.key(a as number, b as number, c)
  if (op === 'paste' && typeof a === 'string' && Buffer.byteLength(a) <= 65536)
    return s.native.input(Buffer.from(a))
  if (op === 'clipboard-paste') {
    const text = clipboard.readText()
    if (Buffer.byteLength(text) > 65536)
      throw new Error('Clipboard text exceeds experiment bound')
    return s.native.input(Buffer.from(text))
  }
  if (op === 'scroll' && typeof a === 'number' && typeof b === 'number')
    return s.native.scroll(a, b)
  if (
    op === 'mouse' &&
    typeof a === 'number' &&
    typeof b === 'number' &&
    typeof c === 'boolean'
  )
    return s.native.mouse(a, b, c)
  if (op === 'resize') return resize(s, a as number, b as number)
  if (op === 'binding' && ['scroll_to_top', 'scroll_to_bottom'].includes(a as string))
    return s.native.binding(a as string)
  throw new Error('Unsupported live experiment operation')
})
ipcMain.on(
  'qualification:live-draw',
  (
    event,
    data: {
      session: string
      generation: number
      geometryEpoch: number
      width: number
      height: number
      serial: number
    },
  ) => {
    try {
      const s = sender(event, data.generation)
      if (data.session !== s.id) throw new Error('Cross-session draw')
      s.lastDraw = data
      s.draws++
    } catch {
      const s = surfaces.find(
        (candidate) => candidate.window?.webContents === event.sender,
      )
      if (s) s.staleDraws++
    }
  },
)
ipcMain.on(
  'qualification:live-heartbeat',
  (event, generation: unknown, interval: unknown) => {
    try {
      const s = sender(event, generation)
      if (
        typeof interval === 'number' &&
        Number.isFinite(interval) &&
        s.heartbeat.length < 10000
      )
        s.heartbeat.push(interval)
    } catch {
      /* Revoked receiver. */
    }
  },
)
ipcMain.on('qualification:live-failure', (event, generation: unknown, error: unknown) => {
  try {
    sender(event, generation)
    fail(error)
  } catch {
    /* Revoked receiver failure. */
  }
})
app.on('window-all-closed', () => {
  /* Probe deliberately destroys and recreates receivers. */
})
app.on('before-quit', (event) => {
  if (!finishing) {
    event.preventDefault()
    void finish()
  }
})
process.on('SIGINT', () => void finish())
process.on('SIGTERM', () => void finish())
void app
  .whenReady()
  .then(async () => {
    result.environment = {
      platform: process.platform,
      arch: process.arch,
      versions: process.versions,
      display: {
        scale: screen.getPrimaryDisplay().scaleFactor,
        frequency: screen.getPrimaryDisplay().displayFrequency,
      },
      gpu: await app.getGPUInfo('basic'),
    }
    for (const id of probe ? ['A', 'B'] : resizeProbe ? ['A'] : [randomUUID()]) {
      const native = surfaces.length === 0 ? bridge : bridge.create()
      const s: LiveSurface = {
        id,
        native,
        owner: 7000 + surfaces.length,
        generation: 0,
        presenting: false,
        transferring: false,
        closed: false,
        leases: new Set(),
        imported: 0,
        sent: 0,
        released: 0,
        maxLeases: 0,
        draws: 0,
        staleDraws: 0,
        geometryEpoch: 0,
        resizeNotifications: [],
        heartbeat: [],
      }
      if (typeof native.appliedResize !== 'function')
        throw new Error('Rebuild the qualification bridge for ticketed resize support')
      native.start(config)
      surfaces.push(s)
      resize(s, 100, 30)
      await until(() => {
        applyResize(s)
        return s.pendingResize === undefined
      }, 'Initial native parser resize did not apply before PTY launch')
      await receiver(s, probe && id === 'A' ? 100 : 0)
      await ptys.launch({
        id,
        owner: s.owner,
        cwd,
        provider: provider as 'plain-shell' | 'claude-code',
        ...(probe || resizeProbe
          ? {
              fixture: {
                node: process.env.HVIR_QUALIFICATION_NODE!,
                file: join(
                  root,
                  `scripts/native-ghostty-qualification/${resizeProbe ? 'resize-fixture' : 'pty-fixture'}.mjs`,
                ),
              },
            }
          : {}),
        feed: (data) => {
          native.feed(data)
        },
        onError: fail,
      })
    }
    lastTick = performance.now()
    timer = setInterval(() => {
      const now = performance.now()
      if (mainIntervals.length < 20000) mainIntervals.push(now - lastTick)
      lastTick = now
      for (const s of surfaces) void pump(s).catch(fail)
    }, 4)
    if (resizeProbe) {
      watchdog = setTimeout(() => fail(new Error('Resize probe timed out')), 60000)
      await runResizeProbe({
        surfaces,
        ptys,
        result,
        check,
        until,
        resize,
        destroyReceiver,
      })
      await finish()
    } else if (harnessProbe) {
      const s = surfaces[0]
      if (!s) throw new Error('Harness surface absent')
      await until(
        () => ptys.streams.get(s.id)!.bytes > 0,
        'Supported harness produced no startup output',
      )
      await until(() => {
        const text = s.native.snapshot()
        return text.includes('Claude Code') && /trust|Trust/.test(text)
      }, 'Supported harness did not reach the expected title/trust startup state')
      const text = s.native.snapshot()
      const barrier = {
        produced: s.native.stats().produced,
        draws: s.draws,
        generation: s.generation,
      }
      result.harnessStartup = {
        hasClaudeTitle: text.includes('Claude Code'),
        trustPrompt: /trust|Trust/.test(text),
        retainedCharacters: text.length,
        noModelPromptSubmitted: true,
        barrier,
      }
      check(
        text.includes('Claude Code'),
        'Supported harness retained startup contains Claude Code title',
      )
      check(
        /trust|Trust/.test(text),
        'Supported harness retained startup contains workspace trust prompt',
      )
      s.native.visible(true)
      await until(
        () =>
          s.draws > barrier.draws &&
          s.lastDraw?.generation === barrier.generation &&
          s.lastDraw.serial > barrier.produced,
        'Supported harness receiver did not acknowledge a later completed native frame',
      )
      result.harnessStartupDraw = { draws: s.draws, observed: { ...s.lastDraw } }
      check(
        true,
        'Supported harness receiver acknowledges a later completed native frame in its current generation',
      )
      s.idlePid = s.native.stats().idlePid
      await finish()
    } else if (probe) {
      watchdog = setTimeout(() => fail(new Error('Live probe timed out')), 60000)
      await runLiveProbe({
        surfaces,
        ptys,
        result,
        check,
        until,
        resize,
        receiver,
        destroyReceiver,
      })
      await finish()
    }
  })
  .catch(fail)
