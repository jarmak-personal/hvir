// @vitest-environment happy-dom
import { readExtensionPackageManifest } from './fixtures/extension-package-files'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionViewLauncher } from '../src/renderer/src/settings/sections/ExtensionViewLauncher'
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
function fixture(path: string) {
  const manifest = readExtensionPackageManifest(path)
  const invoke = vi.fn().mockResolvedValue({})
  vi.stubGlobal('hvir', { invoke })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      createElement(ExtensionViewLauncher, {
        installation: {
          installationId: 'installed',
          manifest,
          enabled: true,
          source: 'fixture',
          warnings: [],
        },
        disabled: false,
        onRun: async (work) => {
          await work()
        },
      }),
    ),
  )
  return { host, invoke }
}
it.each([
  [
    'packages/extension-reference/hvir-extension.json',
    'reference',
    'Extension reference',
  ],
  ['packages/extension-authoring/clock/hvir-extension.json', 'clock', 'Clock'],
])(
  'keeps a compact explicit manual route without declaring automatic landing: %s',
  async (manifest, id, title) => {
    const f = fixture(manifest)
    expect(f.invoke).not.toHaveBeenCalled()
    const button = f.host.querySelector('button')!
    expect(button.textContent).toBe(`Open ${title}`)
    expect(f.host.querySelectorAll('button')).toHaveLength(1)
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    expect(f.invoke).toHaveBeenCalledWith('extensions:open-view', {
      installationId: 'installed',
      contributionId: id,
    })
  },
)
it('preserves secondary manual views without duplicating parameterized task routes', async () => {
  const f = fixture('packages/skillager-extension/hvir-extension.json')
  const choices = f.host.querySelector<HTMLSelectElement>('select')!
  expect([...choices.options].map((entry) => entry.value)).toEqual(['library', 'detail'])
  expect(f.host.querySelector('button')?.textContent).toBe('Open Skillager library')
  act(() => {
    choices.value = 'detail'
    choices.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {
    f.host.querySelector('button')!.click()
    await Promise.resolve()
  })
  expect(f.invoke).toHaveBeenCalledWith('extensions:open-view', {
    installationId: 'installed',
    contributionId: 'detail',
  })
})
