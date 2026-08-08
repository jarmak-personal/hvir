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

  it.each([
    [199_999, 'normal', '19%', '200k'],
    [200_000, 'warning', '20%', '200k'],
    [399_999, 'warning', '39%', '400k'],
    [400_000, 'critical', '40%', '400k'],
  ])(
    'renders Claude %i-token usage with provider-owned pressure',
    (usedTokens, pressure, display, usedLabel) => {
      const claude = renderToStaticMarkup(
        createElement(TerminalContextMeter, {
          pressurePolicy: {
            assumedWindowTokens: 1_000_000,
            warningPercent: 20,
            criticalPercent: 40,
          },
          telemetry: contextHarnessSnapshot({
            providerId: asHarnessProviderId('claude-code'),
            provenance: 'test count',
            context: { usedTokens },
          }),
        }),
      )

      expect(claude).toContain(`class="terminal-context ${pressure}`)
      expect(claude).toContain(`aria-valuenow="${Math.floor(usedTokens / 10_000)}"`)
      expect(claude).toContain(`>${display}</span>`)
      expect(claude).toContain(`${usedLabel} / 1m context used (assumed capacity)`)
    },
  )

  it.each([
    [39.9, 'normal', '39%'],
    [40, 'warning', '40%'],
    [69.9, 'warning', '69%'],
    [70, 'critical', '70%'],
  ])(
    'keeps Codex %f%% usage on the default pressure thresholds',
    (usedPercent, pressure, display) => {
      const codex = renderToStaticMarkup(
        createElement(TerminalContextMeter, {
          telemetry: contextHarnessSnapshot({
            providerId: asHarnessProviderId('codex'),
            provenance: 'test percentage',
            context: {
              usedTokens: usedPercent * 2_000,
              windowTokens: 200_000,
              usedPercent,
            },
          }),
        }),
      )
      expect(codex).toContain(`class="terminal-context ${pressure}`)
      expect(codex).toContain(`aria-valuenow="${Math.floor(usedPercent)}"`)
      expect(codex).toContain(`>${display}</span>`)
      expect(codex).not.toContain('assumed capacity')
    },
  )
})
