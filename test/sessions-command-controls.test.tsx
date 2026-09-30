// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import { harnessProviderCatalog } from '../src/main/harness/harness-provider'
import { SessionsOverview } from '../src/renderer/src/sessions/SessionsOverview'
import { SessionsProjectionCoordinator } from '../src/renderer/src/sessions/sessions-projection-coordinator'
import type {
  SessionsCommandPort,
  SessionsLaunchChoices,
} from '../src/renderer/src/sessions/sessions-command-port'
import type { SessionsTerminalSurfaceLease } from '../src/renderer/src/sessions/sessions-terminal-surface'
import {
  asSessionsProjectHandle,
  asSessionsWorkspaceHandle,
  asSessionsTerminalHandle,
  asSessionsPtyHandle,
  asSessionsWorkspaceRuntimeId,
  asHarnessProviderId,
  sessionsWorkspaceQualifier,
  localPath,
  type SessionsObservationSnapshot,
  type SessionsOpenRequest,
} from '../src/shared'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function renderControls(empty = false) {
  const profile = builtInProfiles()[0]!
  const workspace = {
    projectId: asSessionsProjectHandle('private-project'),
    projectName: 'Project',
    workspaceId: asSessionsWorkspaceHandle('private-root'),
    qualifier: sessionsWorkspaceQualifier(1, 0, 0),
    workspaceName: 'root',
    main: true,
    missing: false,
    closed: false,
    host: {
      id: 'local',
      label: 'Local',
      kind: 'local' as const,
      connectionState: 'connected' as const,
    },
  }
  const livePty = {
    handle: asSessionsPtyHandle('private-instance'),
    rendererOwnerId: 1,
    rendererGeneration: 1,
  }
  const unsupported = { status: 'unsupported' as const }
  let observation: SessionsObservationSnapshot = {
    version: 1,
    revision: 1,
    demandGeneration: 1,
    providers: [
      {
        id: asHarnessProviderId('plain-shell'),
        displayName: 'Shell',
        sessionKind: 'shell',
        telemetrySupported: false,
        usageSupported: false,
      },
    ],
    workspaces: [workspace],
    sessions: empty
      ? []
      : [
          {
            handle: asSessionsTerminalHandle('private-terminal'),
            workspaceId: workspace.workspaceId,
            providerId: asHarnessProviderId('plain-shell'),
            profile: unsupported,
            title: 'Shell session',
            lifecycle: 'live',
            livePty,
            telemetry: {
              model: unsupported,
              context: unsupported,
              turn: unsupported,
              freshness: unsupported,
            },
          },
        ],
  }
  let changed:
    ((change: { demandGeneration: number; revision: number }) => void) | undefined
  const projection = new SessionsProjectionCoordinator(
    {
      observe: (generation) =>
        Promise.resolve({ ...observation, demandGeneration: generation }),
      snapshot: (generation) =>
        Promise.resolve({ ...observation, demandGeneration: generation }),
      release: () => Promise.resolve(),
      subscribe: (listener) => {
        changed = listener
        return () => {
          changed = undefined
        }
      },
    },
    { snapshot: () => [], subscribe: () => () => undefined },
  )
  const start = vi.fn(() => Promise.resolve(asSessionsTerminalHandle('private-terminal')))
  const choices: SessionsLaunchChoices = {
    profiles: [profile],
    providers: harnessProviderCatalog(),
    probes: [],
    start,
    refresh: () => Promise.resolve(choices),
  }
  const launchChoices = vi.fn(() => Promise.resolve(choices))
  const move = vi.fn(() => Promise.resolve())
  const commands: SessionsCommandPort = {
    launchChoices,
    moveChoices: () => [{ id: 'target', name: 'Feature workspace' }],
    planMove: () =>
      Promise.resolve({
        terminalId: 'private-terminal',
        terminalTitle: 'Shell session',
        sourceProjectId: 'project',
        sourceWorkspaceId: 'root',
        sourceWorkspaceName: 'root',
        sourceRoot: localPath('/repo'),
        targetWorkspaceId: 'target',
        targetWorkspaceName: 'Feature workspace',
        targetRoot: localPath('/repo-feature'),
        webPaneIds: ['web-pane'],
      }),
    move,
  }
  const released = vi.fn()
  const lease: SessionsTerminalSurfaceLease = {
    attach: () => true,
    detach: () => undefined,
    renew: () => true,
    focus: () => true,
    setVisible: () => true,
    subscribe: () => () => undefined,
    release: released,
  }
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke: (_channel: string, request: SessionsOpenRequest) =>
        Promise.resolve({
          outcome: 'resolved',
          ...request,
          workspaceRuntimeId: asSessionsWorkspaceRuntimeId('runtime-root'),
        }),
      on: () => () => undefined,
    },
  })
  const onOpened = vi.fn()
  await act(async () => {
    root.render(
      <SessionsOverview
        projection={projection}
        commands={commands}
        surface={{ acquire: () => ({ outcome: 'acquired', lease }) }}
        onOpened={onOpened}
        onFocusOpened={() => Promise.resolve(true)}
        onOpenFailed={vi.fn()}
      />,
    )
    await settle()
  })
  const update = async (next: SessionsObservationSnapshot) => {
    observation = next
    await act(async () => {
      changed?.({
        demandGeneration: projection.snapshot().demandGeneration,
        revision: next.revision,
      })
      await settle()
    })
  }
  return {
    profile,
    start,
    launchChoices,
    move,
    released,
    onOpened,
    observation: () => observation,
    update,
  }
}

function button(label: string, container: ParentNode = host): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

it('offers project launch controls with no sessions and starts no process on cancellation', async () => {
  const f = await renderControls(true)
  expect(host.querySelectorAll('.sessions-project-header')).toHaveLength(1)
  expect(host.querySelectorAll('.sessions-worktree-heading')).toHaveLength(0)
  expect(host.textContent).toContain('No hvir sessions')
  expect(f.launchChoices).not.toHaveBeenCalled()
  await act(async () => {
    button('New session').click()
    await settle()
  })
  expect(button(f.profile.displayName).disabled).toBe(false)
  act(() => button('Cancel').click())
  expect(f.start).not.toHaveBeenCalled()
  expect(host.querySelector('.sessions-launch-dialog')).toBeNull()
})

it('starts exactly one chosen profile, remains in Sessions, and opens its exact Interact surface', async () => {
  const f = await renderControls()
  await act(async () => {
    button('New session').click()
    await settle()
  })
  await act(async () => {
    button(f.profile.displayName).click()
    button(f.profile.displayName).click()
    await settle()
  })
  expect(f.start).toHaveBeenCalledOnce()
  expect(host.querySelector('.sessions-terminal-detail h1')?.textContent).toBe(
    'Shell session',
  )
  expect(f.onOpened).not.toHaveBeenCalled()
  expect(f.released).not.toHaveBeenCalled()
  act(() => button('Close').click())
  expect(f.released).toHaveBeenCalledOnce()
  expect(host.querySelector('main')?.getAttribute('aria-label')).toBe('Sessions')
})

it('confirms workspace changes with launch-directory and web-pane disclosure and cancels without moving', async () => {
  const f = await renderControls()
  await act(async () => {
    button('Interact').click()
    await settle()
  })
  act(() => button('Change workspace').click())
  await act(async () => {
    button('Feature workspace').click()
    await settle()
  })
  const dialog = host.querySelector('.terminal-move-dialog')!
  expect(dialog.textContent).toContain('Its original launch directory does not change.')
  expect(dialog.textContent).toContain('1 workspace-authorized web pane will close.')
  act(() => button('Cancel', dialog).click())
  expect(f.move).not.toHaveBeenCalled()
  expect(host.querySelector('.sessions-terminal-detail')).not.toBeNull()
  act(() => button('Change workspace').click())
  await act(async () => {
    button('Feature workspace').click()
    await settle()
  })
  await act(async () => {
    button('Change workspace', host.querySelector('.terminal-move-dialog')!).click()
    await settle()
  })
  expect(f.move).toHaveBeenCalledOnce()
  expect(f.onOpened).not.toHaveBeenCalled()
})

it('revokes an outstanding launcher when the Sessions surface departs', async () => {
  const f = await renderControls(true)
  let finish!: (choices: SessionsLaunchChoices) => void
  f.launchChoices.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await act(async () => {
    button('New session').click()
    await settle()
  })
  const request = f.launchChoices.mock.calls[0] as unknown as [
    unknown,
    unknown,
    AbortSignal,
  ]
  act(() => root.render(null))
  expect(request[2].aborted).toBe(true)
  await act(async () => {
    finish({
      profiles: [f.profile],
      providers: harnessProviderCatalog(),
      probes: [],
      refresh: () => Promise.reject(new Error('Unused refresh')),
      start: f.start,
    })
    await settle()
  })
  expect(f.start).not.toHaveBeenCalled()
})

it('keeps empty-filter feedback and project launch controls together', async () => {
  await renderControls()
  act(() => button('Working').click())
  expect(host.textContent).toContain('No sessions match')
  expect(button('New session')).toBeDefined()
  act(() => button('Reset filters').click())
  expect(host.querySelectorAll('.session-card')).toHaveLength(1)
})
