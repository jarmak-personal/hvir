// Bounded versions of capacity-output-fixtures.ts and capacity-terminals.ts concepts.
export const RESET = '\x1bc\x1b[3J\x1b[2J\x1b[H'
export function numberedLines(prefix, count, body = 'abcdefghijklmnopqrstuvwxyz') {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index).padStart(6, '0')} ${body}`,
  )
}
export function burst(name, count = 2000) {
  const lines = numberedLines(name, count)
  let bytes = lines
    .map((line) => (name === 'ansi' ? `\x1b[36m${line}\x1b[0m\r\n` : `${line}\r\n`))
    .join('')
  if (name === 'synchronized') bytes = `\x1b[?2026h${bytes}\x1b[?2026l`
  return { name, bytes, expected: lines.join('\n') }
}
export function unicodeFixture() {
  const lines = numberedLines('unicode', 400, '界e\u0301🙂'.repeat(24))
  return {
    name: 'unicode-retained',
    bytes: lines.join('\r\n') + '\r\n',
    expected: lines.join('\n'),
  }
}
export function demoFixture(count = 3000) {
  const lines = Array.from({ length: count }, (_, index) => {
    const number = String(index).padStart(6, '0')
    return `${number}  ${['agent', 'git  ', 'build', 'test '][index % 4]}  project/src/module-${index % 47}.ts  ${index % 11 ? 'completed in 12ms' : '界 e\u0301 🙂 ready'}`
  })
  return {
    name: 'scrollback',
    bytes: lines
      .map((line, index) => `\x1b[38;5;${32 + (index % 180)}m${line}\x1b[0m\r\n`)
      .join(''),
    expected: lines.join('\n'),
  }
}
// Fixtures contain no intentional trailing whitespace; normalize only terminal padding/empty rows.
export function normalize(text) {
  return text
    .replaceAll('\r', '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n+$/u, '')
}
export function distribution(samples) {
  const ordered = [...samples].sort((a, b) => a - b)
  const percentile = (p) =>
    ordered[Math.max(0, Math.ceil(ordered.length * p) - 1)] ?? null
  return {
    count: samples.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: ordered.at(-1) ?? null,
  }
}
