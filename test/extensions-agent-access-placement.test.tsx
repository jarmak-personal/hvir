// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ExtensionsSettings } from '../src/renderer/src/settings/sections/ExtensionsSettings'

vi.mock('../src/renderer/src/settings/sections/ExtensionInstallationSettings', () => ({
  ExtensionInstallationSettings: () =>
    createElement(
      'div',
      { 'data-testid': 'package-configuration' },
      'Package configuration',
    ),
}))
vi.mock('../src/renderer/src/settings/sections/DeliveryRecoverySettings', () => ({
  DeliveryRecoverySettings: () => null,
}))

it('places app-wide agent access before package configuration and author controls', async () => {
  vi.stubGlobal('hvir', {
    invoke: vi.fn((channel: string) => {
      if (channel === 'extensions:state')
        return Promise.resolve({
          writable: true,
          installations: [{ source: 'package', enabled: false, warnings: [] }],
        })
      if (channel === 'agent:access')
        return Promise.resolve({
          enabled: false,
          confirmDestructive: false,
          extensions: [],
          extensionsWritable: true,
          ready: true,
          instance: 'owned',
          confirmations: [],
        })
      throw new Error('Unexpected setup request')
    }),
    on: vi.fn(() => vi.fn()),
  })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  try {
    await act(async () => {
      root.render(createElement(ExtensionsSettings))
      await Promise.resolve()
    })
    const agent = element.querySelector('.agent-access-settings')!
    const packageConfiguration = element.querySelector(
      '[data-testid="package-configuration"]',
    )!
    const authors = element.querySelector('.extension-author-controls')!
    expect(agent.textContent).toContain('Allow agents to inspect')
    expect(agent.closest('details')).toBeNull()
    expect(
      agent.compareDocumentPosition(packageConfiguration) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      agent.compareDocumentPosition(authors) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  } finally {
    act(() => root.unmount())
    element.remove()
    vi.unstubAllGlobals()
  }
})
