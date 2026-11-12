import { setTimeout as wait } from 'node:timers/promises'
import type { LiveSurface, Geometry } from './live-main.mts'
import type { LivePtys } from './live-pty.mts'
interface PeerRecord {
  sequence: number
  cause: string
  signals: number
  stdoutResizes: number
  cols: number
  rows: number
  kernel: { cols: number; rows: number }
  cursors: { row: number; col: number }[]
  cells: { cols: number; rows: number }
  pixels: { width: number; height: number }
}
export async function runResizeProbe(options: {
  surfaces: LiveSurface[]
  ptys: LivePtys
  result: Record<string, unknown>
  check: (condition: boolean, message: string) => void
  until: (test: () => boolean, message: string, timeout?: number) => Promise<void>
  resize: (s: LiveSurface, cols: number, rows: number) => Geometry
  destroyReceiver: (s: LiveSurface) => void
}): Promise<void> {
  const { surfaces, ptys, result, check, until, resize, destroyReceiver } = options
  const s = surfaces[0]
  if (!s) throw new Error('Missing fixed resize surface')
  const records = (): PeerRecord[] =>
    [
      ...(ptys.streams.get(s.id)?.transcript ?? '').matchAll(
        /RESIZE_RECORD ([^\r\n]+)\r*\n/gu,
      ),
    ].map((match) => JSON.parse(match[1]!) as PeerRecord)
  const samples: unknown[] = [],
    mismatches: unknown[] = []
  result.resizePeerSamples = samples
  await until(() => records().length > 0, 'Resize peer startup did not complete')
  function assess(record: PeerRecord, geometry: Geometry, before: unknown): void {
    const expected = {
      cols: geometry.cols,
      rows: geometry.rows,
      width: geometry.width,
      height: geometry.height,
    }
    const passed =
      record.kernel.cols === expected.cols &&
      record.kernel.rows === expected.rows &&
      record.cols === expected.cols &&
      record.rows === expected.rows &&
      record.cells.cols === expected.cols &&
      record.cells.rows === expected.rows &&
      record.pixels.width === expected.width &&
      record.pixels.height === expected.height &&
      record.cursors[0]?.col === expected.cols &&
      record.cursors[0]?.row === 1 &&
      record.cursors[1]?.row === 4 &&
      record.cursors[1]?.col === 2
    const sample = { expected, record, before, passed }
    samples.push(sample)
    if (!passed) mismatches.push(sample)
  }
  assess(records()[0]!, s.native.size(), {
    kind: 'startup',
    appliedTicket: s.appliedResizeTicket,
    native: s.native.appliedResize(),
  })
  check(
    s.appliedResizeTicket === s.native.appliedResize().ticket &&
      s.resizeNotifications[0]?.notified === false,
    'Native parser applies initial resize before the real PTY starts',
  )
  for (const cols of [80, 100, 80, 100, 80, 100]) {
    const before = records().at(-1)!
    await s.window!.webContents.executeJavaScript(
      "document.querySelector('#resize').click()",
    )
    await until(
      () => s.native.size().cols === cols,
      'Toggle width did not request the expected public grid',
    )
    const geometry = s.native.size()
    await until(
      () => records().length > before.sequence + 1,
      'Peer received no resize signal/reply cycle',
    )
    const record = records().at(-1)!
    assess(record, geometry, {
      signals: before.signals,
      stdoutResizes: before.stdoutResizes,
      driver: 'actual-toggle-button',
      requestedTicket: s.appliedResizeTicket,
      native: s.native.appliedResize(),
    })
    check(
      record.signals > before.signals && record.cause === 'SIGWINCH',
      `Peer receives real SIGWINCH for ${cols} columns`,
    )
  }
  const notificationBarrier = s.resizeNotifications.length
  const requested: number[] = []
  for (const cols of [80, 100, 80, 100]) {
    resize(s, cols, 30)
    requested.push(s.pendingResize!.ticket)
  }
  const latest = requested.at(-1)!
  await until(
    () => s.appliedResizeTicket === latest,
    'Latest repeated-size ticket did not apply',
  )
  const recordBarrier = records().length
  ptys.write(s.id, s.owner, 'Q')
  await until(
    () => records().length > recordBarrier,
    'Repeated-size peer query did not finish',
  )
  assess(records().at(-1)!, s.native.size(), {
    kind: 'rapid-repeated-size',
    requested,
    applied: s.native.appliedResize(),
  })
  const notifications = s.resizeNotifications.slice(notificationBarrier)
  check(
    notifications.length === 1 && notifications[0]?.ticket === latest,
    'Only the latest rapid repeated-size ticket notifies the external PTY',
  )
  // A delayed observation deliberately exceeds upstream's known25ms coalescer.
  // Readiness above is ticket/peer-based; this is a stale-timer regression phase.
  await wait(60)
  const delayedBarrier = records().length
  ptys.write(s.id, s.owner, 'Q')
  await until(
    () => records().length > delayedBarrier,
    'Delayed coalescer peer query did not finish',
  )
  assess(records().at(-1)!, s.native.size(), {
    kind: 'after-coalescer-window',
    observationWindowMs: 60,
    requestedTicket: latest,
    applied: s.native.appliedResize(),
  })
  check(
    s.native.appliedResize().ticket === latest,
    'Older coalesced resize cannot replace the latest applied ticket',
  )
  result.resizeTicketProof = {
    requested,
    applied: s.native.appliedResize(),
    notifications,
  }
  const beforeClose = s.resizeNotifications.length
  resize(s, 96, 30)
  const closingTicket = s.pendingResize!.ticket
  s.closed = true
  s.pendingResize = undefined
  destroyReceiver(s)
  ptys.supervisor.disposeSession(s.id, s.owner, 1)
  await until(
    () => s.native.appliedResize().ticket === closingTicket,
    'Closing native request did not finish',
  )
  check(
    s.resizeNotifications.length === beforeClose &&
      ptys.supervisor.get(s.id) === undefined,
    'Closing session revokes a pending resize before late completion can notify its PTY',
  )
  result.resizeCloseProof = {
    closingTicket,
    applied: s.native.appliedResize(),
    notificationsBefore: beforeClose,
    notificationsAfter: s.resizeNotifications.length,
    ptyPresent: false,
  }
  s.idlePid = s.native.stats().idlePid
  result.resizePeerMismatches = mismatches
  check(
    mismatches.length === 0,
    'Kernel winsize, child dimensions, terminal size replies, cursor clamp and wrap agree for startup and each redraw',
  )
}
