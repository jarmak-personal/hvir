// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SourceSettings } from '../src/renderer/src/settings/sections/SourceSettings'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { exampleManifest } from './fixtures/extension-package'
afterEach(() => vi.unstubAllGlobals())
it('shows trusted registered host/root choices and sends only the exact selected registration ID', async () => {
  const declaration = {
    id: 'project',
    context: 'workspace',
    mode: 'read-only',
    description: 'Project instructions',
  }
  const remote = {
    id: 'ssh-project',
    host: 'ssh',
    name: 'Remote',
    root: { hostId: 'ssh', path: '/same/project' },
  }
  const local = {
    id: 'local-project',
    host: 'local',
    name: 'Local',
    root: { hostId: 'local', path: '/same/project' },
  }
  const invoke = vi.fn(async (channel: string, input: unknown) => {
    await Promise.resolve()
    if (channel === 'extensions:source-settings')
      return { sources: [], workspaces: [local, remote] }
    if (channel === 'extensions:source-prepare')
      return {
        token: 'trusted',
        grant: {
          installationId: 'installation',
          declaration,
          root: remote.root,
          workspaceId: remote.id,
        },
      }
    expect(input).toEqual({ token: 'trusted' })
    return undefined
  })
  vi.stubGlobal('hvir', { invoke })
  const host = document.createElement('div'),
    root = createRoot(host)
  document.body.append(host)
  try {
    await act(() =>
      Promise.resolve(
        root.render(
          createElement(SourceSettings, {
            installation: {
              source: 'reference',
              warnings: [],
              enabled: true,
              installationId: 'installation',
              manifest: validateExtensionManifest(
                exampleManifest({ access: [declaration] }),
              ).manifest,
            },
          }),
        ),
      ),
    )
    const select = host.querySelector('select')!
    expect(select.textContent).toContain('local: /same/project')
    expect(select.textContent).toContain('ssh: /same/project')
    act(() => {
      select.value = remote.id
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(() =>
      Promise.resolve(
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === 'Inspect read access')!
          .click(),
      ),
    )
    expect(invoke).toHaveBeenCalledWith('extensions:source-prepare', {
      installationId: 'installation',
      source: 'project',
      workspaceId: 'ssh-project',
    })
    expect(host.textContent).toContain('ssh: /same/project')
    expect(host.textContent).not.toContain('each view')
    await act(() =>
      Promise.resolve(
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === 'Grant read-only access')!
          .click(),
      ),
    )
    expect(invoke).toHaveBeenCalledWith('extensions:source-approve', { token: 'trusted' })
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
