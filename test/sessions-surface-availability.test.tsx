// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionsOverview } from '../src/renderer/src/sessions/SessionsOverview'
import type { SessionsTerminalSurfacePort } from '../src/renderer/src/sessions/sessions-terminal-surface'
import {
  SESSIONS_PROJECTION_VERSION,
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsProjectHandle,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  sessionsWorkspaceQualifier,
  type SessionsObservationSnapshot,
} from '../src/shared'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  installApi()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Sessions surface availability', () => {
  it('tracks readiness and lease conflicts without a projection change', async () => {
    const surface = observableSurface()
    await act(async () => {
      root.render(
        <SessionsOverview
          observation={{
            snapshot: rendererSessions,
            subscribe: () => () => undefined,
          }}
          surface={surface.value}
          onReturn={vi.fn()}
          onOpened={vi.fn()}
          onFocusOpened={vi.fn(() => Promise.resolve(true))}
          onOpenFailed={vi.fn()}
        />,
      )
      await settle()
    })

    expect(host.textContent).not.toContain('Interact')

    await act(async () => {
      surface.setAvailable(true)
      await settle()
    })

    expect(host.textContent).toContain('Interact')

    await act(async () => {
      surface.setAvailable(false, 'lease-conflict')
      await settle()
    })

    expect(host.textContent).not.toContain('Interact')

    await act(async () => {
      surface.setAvailable(true)
      await settle()
    })

    expect(host.textContent).toContain('Interact')
  })
})

function observableSurface() {
  let available = false
  let unavailableReason: 'runtime-not-ready' | 'lease-conflict' =
    'runtime-not-ready'
  let revision = 0
  const listeners = new Set<() => void>()
  const value: SessionsTerminalSurfacePort = {
    availabilityRevision: () => revision,
    subscribeAvailability: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    availability: () =>
      available
        ? { outcome: 'available' }
        : { outcome: 'unavailable', reason: unavailableReason },
    acquire: () => ({ outcome: 'unavailable', reason: 'runtime-not-ready' }),
  }
  return {
    value,
    setAvailable(
      next: boolean,
      reason: 'runtime-not-ready' | 'lease-conflict' = 'runtime-not-ready',
    ): void {
      available = next
      unavailableReason = reason
      revision += 1
      for (const listener of listeners) listener()
    },
  }
}

function installApi(): void {
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke: vi.fn((channel: string, request: { readonly demandGeneration: number }) => {
        if (channel === 'sessions:observe' || channel === 'sessions:snapshot') {
          return Promise.resolve(mainSnapshot(request.demandGeneration))
        }
        if (channel === 'sessions:release') return Promise.resolve()
        return Promise.reject(new Error(`Unexpected channel ${channel}`))
      }),
      on: vi.fn(() => () => undefined),
    },
  })
}

function mainSnapshot(demandGeneration: number): SessionsObservationSnapshot {
  const qualifier = sessionsWorkspaceQualifier(1, 0, 0)
  return {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration,
    revision: 1,
    providers: [
      {
        id: asHarnessProviderId('plain-shell'),
        displayName: 'Shell',
        telemetrySupported: false,
        usageSupported: false,
        sessionKind: 'shell',
      },
    ],
    workspaces: [
      {
        projectId: asSessionsProjectHandle('project'),
        projectName: 'Project',
        workspaceId: asSessionsWorkspaceHandle('workspace'),
        qualifier,
        workspaceName: 'main',
        main: true,
        closed: false,
        missing: false,
        host: {
          id: 'local',
          label: 'Local',
          kind: 'local',
          connectionState: 'connected',
        },
      },
    ],
    sessions: [
      {
        handle: asSessionsTerminalHandle('terminal'),
        workspaceId: asSessionsWorkspaceHandle('workspace'),
        providerId: asHarnessProviderId('plain-shell'),
        profile: {
          status: 'available',
          value: { id: asHarnessProfileId('plain-shell-default') },
        },
        title: 'Shell',
        lifecycle: 'live',
        livePty: {
          handle: asSessionsPtyHandle('instance'),
          rendererOwnerId: 1,
          rendererGeneration: 1,
        },
        telemetry: {
          model: { status: 'unsupported' },
          context: { status: 'unsupported' },
          turn: { status: 'unsupported' },
          freshness: { status: 'unsupported' },
        },
      },
    ],
  }
}

function rendererSessions() {
  return [
    {
      handle: asSessionsTerminalHandle('terminal'),
      workspaceQualifier: sessionsWorkspaceQualifier(1, 0, 0),
      providerId: asHarnessProviderId('plain-shell'),
      profileId: asHarnessProfileId('plain-shell-default'),
      title: 'Shell',
      dormant: false,
      resumeOnStart: false,
      exited: false,
      recoveryUnavailable: false,
    },
  ]
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}
