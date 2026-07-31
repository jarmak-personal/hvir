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
  it('labels the default-off control as session-only and exposes keyboard input', () => {
    const onToggle = vi.fn(() => Promise.resolve(true))
    render(snapshot(), { onToggle })

    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(checkbox?.checked).toBe(false)
    expect(checkbox?.disabled).toBe(false)
    expect(host.textContent).toContain('Rich output')
    expect(host.textContent).toContain('This session only · Off')

    act(() => checkbox?.click())
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('shows an explicit unavailable state without an actionable toggle', () => {
    render(snapshot({ control: 'unavailable' }))

    expect(host.querySelector<HTMLInputElement>('input')?.disabled).toBe(true)
    expect(host.textContent).toContain('Unavailable for this session')
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
        onToggle={() => Promise.resolve(true)}
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
