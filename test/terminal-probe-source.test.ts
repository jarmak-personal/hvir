import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { terminalProbeSourceDelivery } from '../src/main/smoke/terminal-probe-source'

describe('terminal probe source delivery', () => {
  it('preserves long source through bounded shell commands with real acknowledgements', () => {
    const source = 'hello λ\n'.repeat(600)
    const delivery = terminalProbeSourceDelivery(
      source,
      'HVIR_TEST_PROBE_B64',
      '__HVIR_TEST_DELIVERY_',
    )
    for (const { command, marker } of delivery) {
      expect(Buffer.byteLength(command)).toBeLessThan(1024)
      expect(command).not.toContain(marker)
    }
    const transcript = execFileSync(
      '/bin/sh',
      [
        '-c',
        delivery.map(({ command }) => command).join('') +
          'printf "%s" "$HVIR_TEST_PROBE_B64"',
      ],
      { encoding: 'utf8' },
    )
    const lines = transcript.split('\n')
    expect(lines.slice(0, -1)).toEqual(delivery.map(({ marker }) => marker))
    expect(Buffer.from(lines.at(-1)!, 'base64').toString()).toBe(source)
  })
})
