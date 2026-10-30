import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { burst, normalize } from './workloads.mjs'
import type { LiveSurface, Geometry } from './live-main.mts'
import type { LivePtys } from './live-pty.mts'

export async function runLiveProbe(options: {
  surfaces: LiveSurface[]
  ptys: LivePtys
  result: Record<string, unknown>
  check: (condition: boolean, message: string) => void
  until: (test: () => boolean, message: string, timeout?: number) => Promise<void>
  resize: (s: LiveSurface, cols: number, rows: number) => Geometry
  receiver: (s: LiveSurface, delayMs?: number) => Promise<void>
  destroyReceiver: (s: LiveSurface) => void
}): Promise<void> {
  const { surfaces, ptys, result, check, until, resize, receiver, destroyReceiver } =
    options
  const transcript = (s: LiveSurface): string => ptys.streams.get(s.id)?.transcript ?? ''
  const ack = async (s: LiveSurface, name: string): Promise<void> => {
    await until(
      () => transcript(s).includes(`OK:${s.id}:${name}`),
      `${s.id} missing ${name} acknowledgement`,
    )
    check(true, `${s.id}: exact ${name} bytes received by real PTY peer`)
  }
  for (const s of surfaces) {
    await ack(s, 'reply')
    for (const [code, text] of [
      [4, 'h'],
      [14, 'e'],
      [37, 'l'],
      [37, 'l'],
      [31, 'o'],
    ] as const)
      s.native.key(code, 0, text)
    await ack(s, 'text')
    s.native.key(0, 2, 'a')
    await ack(s, 'control')
    s.native.key(126, 0, '')
    await ack(s, 'navigation')
    s.native.key(36, 0, '')
    await ack(s, 'enter')
    s.native.input(Buffer.from('pasted\n界'))
    await ack(s, 'paste')
    const geometry = s.native.size()
    s.native.mouse(geometry.cellWidth * 0.75, geometry.cellHeight * 0.75, true)
    s.native.mouse(geometry.cellWidth * 0.75, geometry.cellHeight * 0.75, false)
    await ack(s, 'mouse')
    await until(
      () => s.native.snapshot().includes(`ALT ${s.id}`),
      `${s.id} alternate screen absent`,
    )
    check(
      !s.native.snapshot().includes(`ALT ${s.id === 'A' ? 'B' : 'A'}`),
      `${s.id}: alternate screen is session-qualified`,
    )
    s.native.key(7, 0, 'x')
    await ack(s, 'alternate')
    check(
      !s.native.snapshot().includes(`ALT ${s.id}`),
      `${s.id}: alternate screen exits to primary`,
    )
  }
  const [a, b] = surfaces
  if (!a || !b) throw new Error('Probe requires two independent surfaces')
  b.presenting = false
  b.native.visible(false)
  b.window!.hide()
  const snapshots: unknown[] = []
  const started = performance.now()
  a.native.input(Buffer.from('run'))
  b.native.input(Buffer.from('run'))
  for (const s of surfaces) {
    const fixture = burst(s.id, 2000)
    const ptyBytes = fixture.bytes.replaceAll('\r\n', '\x1bE')
    await until(
      () => normalize(s.native.snapshot()) === fixture.expected,
      `${s.id} retained stream differs from emitted ordered rows`,
    )
    const actual = normalize(s.native.snapshot())
    snapshots.push({
      session: s.id,
      rows: 2000,
      sha256: createHash('sha256').update(actual).digest('hex'),
      exact: actual === fixture.expected,
      emittedBytes: Buffer.byteLength(fixture.bytes),
      wireBytes: Buffer.byteLength(ptyBytes),
      receivedContiguousBytes: transcript(s).includes(ptyBytes),
    })
    result.streams = snapshots
    check(
      actual === fixture.expected,
      `${s.id}: all 2000 ordered rows retained without cross-session output`,
    )
    check(
      transcript(s).includes(ptyBytes),
      `${s.id}: NEL-next-line workload bytes preserved by PTY attachment`,
    )
  }
  result.streams = snapshots
  result.twoStreamsToExactRetainedTextMs = performance.now() - started
  check(
    a.native.stats().slots === 3 && b.native.stats().slots === 3,
    'Each native surface owns exactly three bounded export slots',
  )
  check(
    a.native.stats().outputOverflow === 0 && b.native.stats().outputOverflow === 0,
    'Both terminal-reply queues remain within 65536 bytes',
  )
  const revealBarrier = {
    produced: b.native.stats().produced,
    draws: b.draws,
    generation: b.generation,
  }
  b.window!.show()
  b.presenting = true
  b.native.visible(true)
  await until(
    () =>
      b.draws > revealBarrier.draws &&
      b.lastDraw?.generation === revealBarrier.generation &&
      b.lastDraw.serial > revealBarrier.produced,
    'Hidden surface did not acknowledge a later completed frame after reveal',
  )
  result.revealProof = {
    barrier: revealBarrier,
    observed: { ...b.lastDraw },
    draws: b.draws,
  }
  check(
    normalize(b.native.snapshot()) === burst('B', 2000).expected,
    'Hidden/revealed surface retains complete output',
  )

  a.native.binding('scroll_to_top')
  await until(
    () => a.native.snapshot(true).includes('A-000000'),
    'Scrollback top missing',
  )
  a.window!.webContents.sendInputEvent({
    type: 'mouseWheel',
    x: 300,
    y: 300,
    deltaY: -200,
    deltaX: 0,
    canScroll: true,
  })
  await until(
    () => !a.native.snapshot(true).includes('A-000000'),
    'Real Electron wheel did not scroll native viewport',
  )
  check(true, 'Real Electron wheel changes terminal scrollback viewport')
  a.native.binding('scroll_to_bottom')

  const resizeBarrier = {
    produced: a.native.stats().produced,
    draws: a.draws,
    generation: a.generation,
  }
  const resizeSamples: unknown[] = []
  for (const cols of [80, 100, 90, 100, 80, 96]) {
    const before = performance.now()
    const geometry = resize(a, cols, 30)
    resizeSamples.push({
      cols,
      requestedEpoch: a.geometryEpoch,
      synchronousGridAndPtyResizeMs: performance.now() - before,
      geometry,
    })
  }
  const geometry = a.native.size()
  await until(
    () =>
      a.draws > resizeBarrier.draws &&
      a.lastDraw?.generation === resizeBarrier.generation &&
      a.lastDraw.serial > resizeBarrier.produced &&
      a.lastDraw.geometryEpoch === a.geometryEpoch &&
      a.lastDraw.width === geometry.width &&
      a.lastDraw.height === geometry.height,
    'Latest requested dimensions did not reach the receiver',
  )
  result.resize = resizeSamples
  result.resizeProof = {
    barrier: resizeBarrier,
    requested: geometry,
    requestedEpoch: a.geometryEpoch,
    observed: { ...a.lastDraw },
    draws: a.draws,
  }
  check(
    ptys.supervisor.get(a.id) !== undefined,
    'Rapid resize retains the intended live PTY',
  )
  check(
    normalize(a.native.snapshot()) === burst('A', 2000).expected,
    'Rapid resize/reflow preserves exact retained text',
  )

  // Force an outstanding delayed receiver lease, then revoke that real document.
  a.native.feed(Buffer.from('\r\nreceiver-stress'))
  await until(() => a.leases.size > 0, 'No outstanding frame for teardown probe')
  let refused = false
  try {
    a.native.stop()
  } catch {
    refused = true
  }
  check(refused, 'Native stop refuses to free a Chromium-owned export slot')
  const previousGeneration = a.generation
  destroyReceiver(a)
  await until(
    () => a.leases.size === 0 && !a.transferring,
    'Destroyed receiver retained frame leases',
  )
  check(
    ptys.supervisor.get(a.id) !== undefined,
    'Receiver destruction preserves its live PTY',
  )
  await receiver(a)
  await until(
    () => a.lastDraw?.generation === a.generation,
    'Replacement receiver never drew its generation',
  )
  check(
    a.generation > previousGeneration,
    'Replacement document receives a fresh generation',
  )
  check(
    a.native.snapshot().includes('receiver-stress'),
    'Replacement receiver keeps the existing terminal state',
  )

  b.native.feed(Buffer.from('\r\nclose-stress'))
  await until(() => b.leases.size > 0, 'No frame lease for close probe')
  destroyReceiver(b)
  b.closed = true
  ptys.supervisor.disposeSession(b.id, b.owner, 1)
  await until(
    () => b.leases.size === 0 && !b.transferring,
    'Closed session retained leases',
  )
  b.idlePid = b.native.stats().idlePid
  b.native.stop()
  check(
    ptys.supervisor.get(b.id) === undefined && ptys.supervisor.get(a.id) !== undefined,
    'Closing one surface terminates only its intended PTY',
  )
  const survivorBarrier = {
    produced: a.native.stats().produced,
    draws: a.draws,
    generation: a.generation,
  }
  a.native.input(Buffer.from('alive'))
  await until(
    () =>
      a.native.snapshot().includes('SURVIVOR:A') &&
      a.draws > survivorBarrier.draws &&
      a.lastDraw?.generation === survivorBarrier.generation &&
      a.lastDraw.serial > survivorBarrier.produced,
    'Surviving PTY/native surface failed after the other app was freed',
  )
  result.survivorProof = {
    barrier: survivorBarrier,
    observed: { ...a.lastDraw },
    draws: a.draws,
  }
  check(
    true,
    'Surviving PTY and native surface round-trip fresh input and redraw after peer teardown',
  )
  a.idlePid = a.native.stats().idlePid
  result.nativeBeforeCleanup = surfaces.map((s) => ({ id: s.id, ...s.native.stats() }))
  check(
    surfaces.every((s) => s.maxLeases <= 3 && s.native.stats().copyErrors === 0),
    'Delayed, resized and destroyed receivers preserve bounded leases with no GPU-copy errors',
  )
}
