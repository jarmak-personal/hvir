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

it('keeps global access with author controls in the shared entry, outside selected package configuration', async () => {
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
    const authors = element.querySelector('.extension-author-controls')!
    expect(agent.closest<HTMLElement>('.extension-shared-settings')!.hidden).toBe(true)
    await act(
      async () =>
        await Promise.resolve(
          element
            .querySelector<HTMLButtonElement>('[aria-label="Extension settings"]')!
            .click(),
        ),
    )
    expect(agent.closest<HTMLElement>('.extension-shared-settings')!.hidden).toBe(false)
    expect(element.querySelector('[data-testid="package-configuration"]')).toBeNull()
    expect(agent.textContent).toContain('Allow agents to inspect')
    expect(agent.closest('details')).toBeNull()
    expect(
      agent.compareDocumentPosition(authors) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  } finally {
    act(() => root.unmount())
    element.remove()
    vi.unstubAllGlobals()
  }
})
