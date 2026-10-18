// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { asHostId, hostPath } from '../src/shared/host-path'
import type { RegisteredProjectState } from '../src/shared/workspace-types'
import type { ExtensionWorkspaceContext } from '../src/shared/extensions/contract'
import type { ExtensionView } from '../src/shared/extensions/workbench'
import { ExtensionProjectPicker } from '../src/renderer/src/extensions/ExtensionProjectPicker'
import { ExtensionWorkspaceTarget } from '../src/renderer/src/extensions/ExtensionWorkspaceTarget'
import {
  ExtensionContributionContext,
  type Contributions,
} from '../src/renderer/src/extensions/extension-contribution-context'

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
function project(id: string, count = 1, hostId = 'local'): RegisteredProjectState {
  const workspaces = Array.from({ length: count }, (_, index) => ({
    id: `${id}-${index}`,
    root: hostPath(asHostId(hostId), `/registered/${id}/checkout-${index}`),
    name: index ? `feature-${index}` : 'main',
    main: index === 0,
    closed: false,
    missing: false,
    repository: true,
    changedFiles: 0,
  }))
  return {
    id,
    displayName: id,
    registeredRoot: hostPath(asHostId(hostId), `/registered/${id}`),
    connectionState: 'connected',
    watchTier: 'native',
    activeWorkspaceId: workspaces.at(-1)!.id,
    workspaces,
  }
}
function admitted(
  projects: readonly RegisteredProjectState[],
): ExtensionWorkspaceContext[] {
  return projects.flatMap(({ workspaces }) =>
    workspaces.map(({ id, name, root }) => ({ id, name, root, host: root.hostId })),
  )
}
function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const select = (label: string) =>
    host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
  const choose = (label: string, value: string) =>
    act(() => {
      const control = select(label)
      control.value = value
      control.dispatchEvent(new Event('change', { bubbles: true }))
    })
  return { host, select, choose }
}

it('keeps compact project/worktree choices explicit and describes the exact selected host path', () => {
  const a = project('one', 60),
    b = project('two', 40),
    remote = project('remote', 2, 'build-host')
  const projects = [a, { ...b, displayName: 'one' }, remote]
  const workspaces = admitted(projects).filter(({ id }) => id !== 'one-59')
  const onChange = vi.fn(),
    f = mount()
  const render = (workspace?: ExtensionWorkspaceContext) =>
    act(() =>
      root!.render(
        createElement(ExtensionProjectPicker, {
          projects,
          workspaces,
          workspace,
          compact: true,
          onChange,
        }),
      ),
    )
  render(workspaces[12])
  const projectOptions = [...f.select('Extension project destination').options]
  expect(projectOptions.map(({ value }) => value)).toEqual(['', 'one', 'two', 'remote'])
  expect(projectOptions[1]!.textContent).toContain('local: /registered/one')
  expect(projectOptions[2]!.textContent).toContain('local: /registered/two')
  expect(projectOptions[3]!.textContent).toBe('remote · build-host')
  const tree = f.select('Extension worktree destination')
  for (const control of [f.select('Extension project destination'), tree]) {
    expect(control.title).toBe('local: /registered/one/checkout-12')
    expect(
      document.getElementById(control.getAttribute('aria-describedby')!)?.textContent,
    ).toBe('local: /registered/one/checkout-12')
  }
  expect(tree.options).toHaveLength(59)
  expect(tree.selectedOptions[0]?.textContent).toBe('feature-12')
  expect(f.host.querySelector('.extension-workspace-location')?.textContent).toBe(
    'local: /registered/one/checkout-12',
  )
  f.choose('Extension worktree destination', 'one-25')
  expect(onChange).toHaveBeenLastCalledWith('one-25')
  f.choose('Extension project destination', 'remote')
  expect(onChange).toHaveBeenLastCalledWith('remote-0')
  render(workspaces.find(({ id }) => id === 'remote-0'))
  expect(
    [...f.select('Extension worktree destination').options].map(({ value }) => value),
  ).toEqual(['remote-0', 'remote-1'])
})

it('keeps a one-workspace directory compact and makes duplicate names and unavailable destinations explicit', () => {
  const plain = project('notes'),
    duplicate = project('long-project-name-with-spaces', 2)
  const projects = [
    plain,
    {
      ...duplicate,
      workspaces: duplicate.workspaces.map((entry) => ({ ...entry, name: 'same-name' })),
    },
  ]
  const workspaces = admitted(projects),
    f = mount(),
    onChange = vi.fn()
  const render = (workspace?: ExtensionWorkspaceContext, choices = workspaces) =>
    act(() =>
      root!.render(
        createElement(ExtensionProjectPicker, {
          projects,
          workspaces: choices,
          workspace,
          onChange,
        }),
      ),
    )
  render(workspaces[0])
  expect(f.select('Extension worktree destination')).toBeNull()
  render(workspaces[1])
  const labels = [...f.select('Extension worktree destination').options].map(
    ({ textContent }) => textContent,
  )
  expect(labels).toEqual([
    'same-name · /registered/long-project-name-with-spaces/checkout-0',
    'same-name · /registered/long-project-name-with-spaces/checkout-1',
  ])
  render(workspaces[1], [])
  expect(f.select('Extension project destination').selectedOptions[0]?.disabled).toBe(
    true,
  )
  expect(
    f.select('Extension worktree destination').selectedOptions[0]?.textContent,
  ).toContain('unavailable')
  expect(onChange).not.toHaveBeenCalled()
})

it('keeps explicit selection and no-destination stable across background navigation and rejects failed target changes without retargeting', async () => {
  const projects = [project('one', 2), project('two', 2)],
    workspaces = admitted(projects)
  const invoke = vi.fn<(channel: string, input: unknown) => Promise<unknown>>()
  let reject!: (reason: Error) => void
  invoke.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      }),
  )
  vi.stubGlobal('hvir', { invoke })
  const f = mount()
  const view = {
    id: 'library',
    installationId: 'skillager',
    contributionId: 'library',
    extensionName: 'Skillager',
    title: 'Library',
    partition: 'own',
    url: 'hvir-extension://library',
    canChooseWorkspace: true,
    context: { surface: 'top', visible: true, workspace: workspaces[1] },
  } satisfies ExtensionView
  const render = (selected: ExtensionView, current = 'one-0') => {
    const model = {
      projects,
      workspaces,
      workspaceId: current,
      state: [
        {
          installationId: 'skillager',
          manifest: { views: [{ id: 'library', placement: 'application' }] },
        },
      ],
    } as unknown as Contributions
    act(() =>
      root!.render(
        createElement(
          ExtensionContributionContext.Provider,
          { value: model },
          createElement(ExtensionWorkspaceTarget, { view: selected }),
        ),
      ),
    )
  }
  render(view)
  render(view, 'two-1')
  expect(f.select('Extension project destination').value).toBe('one')
  expect(f.select('Extension worktree destination').value).toBe('one-1')
  expect(invoke).not.toHaveBeenCalled()
  f.choose('Extension project destination', 'two')
  expect(invoke).toHaveBeenLastCalledWith('extensions:target-view', {
    viewId: 'library',
    workspaceId: 'two-0',
  })
  expect(f.select('Extension project destination').disabled).toBe(true)
  await act(async () => {
    reject(new Error('Current operation is still submitted'))
    await Promise.resolve()
  })
  expect(f.select('Extension project destination').value).toBe('one')
  expect(f.host.querySelector('[role=status]')?.textContent).toContain('still submitted')
  invoke.mockResolvedValue({})
  await act(async () => {
    f.choose('Extension project destination', '')
    await Promise.resolve()
  })
  expect(invoke).toHaveBeenLastCalledWith('extensions:target-view', {
    viewId: 'library',
    workspaceId: undefined,
  })
  const independent = { ...view, context: { surface: 'top' as const, visible: true } }
  render(independent, 'two-0')
  expect(f.select('Extension project destination').value).toBe('')
  expect(f.select('Extension worktree destination')).toBeNull()
  expect(f.host.querySelector('.extension-workspace-location')?.textContent).toContain(
    'No project selected',
  )
})
