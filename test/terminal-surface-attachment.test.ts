// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { TerminalSurfaceAttachment } from '../src/renderer/src/terminal/terminal-surface-attachment'
import type { TerminalPane } from '../src/renderer/src/terminal/terminal-pane'

afterEach(() => document.body.replaceChildren())

describe('TerminalSurfaceAttachment', () => {
  it('grants one exact lease, hides before reparenting, and restores the current workspace container', () => {
    const surface = new TerminalSurfaceAttachment()
    const pane = fakePane()
    const workspace = document.createElement('div')
    const replacementWorkspace = document.createElement('div')
    const detail = document.createElement('div')
    const staleDetail = document.createElement('div')

    document.body.append(workspace, replacementWorkspace, detail, staleDetail)
    surface.attach(workspace, 'visible')
    surface.mountPane(pane.value, workspace)
    surface.synchronize('visible')
    const lease = surface.acquireLease()
    expect(lease).toBe(1)
    expect(surface.acquireLease()).toBeUndefined()
    expect(pane.presentation.mock.calls.map(([value]) => value)).toEqual([
      'hidden',
      'visible',
      'hidden',
    ])

    expect(surface.attachLease(lease!, detail, 'visible')).toBe(true)
    expect(pane.reparent).toHaveBeenCalledExactlyOnceWith(detail)
    expect(surface.currentContainer).toBe(detail)
    expect(surface.canFocus()).toBe(true)
    expect(surface.detachLease(lease! + 1, staleDetail)).toBe(false)
    expect(surface.releaseLease(lease! + 1)).toBe(false)
    expect(surface.currentContainer).toBe(detail)

    surface.attach(replacementWorkspace, 'hidden')
    surface.detach(workspace)
    expect(surface.currentContainer).toBe(detail)
    expect(surface.releaseLease(lease!)).toBe(true)
    expect(pane.reparent).toHaveBeenLastCalledWith(replacementWorkspace)
    expect(surface.currentContainer).toBe(replacementWorkspace)
    expect(surface.presentation).toBe('hidden')
    expect(surface.canFocus()).toBe(false)
  })

  it('returns a detached lease surface hidden without allowing late cleanup to move a successor', () => {
    const surface = new TerminalSurfaceAttachment()
    const pane = fakePane()
    const workspace = document.createElement('div')
    const first = document.createElement('div')
    const second = document.createElement('div')
    document.body.append(workspace, first, second)
    surface.attach(workspace, 'hidden')
    surface.mountPane(pane.value, workspace)

    const firstLease = surface.acquireLease()!
    surface.attachLease(firstLease, first, 'visible')
    expect(surface.detachLease(firstLease, first)).toBe(true)
    expect(surface.currentContainer).toBe(workspace)
    expect(surface.presentation).toBe('hidden')
    surface.releaseLease(firstLease)

    const secondLease = surface.acquireLease()!
    surface.attachLease(secondLease, second, 'visible')
    expect(surface.releaseLease(firstLease)).toBe(false)
    expect(surface.currentContainer).toBe(second)
    expect(surface.isCurrentLease(secondLease, second)).toBe(true)
  })

  it('withdraws focus from a borrowed surface whose DOM is removed', () => {
    const surface = new TerminalSurfaceAttachment()
    const pane = fakePane()
    const workspace = document.createElement('div')
    const detail = document.createElement('div')
    document.body.append(workspace, detail)
    surface.attach(workspace, 'visible')
    surface.mountPane(pane.value, workspace)
    const lease = surface.acquireLease()!
    surface.attachLease(lease, detail, 'visible')
    expect(surface.canFocus()).toBe(true)

    detail.remove()
    expect(surface.canFocus()).toBe(false)
    surface.setLeasePresentation(lease, detail, 'visible')
    expect(surface.presentation).toBe('hidden')
  })

  it.each(['disconnected', 'detached while borrowed'] as const)(
    'parks a %s workspace pane hidden until a fresh connected attach',
    (reason) => {
      const surface = new TerminalSurfaceAttachment()
      const pane = fakePane()
      const workspace = document.createElement('div')
      const detail = document.createElement('div')
      document.body.append(workspace, detail)
      surface.attach(workspace, 'visible')
      surface.mountPane(pane.value, workspace)
      surface.synchronize('visible')
      const lease = surface.acquireLease()!
      surface.attachLease(lease, detail, 'visible')
      if (reason === 'detached while borrowed') surface.detach(workspace)
      workspace.remove()
      if (reason === 'detached while borrowed') document.body.append(workspace)
      expect(detail.querySelector('.terminal-engine-host')).toBe(pane.engine)
      pane.reparent.mockClear()
      pane.reparent.mockImplementationOnce((container: HTMLElement) => {
        expect(surface.presentation).toBe('hidden')
        expect(surface.currentContainer).toBeUndefined()
        container.append(pane.engine)
      })

      expect(surface.releaseLease(lease)).toBe(true)
      expect(detail.querySelector('.terminal-engine-host')).toBeNull()
      expect(workspace.querySelector('.terminal-engine-host')).toBe(pane.engine)
      expect(pane.reparent).toHaveBeenCalledExactlyOnceWith(workspace)
      expect(surface.currentContainer).toBeUndefined()
      expect(surface.presentation).toBe('hidden')
      expect(surface.canFocus()).toBe(false)
      document.body.append(workspace)
      surface.synchronize('visible')
      expect(surface.presentation).toBe('hidden')
      expect(surface.currentContainer).toBeUndefined()
      expect(surface.canFocus()).toBe(false)
      expect(surface.attachLease(lease, detail, 'visible')).toBe(false)
      expect(surface.isCurrentLease(lease, detail)).toBe(false)
      expect(detail.querySelector('.terminal-engine-host')).toBeNull()
      expect(workspace.querySelector('.terminal-engine-host')).toBe(pane.engine)

      surface.attach(workspace, 'visible')
      expect(workspace.querySelector('.terminal-engine-host')).toBe(pane.engine)
      expect(surface.currentContainer).toBe(workspace)
      expect(surface.canWorkspaceFocus()).toBe(true)
    },
  )
})

function fakePane() {
  const engine = document.createElement('div')
  engine.className = 'terminal-engine-host'
  const mount = vi.fn((container: HTMLElement) => {
    container.append(engine)
  })
  const reparent = vi.fn((container: HTMLElement) => {
    container.append(engine)
  })
  const presentation = vi.fn<TerminalPane['setPresentation']>()
  return {
    engine,
    mount,
    reparent,
    presentation,
    value: {
      mount,
      reparent,
      setPresentation: presentation,
    } as unknown as TerminalPane,
  }
}
