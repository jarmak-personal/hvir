// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalRail } from '../src/renderer/src/terminal/TerminalRail'
import type { TerminalSession } from '../src/renderer/src/terminal/terminal-workspace-model'
import { asHarnessProfileId, asHarnessProviderId, localPath } from '../src/shared'
import { sessionsProjectionFixture } from './sessions-projection-fixture'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  )
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('compact terminal rail', () => {
  it('shows a labelled bell icon in the expanded rail and keeps Ready and Working text', () => {
    renderRail({
      sessions: [
        session('terminal-ready', 'idle'),
        session('terminal-bell', 'bell'),
        session('terminal-working', 'working'),
      ],
    })

    const badge = host.querySelector<HTMLElement>('.terminal-list [aria-label="Bell"]')
    expect(badge?.title).toBe('Bell')
    expect(badge?.textContent).toBe('')
    expect(badge?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(host.querySelector('.terminal-list [aria-label="Ready"]')?.textContent).toBe(
      'ready',
    )
    expect(host.querySelector('.terminal-list [aria-label="Working"]')?.textContent).toBe(
      'working',
    )
  })

  it('closes both menus and exposes labelled native transition controls', () => {
    const onCompact = vi.fn()
    const onToggleMenu = vi.fn()
    const onToggleMoveMenu = vi.fn()
    renderRail({
      menuOpen: true,
      moveMenuOpen: true,
      onCompact,
      onToggleMenu,
      onToggleMoveMenu,
    })

    const collapse = button('Collapse terminal rail')
    expect(collapse.tabIndex).toBe(0)
    collapse.focus()
    act(() => collapse.click())

    expect(onToggleMenu).toHaveBeenCalledOnce()
    expect(onToggleMoveMenu).toHaveBeenCalledOnce()
    expect(onCompact).toHaveBeenCalledWith(true)

    renderRail({ compact: true, onCompact })
    expect(host.querySelector<HTMLElement>('.terminal-rail-header')?.hidden).toBe(true)
    expect(host.querySelector<HTMLElement>('.terminal-list')?.hidden).toBe(true)
    const strip = host.querySelector<HTMLElement>('.terminal-rail-compact-strip')
    const restore = button('Restore terminal rail')
    expect(strip?.hidden).toBe(false)
    expect(strip?.firstElementChild).toBe(restore)
    expect(strip?.querySelector('button')).toBe(restore)
    expect([...(strip?.children ?? [])].map((child) => child.classList[0])).toEqual([
      'terminal-rail-restore',
      'terminal-rail-compact-rollups',
      'terminal-rail-compact-markers',
    ])
    expect(restore.tabIndex).toBe(0)

    act(() => restore.click())
    expect(onCompact).toHaveBeenLastCalledWith(false)
  })

  it('keeps separate Ready and bell rollups visible in the compact strip', () => {
    renderRail({
      compact: true,
      sessions: [
        session('terminal-ready', 'idle'),
        session('terminal-bell', 'bell'),
        session('terminal-working', 'working'),
      ],
    })

    const strip = host.querySelector<HTMLElement>('.terminal-rail-compact-strip')
    expect(strip?.querySelector('[aria-label="1 terminal ready"]')?.textContent).toBe(
      'R1',
    )
    const bell = strip?.querySelector<HTMLElement>('[aria-label="1 terminal bell"]')
    expect(bell?.textContent).toBe('1')
    expect(bell?.title).toBe('1 terminal bell')
    expect(bell?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(
      strip?.querySelector('.terminal-rail-compact-rollups')?.getAttribute('aria-label'),
    ).toBe('1 ready, 1 bell')
    expect(strip?.querySelector('[role="status"]')).not.toBeNull()
  })

  it('shows ordered keyboard-native markers with state, title, and active labels', () => {
    renderRail({
      compact: true,
      sessions: [
        session('terminal-neutral', undefined),
        session('terminal-working', 'working'),
        session('terminal-ready', 'idle'),
        session('terminal-bell', 'bell'),
      ],
      activeId: 'terminal-working',
    })

    const markers = markerButtons()
    expect(markers.map((marker) => marker.dataset.terminalSession)).toEqual([
      'terminal-neutral',
      'terminal-working',
      'terminal-ready',
      'terminal-bell',
    ])
    expect(markers.map((marker) => marker.textContent)).toEqual(['', '…', 'R', ''])
    expect(markers[3]?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(markers.map((marker) => marker.getAttribute('aria-label'))).toEqual([
      'terminal-neutral, Neutral',
      'terminal-working, Working, active terminal',
      'terminal-ready, Ready',
      'terminal-bell, Bell',
    ])
    expect(markers.map((marker) => marker.title)).toEqual(
      markers.map((marker) => marker.getAttribute('aria-label')),
    )
    expect(
      markers.every((marker) => marker.type === 'button' && marker.tabIndex === 0),
    ).toBe(true)
    expect(markers[1]?.getAttribute('aria-current')).toBe('true')
    expect(markers[1]?.classList.contains('active')).toBe(true)
    expect(new Set(markers.map((marker) => marker.dataset.terminalState))).toEqual(
      new Set(['neutral', 'working', 'idle', 'bell']),
    )
  })

  it('selects a marker through the existing focus command without restoring the rail', () => {
    const onCompact = vi.fn()
    const onFocusSession = vi.fn()
    renderRail({
      compact: true,
      sessions: [
        session('terminal-first', undefined),
        session('terminal-second', 'idle'),
      ],
      activeId: 'terminal-first',
      onCompact,
      onFocusSession,
    })

    const second = markerButtons()[1]
    second?.focus()
    act(() => second?.click())

    expect(document.activeElement).toBe(second)
    expect(onFocusSession).toHaveBeenCalledOnce()
    expect(onFocusSession).toHaveBeenCalledWith('terminal-second')
    expect(onCompact).not.toHaveBeenCalled()
    expect(host.querySelector<HTMLElement>('.terminal-rail-compact-strip')?.hidden).toBe(
      false,
    )
    expect(button('Restore terminal rail')).not.toBeNull()
  })
})

function renderRail(overrides: Partial<ComponentProps<typeof TerminalRail>> = {}): void {
  const props: ComponentProps<typeof TerminalRail> = {
    label: 'main',
    visible: true,
    compact: false,
    onCompact: vi.fn(),
    terminalTheme: 'app',
    recoveryReady: true,
    available: true,
    menuOpen: false,
    sessionsProjection: sessionsProjectionFixture(),
    moveMenuOpen: false,
    moveTargets: [],
    launchMenuEntries: [],
    split: false,
    sessions: [session('terminal-ready', 'idle')],
    activeId: 'terminal-ready',
    providers: [],
    profiles: [],
    onSplit: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleMenu: vi.fn(),
    onToggleMoveMenu: vi.fn(),
    onPlanMove: vi.fn(),
    onDismissNewTargets: vi.fn(),
    onAddSession: vi.fn(),
    onAddHarness: vi.fn(),
    onRefreshProbes: vi.fn(),
    onOpenHarnessSettings: vi.fn(),
    onFocusSession: vi.fn(),
    onMoveSession: vi.fn(),
    onCloseSession: vi.fn(),
    ...overrides,
  }
  act(() => root.render(<TerminalRail {...props} />))
}

function button(label: string): HTMLButtonElement {
  const value = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!value) throw new Error(`terminal rail button missing: ${label}`)
  return value
}

function markerButtons(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('.terminal-rail-compact-marker')]
}

function session(id: string, attention: TerminalSession['attention']): TerminalSession {
  return {
    id,
    providerId: asHarnessProviderId('codex'),
    profileId: asHarnessProfileId('codex-default'),
    launchRevision: 1,
    capabilities: {
      sessionIdentity: 'discovered',
      exactResume: true,
      contextPresentation: 'none',
    },
    fallbackTitle: 'Codex · repo',
    title: id,
    status: 'running',
    identityStatus: 'identified',
    resumeOnStart: false,
    pane: 'primary',
    cwd: localPath('/repo'),
    attention,
  }
}
