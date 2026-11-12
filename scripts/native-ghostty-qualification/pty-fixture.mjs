/* global process, Buffer, setTimeout */
// Fixed raw PTY peer. No model prompts, ambient files or executable command strings.
import { burst } from './workloads.mjs'
const tag = process.argv[2]
if (!['A', 'B'].includes(tag)) throw new Error('Expected synthetic session A or B')
process.stdin.setRawMode(true)
process.stdin.resume()
const write = (text) => process.stdout.write(text)
const escape = String.fromCharCode(27)
const steps = [
  { name: 'reply', expected: '\x1b[1;1R', output: '\x1b[?2004l' },
  { name: 'text', expected: 'hello', output: '' },
  { name: 'control', expected: '\x01', output: '' },
  { name: 'navigation', expected: '\x1b[A', output: '' },
  { name: 'enter', expected: '\r', output: '\x1b[?2004h' },
  {
    name: 'paste',
    expected: '\x1b[200~pasted\n界\x1b[201~',
    output: '\x1b[?2004l\x1b[?1000h\x1b[?1006h',
  },
  {
    name: 'mouse',
    expected: new RegExp(escape + '\\[<0;\\d+;\\d+M' + escape + '\\[<0;\\d+;\\d+m'),
    output: '\x1b[?1000l\x1b[?1006l\x1b[?1049hALT ' + tag,
  },
  { name: 'alternate', expected: 'x', output: '\x1b[?1049l' },
  { name: 'stream', expected: 'run', output: '' },
]
let index = 0,
  pending = Buffer.alloc(0)
write('\x1bc\x1b[6n')
process.stdin.on('data', (bytes) => {
  pending = Buffer.concat([pending, bytes])
  if (pending.length > 65536) throw new Error('Fixture input bound exceeded')
  const step = steps[index]
  if (!step) {
    const expected = Buffer.from('alive')
    if (!expected.subarray(0, pending.length).equals(pending))
      throw new Error('Unexpected survivor input')
    if (pending.length < expected.length) return
    pending = Buffer.alloc(0)
    write(`\r\nSURVIVOR:${tag}\r\n`)
    return
  }
  const text = pending.toString('utf8')
  const match =
    typeof step.expected === 'string'
      ? text.startsWith(step.expected)
        ? step.expected
        : undefined
      : step.expected.exec(text)?.[0]
  if (!match) {
    const expected = typeof step.expected === 'string' ? step.expected : undefined
    if (expected && !Buffer.from(expected).subarray(0, pending.length).equals(pending))
      throw new Error(`Unexpected ${step.name} input: ${pending.toString('hex')}`)
    return
  }
  if (Buffer.byteLength(match) !== pending.length)
    throw new Error('Unexpected additional fixture input')
  pending = Buffer.alloc(0)
  write(`\r\nOK:${tag}:${step.name}\r\n${step.output}`)
  index++
  if (step.name === 'stream') {
    // Paced chunks exercise interleaved sessions while retaining the exact stream.
    const fixture = burst(tag, 2000)
    // NEL next-line avoids PTY ONLCR rewriting in this exact-byte probe.
    const wire = fixture.bytes.replaceAll('\r\n', '\x1bE')
    write('\x1bc\x1b[3J\x1b[2J\x1b[H')
    let offset = 0
    const produce = () => {
      if (offset === wire.length) return
      const next = Math.min(wire.length, offset + 4096)
      write(wire.slice(offset, next))
      offset = next
      setTimeout(produce, 2)
    }
    produce()
  }
})
