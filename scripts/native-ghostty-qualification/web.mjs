/* global URL, GhosttyWeb, window, document, performance, setInterval, clearInterval, setTimeout */
try {
  await GhosttyWeb.init({
    wasmUrl: new URL(
      '../../node_modules/ghostty-web/dist/ghostty-vt.wasm',
      import.meta.url,
    ),
  })
  const terminal = new GhosttyWeb.Terminal({ cols: 120, rows: 37, fontSize: 12 })
  terminal.open(document.querySelector('#terminal'))
  let count = 0
  let last = 0
  let longest = 0
  let lines = 0
  let writeMs = 0
  terminal.onRender(() => {
    const now = performance.now()
    if (last) longest = Math.max(longest, now - last)
    last = now
    count++
    if (count % 60 === 0)
      window.qualificationObserve({
        event: 'web-render-scheduled',
        count,
        longestMs: longest,
      })
  })
  const start = performance.now()
  const timer = setInterval(() => {
    const output = Array.from(
      { length: 10 },
      () =>
        `\x1b[38;5;${16 + (lines++ % 216)}m${String(lines).padStart(6)} Ghostty native qualification αβ 🚀\x1b[0m\r\n`,
    ).join('')
    const before = performance.now()
    terminal.write(output)
    writeMs += performance.now() - before
  }, 8)
  setTimeout(() => {
    clearInterval(timer)
    window.qualificationObserve({
      event: 'web-complete',
      count,
      longestMs: longest,
      lines,
      writeMs,
      elapsedMs: performance.now() - start,
    })
    terminal.dispose()
  }, 10000)
} catch (error) {
  window.qualificationObserve({ event: 'web-failure', error: String(error) })
}
