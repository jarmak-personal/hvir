/* global process */
// A fixed TUI peer: observes real SIGWINCH/kernel geometry and immediately redraws.
import { execFileSync } from 'node:child_process'
const output = process.stdout
process.stdin.setRawMode(true)
process.stdin.resume()
const escape = String.fromCharCode(27)
const reply = new RegExp(
  '^' + escape + '\\[(?:(\\d+);(\\d+)R|8;(\\d+);(\\d+)t|4;(\\d+);(\\d+)t)',
)
let signals = 0,
  stdoutResizes = 0,
  sequence = 0,
  current,
  pending = ''
output.on('resize', () => {
  stdoutResizes++
})
function redraw(cause) {
  if (current) throw new Error('Overlapping fixed-peer query')
  const cols = output.columns,
    rows = output.rows
  current = {
    sequence: sequence++,
    cause,
    signals,
    stdoutResizes,
    cols,
    rows,
    cursors: [],
  }
  // Write the redraw before querying stty, preserving the immediate SIGWINCH case.
  output.write(
    `${escape}[?1049h${escape}[2J${escape}[HREDRAW:${current.sequence} CHILD:${cols}x${rows}\r\n` +
      'L' +
      '.'.repeat(cols - 2) +
      'R' +
      `${escape}[1;1H${escape}[999G${escape}[6n` +
      `${escape}[3;1H` +
      'w'.repeat(cols) +
      'z' +
      `${escape}[6n${escape}[18t${escape}[14t`,
  )
  // This external fixed test peer uses stty on its own inherited terminal, not an
  // application host operation or a separately spawned PTY.
  const [kernelRows, kernelCols] = execFileSync('/bin/stty', ['size'], {
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 1000,
  })
    .trim()
    .split(/\s+/u)
    .map(Number)
  current.kernel = { rows: kernelRows, cols: kernelCols }
}
process.on('SIGWINCH', () => {
  signals++
  redraw('SIGWINCH')
})
process.stdin.on('data', (bytes) => {
  pending += bytes.toString('utf8')
  if (pending.length > 65536) throw new Error('Fixed resize peer input exceeded bound')
  while (pending) {
    if (pending.startsWith('Q')) {
      pending = pending.slice(1)
      redraw('request')
      continue
    }
    const match = reply.exec(pending)
    if (!match) {
      if (!pending.startsWith(escape)) throw new Error('Unexpected fixed-peer input')
      return
    }
    if (!current) throw new Error('Reply without an active fixed-peer query')
    pending = pending.slice(match[0].length)
    if (match[1]) current.cursors.push({ row: Number(match[1]), col: Number(match[2]) })
    else if (match[3]) current.cells = { rows: Number(match[3]), cols: Number(match[4]) }
    else current.pixels = { height: Number(match[5]), width: Number(match[6]) }
    if (current.cursors.length === 2 && current.cells && current.pixels) {
      output.write('\r\nRESIZE_RECORD ' + JSON.stringify(current) + '\r\n')
      current = undefined
    }
  }
})
redraw('startup')
