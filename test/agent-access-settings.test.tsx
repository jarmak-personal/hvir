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

it('shows app-wide Off beside the independent extension grant and follows live access changes', async () => {
  let resolve!: (value: AgentAccessState) => void
  const initial = new Promise<AgentAccessState>((done) => {
    resolve = done
  })
  const state: AgentAccessState = {
    enabled: false,
    confirmDestructive: false,
    extensions: [],
    extensionsWritable: true,
    ready: true,
    instance: 'owned',
    confirmations: [],
    endpoint: '/planned/socket',
  }
  let publish!: (value: AgentAccessState) => void
  const unsubscribe = vi.fn()
  const invoke = vi.fn((channel: string) =>
    channel === 'agent:access'
      ? initial
      : Promise.resolve({ ...state, extensions: ['extension'] }),
  )
  vi.stubGlobal('hvir', {
    invoke,
    on: vi.fn((_channel: string, listener: typeof publish) => {
      publish = listener
      return unsubscribe
    }),
  })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  try {
    act(() =>
      root.render(createElement(AgentAccessSettings, { installation: 'extension' })),
    )
    const checkbox = element.querySelector<HTMLInputElement>('input')!
    expect(element.textContent).toContain('Checking app-wide agent access')
    expect(checkbox.disabled).toBe(true)
    act(() => publish(state))
    expect(element.querySelector('[role="status"]')?.textContent).toContain(
      'App-wide Agent access is off',
    )
    expect(element.textContent).not.toContain('/planned/socket')
    expect(checkbox.disabled).toBe(false)
    await act(async () => {
      checkbox.click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('agent:extension-configure', {
      installation: 'extension',
      enabled: true,
    })
    expect(invoke.mock.calls.some(([channel]) => channel === 'agent:configure')).toBe(
      false,
    )
    expect(checkbox.checked).toBe(true)
    expect(element.textContent).toContain('App-wide Agent access is off')
    act(() => publish({ ...state, enabled: true, extensions: ['extension'] }))
    expect(element.textContent).not.toContain('App-wide Agent access is off')
    expect(checkbox.checked).toBe(true)
    await act(async () => {
      resolve(state)
      await initial
    })
    expect(element.textContent).not.toContain('App-wide Agent access is off')
    act(() => publish({ ...state, extensions: ['extension'], ready: false }))
    expect(element.textContent).toContain('App-wide Agent access is unavailable')
    expect(element.textContent).not.toContain('App-wide Agent access is off')
  } finally {
    act(() => root.unmount())
    element.remove()
    vi.unstubAllGlobals()
  }
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('reports an unavailable access snapshot without claiming app-wide Off', async () => {
  vi.stubGlobal('hvir', {
    invoke: vi.fn(() => Promise.reject(new Error('unavailable'))),
    on: vi.fn(() => vi.fn()),
  })
  const element = document.createElement('div')
  const root = createRoot(element)
  try {
    await act(async () => {
      root.render(createElement(AgentAccessSettings, { installation: 'extension' }))
      await Promise.resolve()
    })
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Agent access is unavailable',
    )
    expect(element.textContent).not.toContain('app-wide agent access…')
    expect(element.textContent).not.toContain('App-wide Agent access is off')
    expect(element.querySelector<HTMLInputElement>('input')?.disabled).toBe(true)
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
