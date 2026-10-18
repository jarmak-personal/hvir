// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionTopRail } from '../src/renderer/src/extensions/ExtensionContributions'
import { ExtensionActions } from '../src/renderer/src/extensions/ExtensionActions'
import {
  ExtensionContributionContext,
  type Contributions,
} from '../src/renderer/src/extensions/extension-contribution-context'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { exampleManifest } from './fixtures/extension-package'

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
function fixture(nullAction = false) {
  const manifest = validateExtensionManifest(
    exampleManifest({
      requiredCapabilities: ['actions.invoke'],
      views: [
        {
          id: 'workspace-task',
          title: 'Project tasks',
          entry: 'index.html',
          placement: 'workspace',
          representations: ['view'],
        },
        {
          id: 'application-task',
          title: 'Library tasks',
          entry: 'index.html',
          placement: 'application',
          representations: ['view'],
        },
      ],
      actions: [
        {
          agents: false,
          effects: { delete: false, replace: false },
          id: 'project',
          title: 'Project change',
          view: 'workspace-task',
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
        {
          agents: false,
          effects: { delete: false, replace: false },
          id: 'library',
          title: 'Library change',
          view: 'application-task',
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
        ...(nullAction
          ? [
              {
                agents: false,
                effects: { delete: false, replace: false },
                id: 'observe',
                title: 'Observe',
                view: 'application-task',
                inputSchema: { type: 'null' },
              },
            ]
          : []),
      ],
    }),
  ).manifest
  const workspace = {
      id: 'worktree',
      name: 'Feature',
      host: 'local',
      root: { hostId: 'local', path: '/repo/feature' },
    },
    session = { id: 'live-spawn', title: 'Codex', workspace },
    open = vi.fn().mockResolvedValue({}),
    invoke = vi.fn().mockResolvedValue({})
  const model = {
    state: [{ installationId: 'one', extensionName: 'Reference', manifest, values: [] }],
    sessions: [session],
    workspaces: [workspace],
    projects: [
      {
        id: 'registered',
        displayName: 'Repository',
        registeredRoot: workspace.root,
        workspaces: [{ ...workspace, main: true }],
      },
    ],
    workspaceId: workspace.id,
    open,
  } as unknown as Contributions
  vi.stubGlobal('hvir', { invoke })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      createElement(
        ExtensionContributionContext.Provider,
        { value: model },
        createElement(ExtensionActions, { installationId: 'one' }),
      ),
    ),
  )
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((element) => element.textContent === label)!
  const select = host.querySelector<HTMLSelectElement>(
    '[aria-label="Extension action context"]',
  )!
  const project = host.querySelector<HTMLSelectElement>(
    '[aria-label="Extension project destination"]',
  )!
  return { open, invoke, button, select, project, host }
}
it('routes parameterized tasks to declared views with a visible exact workspace or session destination', async () => {
  const f = fixture()
  expect(f.project.selectedOptions[0]?.textContent).toBe('Repository')
  expect(f.host.querySelector('.extension-workspace-location')?.textContent).toBe(
    'local: /repo/feature',
  )
  expect(f.button('Run Project change')).toBeUndefined()
  await act(async () => {
    f.button('Open Project tasks').click()
    await Promise.resolve()
  })
  expect(f.open).toHaveBeenLastCalledWith('one', 'workspace-task', {
    surface: 'viewer',
    workspaceId: 'worktree',
  })
  act(() => {
    f.select.value = 'session:live-spawn'
    f.select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {
    f.button('Open Project tasks').click()
    await Promise.resolve()
  })
  expect(f.open).toHaveBeenLastCalledWith('one', 'workspace-task', {
    surface: 'viewer',
    workspaceId: 'worktree',
    sessionId: 'live-spawn',
  })
  await act(async () => {
    f.button('Open Library tasks').click()
    await Promise.resolve()
  })
  expect(f.open).toHaveBeenLastCalledWith('one', 'application-task', {
    surface: 'viewer',
  })
  act(() => {
    f.project.value = ''
    f.project.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(f.button('Open Project tasks').disabled).toBe(true)
  expect(f.invoke).not.toHaveBeenCalled()
})
it('keeps null-valid actions directly runnable in the chosen context', async () => {
  const f = fixture(true)
  await act(async () => {
    f.button('Run Observe').click()
    await Promise.resolve()
  })
  expect(f.invoke).toHaveBeenCalledWith('extensions:action', {
    installationId: 'one',
    action: 'observe',
    input: null,
    context: { surface: 'viewer', workspaceId: 'worktree' },
  })
})

it('preserves Settings context focus and the submitted action context while another destination is chosen', async () => {
  const f = fixture(true)
  let settle!: () => void
  f.invoke.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve
      }),
  )
  act(() => {
    f.select.value = 'session:live-spawn'
    f.select.dispatchEvent(new Event('change', { bubbles: true }))
    f.select.focus()
    f.button('Run Observe').click()
  })
  expect(f.select.disabled).toBe(false)
  expect(f.project.disabled).toBe(false)
  expect(document.activeElement).toBe(f.select)
  expect(f.button('Run Observe').disabled).toBe(true)
  act(() => {
    f.project.value = ''
    f.project.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(f.invoke).toHaveBeenCalledExactlyOnceWith('extensions:action', {
    installationId: 'one',
    action: 'observe',
    input: null,
    context: { surface: 'viewer', workspaceId: 'worktree', sessionId: 'live-spawn' },
  })
  await act(async () => {
    settle()
    await Promise.resolve()
  })
  expect(f.project.value).toBe('')
  expect(f.button('Run Observe').disabled).toBe(false)
})

it.each(['chosen', undefined])(
  'returns to the existing ordinary application destination (%s) without reopening its context after background navigation',
  (workspaceId) => {
    const selected = {
      id: 'kept',
      installationId: 'one',
      contributionId: 'library',
      canChooseWorkspace: true,
      context: {
        surface: 'top',
        ...(workspaceId ? { workspace: { id: workspaceId } } : {}),
      },
    }
    const open = vi.fn(),
      selectTop = vi.fn()
    const model = {
      state: [
        {
          installationId: 'one',
          manifest: { views: [{ id: 'library', title: 'Library', navigation: 'top' }] },
        },
      ],
      views: [{ ...selected, id: 'agent', canChooseWorkspace: false }, selected],
      workspaceId: 'unrelated-current-workspace',
      open,
      selectTop,
    } as unknown as Contributions
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() =>
      root!.render(
        createElement(
          ExtensionContributionContext.Provider,
          { value: model },
          createElement(ExtensionTopRail),
        ),
      ),
    )
    act(() => host.querySelector('button')!.click())
    expect(selectTop).toHaveBeenCalledWith(selected)
    expect(open).not.toHaveBeenCalled()
  },
)
