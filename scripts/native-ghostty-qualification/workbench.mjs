/* global window, document, performance, GhosttyWeb, URL, TextEncoder, crypto, setTimeout, setInterval, clearInterval, requestAnimationFrame, WheelEvent */
import {
  RESET,
  burst,
  unicodeFixture,
  demoFixture,
  numberedLines,
  normalize,
  distribution,
} from './workloads.mjs'
const api = window.qualification
const status = document.querySelector('#status')
const surface = document.querySelector('#surface')
let terminal,
  settings,
  nativeGeometry,
  lastFrame,
  frameCount = 0,
  activeSamples
let wheelPending = Promise.resolve()
let currentCols = 100
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function frame(metadata) {
  frameCount++
  lastFrame = metadata
  if (activeSamples) activeSamples.push(performance.now())
}
api.onFrame(frame)
async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
async function write(bytes) {
  if (!terminal) return api.call('feed', bytes)
  const started = performance.now()
  terminal.write(bytes)
  return performance.now() - started
}
async function drawAfter(previous) {
  const deadline = performance.now() + 5000
  while (frameCount <= previous) {
    if (performance.now() > deadline)
      throw new Error('No draw notification before deadline')
    await delay(4)
  }
  // This is renderer scheduling acknowledgement, not a hardware presentation fence.
  await new Promise((resolve) => requestAnimationFrame(resolve))
}
async function snapshot(viewport = false) {
  if (!terminal) return normalize(await api.call('snapshot', viewport))
  if (!viewport) {
    terminal.selectAll()
    const text = terminal.getSelection()
    terminal.clearSelection()
    return normalize(text)
  }
  const buffer = terminal.buffer.active
  return normalize(
    Array.from(
      { length: 30 },
      (_, index) =>
        buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '',
    ).join('\n'),
  )
}
async function binding(name) {
  if (!terminal) return api.call('binding', name)
  if (name === 'scroll_to_top') terminal.scrollToTop()
  else if (name === 'scroll_to_bottom') terminal.scrollToBottom()
  else if (name === 'scroll_page_up') terminal.scrollPages(-1)
  else if (name === 'scroll_page_down') terminal.scrollPages(1)
  terminal.requestRender(true)
  return true
}
async function grid(cols) {
  currentCols = cols
  const before = frameCount
  if (!terminal) {
    nativeGeometry = await api.call('resize', cols, 30)
    const deadline = performance.now() + 5000
    while (
      !lastFrame ||
      lastFrame.width !== nativeGeometry.width ||
      lastFrame.height !== nativeGeometry.height
    ) {
      if (performance.now() > deadline)
        throw new Error('No native frame with requested dimensions')
      await delay(4)
    }
  } else {
    terminal.resize(cols, 30)
    terminal.requestRender(true)
  }
  await drawAfter(before)
}
async function wheel(deltaY) {
  const started = performance.now()
  const before = frameCount
  surface
    .querySelector('canvas')
    .dispatchEvent(
      new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true }),
    )
  await wheelPending
  await drawAfter(before)
  const dispatchThroughDrawSchedulingAckMs = performance.now() - started
  await delay(200) // Keep a common, untimed settling interval before exact viewport readback.
  return { deltaY, dispatchThroughDrawSchedulingAckMs, untimedSettleMs: 200 }
}
async function check(name, expected, actual) {
  const expectedHash = await digest(expected)
  const actualHash = await digest(actual)
  const row = {
    name,
    passed: actual === expected,
    expectedHash,
    actualHash,
    expectedCharacters: expected.length,
    actualCharacters: actual.length,
  }
  if (!row.passed) {
    let firstDifference = 0
    while (
      firstDifference < expected.length &&
      expected[firstDifference] === actual[firstDifference]
    )
      firstDifference++
    row.firstDifference = firstDifference
  }
  await api.call('record', { kind: 'correctness', ...row })
  assert(row.passed, `${name}: exact retained text differs at ${row.firstDifference}`)
}
async function prepare() {
  await binding('scroll_to_bottom')
  const before = frameCount
  await write(RESET)
  if (terminal) terminal.requestRender(true)
  await drawAfter(before)
  await delay(100)
}
async function fixedBurst(fixture) {
  await prepare()
  const before = frameCount,
    started = performance.now()
  const apiServiceMs = await write(fixture.bytes)
  const apiRoundTripMs = performance.now() - started
  const returned = performance.now()
  await drawAfter(before)
  const nextDrawSchedulingAckMs = performance.now() - returned
  const row = {
    kind: 'burst',
    name: fixture.name,
    bytes: new TextEncoder().encode(fixture.bytes).length,
    bytesHash: await digest(fixture.bytes),
    apiServiceMs,
    apiRoundTripMs,
    nextDrawSchedulingAckMs,
  }
  await check(fixture.name, fixture.expected, await snapshot())
  await api.call('record', row)
}
async function scrollChecks() {
  await prepare()
  const fixture = demoFixture(500)
  await write(fixture.bytes)
  await delay(150)
  await check('scroll-retained', fixture.expected, await snapshot())
  await binding('scroll_to_top')
  await delay(150)
  const top = await snapshot(true)
  assert(top.startsWith('000000 '), 'Top binding did not expose earliest retained row')
  const downTiming = await wheel(300)
  const down = await snapshot(true)
  assert(
    down !== top && !down.startsWith('000000 '),
    'Positive wheel did not scroll down',
  )
  const upTiming = await wheel(-300)
  const up = await snapshot(true)
  assert(up === top, 'Negative wheel did not restore earliest retained viewport')
  await binding('scroll_to_bottom')
  await delay(150)
  const bottom = await snapshot(true)
  assert(bottom.includes('000499 '), 'Bottom binding did not reveal latest row')
  await check('scroll-preserves-retained', fixture.expected, await snapshot())
  await api.call('record', {
    kind: 'scroll',
    passed: true,
    wheelSamples: [downTiming, upTiming],
    topHash: await digest(top),
    downHash: await digest(down),
    restoredHash: await digest(up),
    bottomHash: await digest(bottom),
  })
}
async function stream() {
  await prepare()
  const lines = numberedLines('paced', 1000)
  const samples = []
  activeSamples = samples
  let serviceMs = 0
  const started = performance.now()
  for (let index = 0; index < 100; index++) {
    const tick = performance.now()
    serviceMs += await write(
      lines.slice(index * 10, index * 10 + 10).join('\r\n') + '\r\n',
    )
    await delay(Math.max(0, 16 - (performance.now() - tick)))
  }
  await delay(100)
  activeSamples = undefined
  const elapsedMs = performance.now() - started
  await check('paced-stream', lines.join('\n'), await snapshot())
  await api.call('record', {
    kind: 'paced-output',
    batches: 100,
    lines: 1000,
    targetBatchPeriodMs: 16,
    elapsedMs,
    apiServiceTotalMs: serviceMs,
    drawIntervalSamplesMs: samples.slice(1).map((time, index) => time - samples[index]),
    drawIntervalsMs: distribution(
      samples.slice(1).map((time, index) => time - samples[index]),
    ),
  })
}
async function benchmark() {
  status.textContent = 'Warming up…'
  for (let index = 0; index < 2; index++) {
    await prepare()
    await write(burst('warmup', 300).bytes)
    await delay(200)
  }
  for (const name of ['plain', 'ansi', 'synchronized']) {
    status.textContent = `Checking ${name} burst…`
    await fixedBurst(burst(name))
  }
  const unicode = unicodeFixture()
  await fixedBurst(unicode)
  for (const cols of [72, 110, 100]) {
    const started = performance.now()
    await grid(cols)
    const resizeThroughDrawSchedulingAckMs = performance.now() - started
    await check(`unicode-reflow-${cols}`, unicode.expected, await snapshot())
    await api.call('record', {
      kind: 'reflow',
      cols,
      resizeThroughDrawSchedulingAckMs,
      frameDimensions: lastFrame
        ? { width: lastFrame.width, height: lastFrame.height }
        : undefined,
    })
  }
  await scrollChecks()
  await stream()
  const capture = await api.call('capture')
  await api.call('record', { kind: 'presentation', ...capture })
  await api.call('finish')
}
async function interactive() {
  document.querySelector('#controls').hidden = false
  await prepare()
  await write(demoFixture().bytes)
  await delay(150)
  const retained = await snapshot()
  await check('interactive-retained', demoFixture().expected, retained)
  const earliestRetained = retained.split('\n')[0]
  const retainedRows = retained.split('\n').length
  await api.call('record', {
    kind: 'interactive-retention',
    requestedRows: 3000,
    retainedRows,
    earliestRetainedRow: Number(earliestRetained.slice(0, 6)),
    latestRetainedRow: Number(retained.split('\n').at(-1).slice(0, 6)),
  })
  await binding('scroll_to_bottom')
  status.textContent =
    'Ready. Scroll the actual terminal above; output is paused. Close the window to release resources.'
  document.querySelector('#top').onclick = () => void binding('scroll_to_top')
  document.querySelector('#bottom').onclick = () => void binding('scroll_to_bottom')
  document.querySelector('#resize').onclick = () =>
    void grid(currentCols === 100 ? 72 : 100)
  let producer,
    sequence = 3000
  document.querySelector('#output').onclick = (event) => {
    if (producer) {
      clearInterval(producer)
      producer = undefined
      event.target.textContent = 'Start output'
    } else {
      event.target.textContent = 'Pause output'
      producer = setInterval(
        () =>
          void write(
            `${String(sequence++).padStart(6, '0')}  agent  streamed status · output is running\r\n`,
          ),
        100,
      )
    }
  }
  document.addEventListener('keydown', (event) => {
    const action = {
      PageUp: 'scroll_page_up',
      PageDown: 'scroll_page_down',
      Home: 'scroll_to_top',
      End: 'scroll_to_bottom',
    }[event.key]
    if (action) {
      event.preventDefault()
      void binding(action)
    }
  })
  await api.call('record', { kind: 'interactive-ready', rows: 3000 })
  if (settings.interactiveProbe) {
    await binding('scroll_to_top')
    await delay(150)
    const top = await snapshot(true)
    assert(
      top.split('\n')[0] === earliestRetained,
      `Interactive top differs from retained first row ${Number(earliestRetained.slice(0, 6))}`,
    )
    await api.call('capture', 'top')
    await api.call('input-wheel', -300)
    await delay(300)
    const scrolled = await snapshot(true)
    assert(
      scrolled !== top && scrolled.split('\n')[0] !== earliestRetained,
      'Electron wheel input did not scroll native viewport',
    )
    await api.call('capture', 'scrolled')
    await api.call('record', {
      kind: 'interactive-wheel-proof',
      passed: true,
      topFirstRow: Number(top.slice(0, 6)),
      scrolledFirstRow: Number(scrolled.slice(0, 6)),
      topHash: await digest(top),
      scrolledHash: await digest(scrolled),
    })
    await api.call('finish')
  }
}
try {
  settings = await api.call('initialize')
  document.querySelector('#title').textContent =
    `${settings.engine} · Menlo 14 · 100×30 · ${settings.interactive ? 'interactive scroll demo' : 'fixed qualification workloads'}`
  if (settings.engine === 'web') {
    document.querySelector('#native').remove()
    await GhosttyWeb.init({
      wasmUrl: new URL(
        '../../node_modules/ghostty-web/dist/ghostty-vt.wasm',
        import.meta.url,
      ),
    })
    terminal = new GhosttyWeb.Terminal({
      cols: 100,
      rows: 30,
      fontFamily: 'Menlo',
      fontSize: 14,
      scrollbackBytes: 10000000,
      cursorBlink: false,
      smoothScrollDuration: 0,
    })
    terminal.onRender(() => {
      const canvas = surface.querySelector('canvas')
      frame({ width: canvas.width, height: canvas.height })
    })
    terminal.open(surface)
    const canvas = surface.querySelector('canvas')
    await api.call('geometry', {
      cols: 100,
      rows: 30,
      width: canvas.width,
      height: canvas.height,
      scale: window.devicePixelRatio,
      font: 'Menlo',
      fontSize: 14,
    })
  } else {
    nativeGeometry = settings.geometry
    surface.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        const pixels =
          event.deltaMode === 1
            ? nativeGeometry.cellHeight / 2
            : event.deltaMode === 2
              ? nativeGeometry.height / 2
              : 1
        wheelPending = api.call(
          'scroll',
          -event.deltaX * pixels * 2,
          -event.deltaY * pixels * 2,
        )
        wheelPending.catch((error) => void api.call('fail', String(error)))
      },
      { passive: false },
    )
  }
  if (settings.interactive) await interactive()
  else await benchmark()
} catch (error) {
  status.textContent = String(error)
  await api.call('fail', String(error))
}
