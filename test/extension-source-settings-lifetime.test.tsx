// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SourceSettings } from '../src/renderer/src/settings/sections/SourceSettings'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { exampleManifest } from './fixtures/extension-package'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.unstubAllGlobals()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture() {
  const declaration = {
    id: 'source',
    context: 'workspace',
    mode: 'read-only',
    description: 'Selected source',
  }
  const workspace = {
    id: 'a',
    host: 'local',
    name: 'A',
    root: { hostId: 'local', path: '/a' },
  }
  const prepared = (token: string) => ({
    token,
    grant: {
      installationId: 'installation',
      declaration,
      root: workspace.root,
      workspaceId: 'a',
    },
  })
  let sequence = 0
  const prepare = vi.fn(() => Promise.resolve(prepared(`token-${++sequence}`)))
  const approve = vi.fn(() => Promise.resolve())
  const settings = vi.fn(() =>
    Promise.resolve({
      sources: [
        { source: 'source', granted: true, workspaceId: 'a', root: workspace.root },
      ],
      workspaces: [workspace, { ...workspace, id: 'b', name: 'B' }],
    }),
  )
  const invoke = vi.fn((channel: string) => {
    if (channel === 'extensions:source-settings') return settings()
    if (channel === 'extensions:source-prepare') return prepare()
    if (channel === 'extensions:source-approve') return approve()
    if (channel === 'extensions:source-cancel-prepared') return Promise.resolve()
    throw new Error(`Unexpected ${channel}`)
  })
  vi.stubGlobal('hvir', { invoke })
  const host = document.createElement('div'),
    root = createRoot(host)
  document.body.append(host)
  let mounted = true
  const unmount = () => {
    if (mounted) act(() => root.unmount())
    mounted = false
    host.remove()
  }
  cleanups.push(unmount)
  const render = async (
    installationId = 'installation',
    description = declaration.description,
  ) => {
    await act(() =>
      Promise.resolve(
        root.render(
          createElement(SourceSettings, {
            installation: {
              source: 'reference',
              warnings: [],
              enabled: true,
              installationId,
              manifest: validateExtensionManifest(
                exampleManifest({ access: [{ ...declaration, description }] }),
              ).manifest,
            },
          }),
        ),
      ),
    )
  }
  const select = (value: string) =>
    act(() => {
      const select = host.querySelector('select')!
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  const click = async (name: string) => {
    const button = [...host.querySelectorAll('button')].find(
      (entry) => entry.textContent === name,
    )
    expect(button).toBeDefined()
    await act(() => Promise.resolve(button!.click()))
  }
  await render()
  select('a')
  return {
    host,
    invoke,
    prepare,
    approve,
    settings,
    prepared,
    render,
    select,
    click,
    unmount,
  }
}

it('retires superseded inspections, changed selections and a closed setup', async () => {
  const f = await fixture()
  for (let index = 1; index <= 5; index++) {
    await f.click('Inspect read access')
    if (index > 1)
      expect(f.invoke).toHaveBeenCalledWith('extensions:source-cancel-prepared', {
        token: `token-${index - 1}`,
      })
  }
  f.select('b')
  expect(f.invoke).toHaveBeenCalledWith('extensions:source-cancel-prepared', {
    token: 'token-5',
  })
  expect(f.host.textContent).not.toContain('Grant read-only access')
  await f.click('Inspect read access')
  f.unmount()
  expect(f.invoke).toHaveBeenCalledWith('extensions:source-cancel-prepared', {
    token: 'token-6',
  })
})

it.each(['installation', 'declaration'] as const)(
  'resets exact %s setup identity with the same declared source ID',
  async (change) => {
    const f = await fixture()
    await f.click('Inspect read access')
    await f.render()
    expect(f.host.textContent).toContain('Grant read-only access')
    expect(f.host.querySelector('select')!.value).toBe('a')
    const loading = deferred<Awaited<ReturnType<typeof f.settings>>>()
    f.settings.mockImplementationOnce(() => loading.promise)
    await f.render(
      change === 'installation' ? 'other-installation' : 'installation',
      change === 'declaration' ? 'Changed declaration' : undefined,
    )
    expect(f.invoke).toHaveBeenCalledWith('extensions:source-cancel-prepared', {
      token: 'token-1',
    })
    expect(f.host.textContent).not.toContain('Grant read-only access')
    expect(f.host.textContent).not.toContain('Granted · local: /a')
    expect(f.host.querySelector('select')!.value).toBe('')
    await act(async () => {
      loading.resolve({ sources: [], workspaces: [] })
      await loading.promise
    })
  },
)

it.each(['close', 'installation', 'declaration'] as const)(
  'retires a late prepared token after %s',
  async (change) => {
    const f = await fixture(),
      pending = deferred<ReturnType<typeof f.prepared>>()
    f.prepare.mockImplementationOnce(() => pending.promise)
    await f.click('Inspect read access')
    if (change === 'close') f.unmount()
    else
      await f.render(
        change === 'installation' ? 'other-installation' : 'installation',
        change === 'declaration' ? 'Changed declaration' : undefined,
      )
    await act(async () => {
      pending.resolve(f.prepared('late'))
      await pending.promise
    })
    expect(f.invoke).toHaveBeenCalledWith('extensions:source-cancel-prepared', {
      token: 'late',
    })
    expect(f.host.textContent).not.toContain('Grant read-only access')
    expect(f.approve).not.toHaveBeenCalled()
  },
)

it('cancels an approval still in progress when its setup closes', async () => {
  const f = await fixture(),
    pending = deferred<void>()
  await f.click('Inspect read access')
  f.approve.mockImplementationOnce(() => pending.promise)
  await f.click('Grant read-only access')
  f.unmount()
  expect(f.invoke).toHaveBeenCalledWith('extensions:source-cancel-prepared', {
    token: 'token-1',
  })
  await act(async () => {
    pending.resolve()
    await pending.promise
  })
})
