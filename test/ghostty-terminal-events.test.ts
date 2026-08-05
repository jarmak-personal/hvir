import type { TerminalEvent as GhosttyTerminalEvent } from 'ghostty-web'
import { describe, expect, it } from 'vitest'

import { translateGhosttyTerminalEvent } from '../src/renderer/src/terminal/ghostty-terminal-events'
import type { TerminalEvent } from '../src/renderer/src/terminal/terminal-pane'

describe('Ghostty terminal event translation', () => {
  it('translates every parser-owned event family into the closed pane contract', () => {
    const cases: ReadonlyArray<readonly [GhosttyTerminalEvent, TerminalEvent]> = [
      [
        { type: 'title', title: 'Agent' },
        { type: 'title', title: 'Agent' },
      ],
      [
        { type: 'working-directory', uri: 'file://remote/untrusted' },
        { type: 'working-directory', uri: 'file://remote/untrusted' },
      ],
      [{ type: 'bell' }, { type: 'bell' }],
      [
        {
          type: 'notification',
          source: 'osc-777',
          title: 'Done',
          body: 'Review requested',
        },
        {
          type: 'notification',
          source: 'osc-777',
          title: 'Done',
          body: 'Review requested',
        },
      ],
      [
        { type: 'progress', state: 'set', progress: 42 },
        { type: 'progress', state: 'set', progress: 42 },
      ],
      [
        { type: 'progress', state: 'indeterminate' },
        { type: 'progress', state: 'indeterminate' },
      ],
      [
        {
          type: 'semantic',
          action: 'end-input-start-output',
          options: 'k=v',
          provenance: { id: 7, screen: 'alternate', row: 3 },
        },
        {
          type: 'semantic',
          action: 'end-input-start-output',
          options: 'k=v',
          provenance: { id: 7, screen: 'alternate', row: 3 },
        },
      ],
      [
        {
          type: 'palette',
          operation: 11,
          request: {
            type: 'set',
            target: { kind: 'dynamic', name: 'background' },
            color: { r: 1, g: 2, b: 3 },
          },
        },
        {
          type: 'palette',
          operation: 11,
          request: {
            type: 'set',
            target: { kind: 'dynamic', name: 'background' },
            color: { r: 1, g: 2, b: 3 },
          },
        },
      ],
      [
        {
          type: 'clipboard',
          operation: 'read',
          selection: 'c',
        },
        {
          type: 'clipboard',
          operation: 'read',
          selection: 'c',
        },
      ],
      [
        {
          type: 'clipboard',
          operation: 'write',
          selection: 'p',
          data: 'untrusted payload',
        },
        {
          type: 'clipboard',
          operation: 'write',
          selection: 'p',
          data: 'untrusted payload',
        },
      ],
    ]

    expect(cases.map(([source]) => translateGhosttyTerminalEvent(source))).toEqual(
      cases.map(([, expected]) => expected),
    )
  })

  it('preserves every typed palette request without granting palette authority', () => {
    const requests: GhosttyTerminalEvent[] = [
      {
        type: 'palette',
        operation: 4,
        request: { type: 'query', target: { kind: 'palette', index: 12 } },
      },
      {
        type: 'palette',
        operation: 5,
        request: {
          type: 'reset',
          target: { kind: 'special', name: 'underline' },
        },
      },
      { type: 'palette', operation: 6, request: { type: 'reset-palette' } },
      { type: 'palette', operation: 7, request: { type: 'reset-special' } },
    ]

    expect(requests.map(translateGhosttyTerminalEvent)).toEqual(requests)
  })

  it('fails closed if a mismatched runtime adds an unknown family', () => {
    expect(
      translateGhosttyTerminalEvent({
        type: 'future-family',
      } as unknown as GhosttyTerminalEvent),
    ).toBeUndefined()
  })

  it('fails closed for unknown notification and palette variants', () => {
    const unknownEvents = [
      {
        type: 'notification',
        source: 'future-source',
        title: 'Untrusted',
        body: 'No attention authority',
      },
      {
        type: 'palette',
        operation: 8,
        request: { type: 'future-request' },
      },
      {
        type: 'palette',
        operation: 9,
        request: { type: 'query', target: { kind: 'future-target' } },
      },
    ] as unknown as GhosttyTerminalEvent[]

    expect(unknownEvents.map(translateGhosttyTerminalEvent)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })
})
