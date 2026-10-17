// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ExtensionsSettings } from '../src/renderer/src/settings/sections/ExtensionsSettings'
import type {
  ExtensionAdditionResult,
  ExtensionPlatformState,
} from '../src/shared/extensions/workbench'
import { exampleManifest } from './fixtures/extension-package'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'

vi.mock('../src/renderer/src/settings/sections/AgentAccessSettings', () => ({
  AgentAccessSettings: () => null,
}))

it('selects the exact next Add after removal retains the missing prior directory, with receipt arriving at publication commit', async () => {
  const directory = {
    source: 'imported-directory',
    installationId: 'directory',
    manifest: validateExtensionManifest(exampleManifest({ name: 'Imported directory' }))
      .manifest,
    enabled: true,
    warnings: [],
    kind: 'directory' as const,
    revision: 'a'.repeat(64),
    sourceIdentity: '1:2',
  }
  const missing = {
    source: directory.source,
    installationId: directory.installationId,
    enabled: false,
    retainedIdentity: true,
    warnings: [],
    kind: 'directory' as const,
    error: 'Package is missing. Use Add extension to reinstall it.',
  }
  const zip = {
    ...directory,
    source: 'imported-zip.zip',
    installationId: 'zip',
    kind: 'zip' as const,
    manifest: { ...directory.manifest, id: 'example.zip', name: 'Imported ZIP' },
    sourceIdentity: '1:3',
    revision: 'b'.repeat(64),
  }
  const initial = { writable: true, installations: [directory] }
  const removed = { writable: true, installations: [missing] }
  const imported = { writable: true, installations: [zip, missing] }
  let publish!: (value: ExtensionPlatformState) => void
  let finish!: (value: ExtensionAdditionResult) => void
  let remove!: (value: ExtensionPlatformState) => void
  const adding = new Promise<ExtensionAdditionResult>((resolve) => {
    finish = resolve
  })
  const removing = new Promise<ExtensionPlatformState>((resolve) => {
    remove = resolve
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('hvir', {
    invoke: (channel: string) =>
      channel === 'extensions:state'
        ? Promise.resolve(initial)
        : channel === 'extensions:remove'
          ? removing
          : channel === 'extensions:add'
            ? adding
            : Promise.resolve([]),
    on: (channel: string, callback: typeof publish) => {
      if (channel === 'extensions:state-changed') publish = callback
      return () => {}
    },
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => entry.textContent?.trim() === name,
    )!
  const selected = () =>
    host
      .querySelector('.extension-installation-list [aria-current="true"]')
      ?.getAttribute('data-source')
  let delivered = false
  const observer = new MutationObserver(() => {
    if (!host.querySelector('[data-source="imported-zip.zip"]') || delivered) return
    delivered = true
    finish({ ...imported, installed: { installationId: 'zip' } })
  })
  try {
    await act(async () => {
      root.render(createElement(ExtensionsSettings))
      await Promise.resolve()
    })
    act(() => button('Remove').click())
    act(() => button('Confirm remove').click())
    await act(async () => {
      publish(removed)
      remove(removed)
      await removing
    })
    expect(selected()).toBe('imported-directory')
    act(() => button('Add extension…').click())
    observer.observe(host, { childList: true, subtree: true })
    // Exercise actual browser/React publication and microtask delivery rather than
    // forcing passive effects to flush before the receipt through act().
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)
    publish(imported)
    await adding
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    await act(async () => {
      await Promise.resolve()
    })
    expect(delivered).toBe(true)
    expect(selected()).toBe('imported-zip.zip')
    expect(host.querySelector('.extension-installation h4')?.textContent).toBe(
      'Imported ZIP',
    )
  } finally {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    observer.disconnect()
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
