// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HarnessProfilesSettings } from '../src/renderer/src/settings/HarnessProfilesSettings'
import { localPath } from '../src/shared'

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.unstubAllGlobals()
})

describe('HarnessProfilesSettings', () => {
  it('paints the shell while a requested add flow waits for provider data', () => {
    let resolveCatalog: (value: readonly never[]) => void = () => undefined
    const catalog = new Promise<readonly never[]>((resolve) => {
      resolveCatalog = resolve
    })
    vi.stubGlobal('hvir', {
      invoke: vi.fn((channel: string) =>
        channel === 'harness:catalog' ? catalog : Promise.resolve([]),
      ),
    })
    renderHarnesses()

    expect(document.body.textContent).toContain('Loading harness providers…')
    expect(document.querySelector('.add-harness-dialog')).toBeFalsy()
    expect(resolveCatalog).toBeTypeOf('function')
  })

  it('opens the deferred add flow after an empty catalog has settled', async () => {
    vi.stubGlobal('hvir', {
      invoke: vi.fn(() => Promise.resolve([])),
    })
    renderHarnesses()
    await settleEffects()

    expect(document.querySelector('.add-harness-dialog')).toBeTruthy()
    expect(document.body.textContent).toContain(
      'No bundled harnesses were detected on this host.',
    )
  })

  it('shows an explicit load failure instead of opening the add flow', async () => {
    vi.stubGlobal('hvir', {
      invoke: vi.fn((channel: string) =>
        channel === 'harness:catalog'
          ? Promise.reject(new Error('catalog unavailable'))
          : Promise.resolve([]),
      ),
    })
    renderHarnesses()
    await settleEffects()

    expect(document.body.textContent).toContain('Harness profiles could not be loaded.')
    expect(document.body.textContent).toContain('catalog unavailable')
    expect(document.querySelector('.add-harness-dialog')).toBeFalsy()
  })
})

function renderHarnesses(): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root?.render(
      createElement(HarnessProfilesSettings, {
        workspaceRoot: localPath('/tmp/hvir'),
        projectRoot: localPath('/tmp/hvir'),
        initialAddOpen: true,
      }),
    )
  })
}

async function settleEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
