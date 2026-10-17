// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { AgentAccessSettings } from '../src/renderer/src/settings/sections/AgentAccessSettings'
import type { AgentAccessState } from '../src/shared/agent/contract'

it('keeps SSH availability and selected grants visible while permissions are collapsed and global Off remains usable', async () => {
  const state: AgentAccessState = {
    enabled: true,
    confirmDestructive: true,
    extensions: [],
    extensionsWritable: true,
    ready: true,
    instance: 'owned',
    confirmations: [],
    forwards: [
      {
        host: 'connected',
        generation: 'one',
        availability: 'ready',
        grants: [
          {
            host: 'connected',
            generation: 'one',
            installation: 'extension',
            revision: 'accepted',
            action: 'observe',
            capability: 'connector.execute',
            executionHost: 'connected',
            workspace: 'project',
          },
        ],
      },
      {
        host: 'offline',
        generation: 'two',
        availability: 'unavailable',
        explanation: 'Host is disconnected',
        grants: [],
      },
    ],
  }
  const invoke = vi.fn((channel: string) =>
    Promise.resolve(channel === 'agent:configure' ? { ...state, enabled: false } : state),
  )
  const unsubscribe = vi.fn()
  vi.stubGlobal('hvir', { invoke, on: vi.fn(() => unsubscribe) })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  try {
    await act(async () => {
      root.render(createElement(AgentAccessSettings))
      await Promise.resolve()
    })
    const details = element.querySelector('details')!
    expect(details.open).toBe(false)
    const statuses = [...element.querySelectorAll('[role="status"]')].filter(
      (e) => !e.closest('details'),
    )
    expect(statuses.map((e) => e.textContent)).toEqual([
      'SSH agent access: connected — ready · 1 enabled grant selections',
      'SSH agent access: offline — unavailable · 0 enabled grant selections · Host is disconnected',
    ])
    expect(
      element.textContent?.match(
        /Other processes running as your account share this access/g,
      ),
    ).toHaveLength(1)
    expect(details.querySelector('summary')?.textContent).toContain(
      'confirm deletions and replacements',
    )
    await act(async () => {
      element.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('agent:configure', {
      enabled: false,
      confirmDestructive: true,
    })
    expect(element.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(
      false,
    )
  } finally {
    act(() => root.unmount())
    element.remove()
    vi.unstubAllGlobals()
  }
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})
