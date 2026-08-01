// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RichOutputLane } from '../src/renderer/src/terminal/RichOutputLane'
import type { RichOutputSnapshot } from '../src/renderer/src/terminal/rich-output-coordinator'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('RichOutputLane', () => {
  it('keeps presentation chrome absent until a rich message exists', () => {
    render(snapshot())

    expect(host.innerHTML).toBe('')
  })

  it('retains a safely aborted message after the source becomes unavailable', () => {
    render(
      snapshot({
        control: 'unavailable',
        messages: [
          {
            id: 'message-1',
            turnId: 'turn-1',
            state: 'aborted',
            bytes: 4,
            rows: [
              {
                kind: 'status',
                prefix: '!',
                spans: [{ text: ' Interrupted', styles: [] }],
              },
            ],
          },
        ],
      }),
    )

    expect(host.querySelector('[aria-label="Rich assistant output"]')).not.toBeNull()
    expect(host.textContent).toContain('Interrupted')
  })

  it('renders selectable plain text with link activation and a dedicated copy action', () => {
    const onActivateLink = vi.fn()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      snapshot({
        enabled: true,
        messages: [
          {
            id: 'message-1',
            turnId: 'turn-1',
            state: 'ended',
            bytes: 4,
            rows: [
              {
                kind: 'paragraph',
                prefix: '• ',
                spans: [
                  {
                    text: 'docs',
                    styles: ['link'],
                    link: { kind: 'https', target: 'https://example.com/' },
                  },
                ],
              },
            ],
          },
        ],
      }),
      { onActivateLink },
    )

    const row = host.querySelector('.terminal-rich-row')
    expect(row?.textContent).toBe('• docs')
    const link = host.querySelector<HTMLButtonElement>('.terminal-rich-link')
    expect(link?.title).toBe('https://example.com/')
    act(() => link?.click())
    expect(onActivateLink).toHaveBeenCalledWith({
      kind: 'https',
      target: 'https://example.com/',
    })

    const copy = host.querySelector<HTMLButtonElement>('.terminal-rich-copy-target')
    expect(copy?.getAttribute('aria-label')).toBe('Copy target https://example.com/')
    act(() => copy?.click())
    expect(writeText).toHaveBeenCalledExactlyOnceWith('https://example.com/')
  })

  it('omits the entire presentation for unsupported sessions', () => {
    render(snapshot({ control: 'hidden' }))

    expect(host.innerHTML).toBe('')
  })
})

function render(
  value: RichOutputSnapshot,
  overrides: Partial<Parameters<typeof RichOutputLane>[0]> = {},
): void {
  act(() => {
    root.render(
      <RichOutputLane
        snapshot={value}
        visible
        onActivateLink={() => undefined}
        disclosureTarget={(link) => link.target}
        fontFamily="ui-monospace"
        fontSize={13}
        {...overrides}
      />,
    )
  })
}

function snapshot(overrides: Partial<RichOutputSnapshot> = {}): RichOutputSnapshot {
  return {
    control: 'available',
    enabled: false,
    changing: false,
    messages: [],
    ...overrides,
  }
}
