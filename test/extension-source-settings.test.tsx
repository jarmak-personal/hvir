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

it('lists real retained workspace bindings and revokes only the chosen host/root', async () => {
  const declaration = {
    id: 'project',
    context: 'workspace',
    mode: 'read-only',
    description: 'Project instructions',
  }
  const a = {
    source: 'project',
    granted: true,
    workspaceId: 'a',
    root: { hostId: 'local', path: '/a' },
  }
  const b = {
    source: 'project',
    granted: false,
    workspaceId: 'b',
    root: { hostId: 'ssh', path: '/b' },
  }
  let retained = [a, b]
  const invoke = vi.fn((channel: string, input: unknown) => {
    if (channel === 'extensions:source-settings')
      return Promise.resolve({ sources: retained, workspaces: [] })
    expect(channel).toBe('extensions:source-revoke')
    expect(input).toEqual({
      installationId: 'installation',
      source: 'project',
      binding: { workspaceId: 'b', root: b.root },
    })
    retained = [a]
    return Promise.resolve(undefined)
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
    expect(host.textContent).toContain('local: /a')
    expect(host.textContent).toContain('Saved · unavailable · ssh: /b')
    const buttons = [...host.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Revoke read access',
    )
    expect(buttons).toHaveLength(2)
    await act(() => Promise.resolve(buttons[1]!.click()))
    expect(host.textContent).toContain('local: /a')
    expect(host.textContent).not.toContain('ssh: /b')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
