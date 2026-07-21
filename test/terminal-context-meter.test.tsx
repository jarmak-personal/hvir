import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TerminalContextMeter } from '../src/renderer/src/terminal/TerminalContextMeter'
import {
  asHarnessProviderId,
  contextHarnessSnapshot,
  contextStatusHarnessSnapshot,
} from '../src/shared'

describe('TerminalContextMeter', () => {
  it('renders absent, pending, and unavailable context as distinct accessible states', () => {
    const absent = renderToStaticMarkup(createElement(TerminalContextMeter))
    const pending = renderToStaticMarkup(
      createElement(TerminalContextMeter, {
        countOnly: true,
        telemetry: contextStatusHarnessSnapshot({
          providerId: asHarnessProviderId('claude-code'),
          provenance: 'test pending',
          sessionId: 'session-1',
          context: {
            status: 'pending',
            reason: 'Waiting for Claude context telemetry',
          },
        }),
      }),
    )
    const unavailable = renderToStaticMarkup(
      createElement(TerminalContextMeter, {
        countOnly: true,
        telemetry: contextStatusHarnessSnapshot({
          providerId: asHarnessProviderId('claude-code'),
          provenance: 'test unavailable',
          sessionId: 'session-1',
          context: {
            status: 'unavailable',
            reason: 'Claude context follower unavailable',
          },
        }),
      }),
    )

    expect(absent).toContain('aria-label="Context usage unavailable"')
    expect(absent).toContain('>--</span>')
    expect(pending).toContain('class="terminal-context pending count-display"')
    expect(pending).toContain('title="Waiting for Claude context telemetry"')
    expect(pending).toContain('aria-label="Waiting for Claude context telemetry"')
    expect(pending).toContain('>…</span>')
    expect(unavailable).toContain('class="terminal-context unavailable count-display"')
    expect(unavailable).toContain('title="Claude context follower unavailable"')
    expect(unavailable).toContain('aria-label="Claude context follower unavailable"')
    expect(unavailable).toContain('>!</span>')
  })

  it('keeps Claude counts and Codex percentages unchanged', () => {
    const claude = renderToStaticMarkup(
      createElement(TerminalContextMeter, {
        countOnly: true,
        telemetry: contextHarnessSnapshot({
          providerId: asHarnessProviderId('claude-code'),
          provenance: 'test count',
          context: { usedTokens: 21_634 },
        }),
      }),
    )
    const codex = renderToStaticMarkup(
      createElement(TerminalContextMeter, {
        telemetry: contextHarnessSnapshot({
          providerId: asHarnessProviderId('codex'),
          provenance: 'test percentage',
          context: { usedTokens: 81_400, windowTokens: 200_000, usedPercent: 40.7 },
        }),
      }),
    )

    expect(claude).toContain('>21.6k</span>')
    expect(codex).toContain('aria-valuenow="40"')
    expect(codex).toContain('>40%</span>')
  })
})
