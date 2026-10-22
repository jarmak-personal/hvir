// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionsSettings } from '../src/renderer/src/settings/sections/ExtensionsSettings'
import type { AgentAccessState } from '../src/shared/agent/contract'
import type {
  ExtensionInstallation,
  ExtensionPlatformState,
} from '../src/shared/extensions/workbench'

vi.mock('../src/renderer/src/settings/sections/AgentAccessSettings', () => ({
  AgentAccessSettings: () => null,
}))

let root: Root | undefined
afterEach(async () => {
  await act(async () => {
    root?.unmount()
    await Promise.resolve()
  })
  root = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

const candidate: ExtensionInstallation = {
  source: 'owned-package',
  sourceIdentity: 'owned:entry',
  revision: 'candidate-revision',
  enabled: false,
  warnings: [],
  manifest: {
    id: 'owned.package',
    name: 'Owned package',
    version: '0.3.0',
    contract: '1.0',
    requiredCapabilities: [],
    optionalCapabilities: [],
    access: [],
    views: [],
  },
}
const enabled: ExtensionInstallation = {
  ...candidate,
  installationId: 'new-installation',
  acceptedRevision: candidate.revision,
  enabled: true,
}

async function fixture(installation = candidate) {
  let publish!: (next: ExtensionPlatformState) => void
  let finish!: (next: ExtensionPlatformState) => void
  const pending = new Promise<ExtensionPlatformState>((resolve) => {
    finish = resolve
  })
  const state = (entry: ExtensionInstallation): ExtensionPlatformState => ({
    writable: true,
    installations: [entry],
  })
  const invoke = vi.fn((channel: string) => {
    if (channel === 'extensions:enable') return pending
    if (channel === 'extensions:state') return Promise.resolve(state(installation))
    if (channel === 'agent:access')
      return Promise.resolve({
        enabled: false,
        confirmDestructive: true,
        extensions: [],
        extensionsWritable: true,
        ready: false,
        instance: 'fixture',
        confirmations: [],
      } satisfies AgentAccessState)
    return Promise.resolve([])
  })
  vi.stubGlobal('hvir', {
    invoke,
    on: (channel: string, listener: typeof publish) => {
      if (channel === 'extensions:state-changed') publish = listener
      return () => {}
    },
  })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(ExtensionsSettings))
    await Promise.resolve()
  })
  const details = host.querySelector<HTMLDetailsElement>('.extension-lifecycle')!
  const summary = details.querySelector('summary')!
  const button = (name: string) =>
    [...details.querySelectorAll('button')].find((entry) => entry.textContent === name)!
  return {
    host,
    details,
    summary,
    button,
    invoke,
    publish: async (entry: ExtensionInstallation) => {
      await act(async () => {
        publish(state(entry))
        await Promise.resolve()
      })
    },
    finish: async (entry: ExtensionInstallation) => {
      await act(async () => {
        finish(state(entry))
        await pending
      })
    },
  }
}

it('keeps visible lifecycle focus through first Enable creating its installation identity', async () => {
  const f = await fixture()
  act(() => {
    f.button('Enable').focus()
    f.button('Enable').click()
  })
  expect(document.activeElement).toBe(f.summary)
  expect(f.invoke).toHaveBeenCalledWith('extensions:enable', {
    source: candidate.source,
    revision: candidate.revision,
  })
  await f.publish(enabled)
  expect(f.host.querySelector('.extension-lifecycle')).toBe(f.details)
  expect(f.details.open).toBe(true)
  expect(document.activeElement).toBe(f.summary)
  await f.finish(enabled)
  expect(document.activeElement).toBe(f.summary)
  expect(f.button('Disable').disabled).toBe(false)
})

it.each(['error', 'removalPending'] as const)(
  'keeps lifecycle controls and their focus visible when %s clears',
  async (attention) => {
    const f = await fixture({
      ...enabled,
      ...(attention === 'error'
        ? { error: 'Owned package needs attention' }
        : { removalPending: true }),
    })
    const remove = f.button('Remove')
    remove.focus()
    await f.publish(enabled)
    expect(f.host.querySelector('.extension-lifecycle')).toBe(f.details)
    expect(f.details.open).toBe(true)
    expect(document.activeElement).toBe(remove)
    expect(remove.isConnected).toBe(true)
  },
)

it('preserves an explicit disclosure choice through later lifecycle publications', async () => {
  const f = await fixture()
  act(() => f.summary.click())
  expect(f.details.open).toBe(false)
  await f.publish(enabled)
  expect(f.details.open).toBe(false)
  act(() => f.summary.click())
  expect(f.details.open).toBe(true)
  await f.publish({
    ...enabled,
    acceptedRevision: 'next-revision',
    revision: 'next-revision',
  })
  expect(f.details.open).toBe(true)
})

it('does not steal focus after the user moves while Enable is pending', async () => {
  const f = await fixture()
  act(() => {
    f.button('Enable').focus()
    f.button('Enable').click()
  })
  const selected = f.host.querySelector<HTMLButtonElement>(
    '.extension-installation-list button',
  )!
  selected.focus()
  await f.publish(enabled)
  expect(document.activeElement).toBe(selected)
  await f.finish(enabled)
  expect(document.activeElement).toBe(selected)
})

it('does not focus a retired Settings surface when a held operation finishes', async () => {
  const f = await fixture()
  act(() => {
    f.button('Enable').focus()
    f.button('Enable').click()
  })
  act(() => root!.unmount())
  root = undefined
  const elsewhere = document.createElement('button')
  document.body.append(elsewhere)
  elsewhere.focus()
  await f.finish(enabled)
  expect(document.activeElement).toBe(elsewhere)
})
