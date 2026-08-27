// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionsOverview } from '../src/renderer/src/sessions/SessionsOverview'
import {
  SESSIONS_PROJECTION_VERSION,
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsPtyHandle,
  asSessionsProjectHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  sessionsWorkspaceQualifier,
  type SessionsObservationSnapshot,
} from '../src/shared'

const privateHandle = asSessionsTerminalHandle('terminal-private-agent')
const privatePath = '/private/repo'
const providerId = asHarnessProviderId('codex')
const profileId = asHarnessProfileId('codex-default')
const workspaceQualifier = sessionsWorkspaceQualifier(11, 0, 0)
const livePty = {
  handle: asSessionsPtyHandle('live-instance-agent'),
  rendererOwnerId: 4,
  rendererGeneration: 6,
}

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

describe('Sessions title privacy', () => {
  it('keeps an embedded live handle out of headings, accessible labels, and DOM', async () => {
    await act(async () => {
      root.render(
        <SessionsOverview
          observation={{
            snapshot: () => [
              {
                handle: privateHandle,
                workspaceQualifier,
                providerId,
                profileId,
                title: `Working in ${privatePath} for ${privateHandle}`,
                dormant: false,
                resumeOnStart: false,
                exited: false,
                recoveryUnavailable: false,
              },
            ],
            subscribe: () => () => undefined,
          }}
          surface={{ acquire: () => undefined }}
          onReturn={vi.fn()}
          onOpened={vi.fn()}
          onFocusOpened={vi.fn(() => Promise.resolve(true))}
          onOpenFailed={vi.fn()}
        />,
      )
      await settle()
    })

    const card = host.querySelector<HTMLElement>('.session-card')!
    expect(card.querySelector('h3')?.textContent).toBe('Codex · main')
    expect(card.getAttribute('aria-label')).toBe('Codex · main, Codex, Project One, main')
    expect(host.innerHTML).not.toContain(privateHandle)
    expect(host.innerHTML).not.toContain(privatePath)

    await act(async () => {
      const interact = [...card.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === 'Interact',
      )
      interact?.click()
      await settle()
    })

    expect(host.querySelector('h1')?.textContent).toBe('Codex · main')
    expect(
      host.querySelector('.sessions-detail-terminal')?.getAttribute('aria-label'),
    ).toBe('Codex · main terminal')
    expect(host.innerHTML).not.toContain(privateHandle)
    expect(host.innerHTML).not.toContain(privatePath)
  })
})

function installApi(): void {
  const listeners = new Set<(payload: unknown) => void>()
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke: vi.fn((channel: string, request: unknown) => {
        const demandGeneration = (request as { readonly demandGeneration?: number })
          .demandGeneration
        switch (channel) {
          case 'sessions:observe':
          case 'sessions:snapshot':
            return Promise.resolve(observationSnapshot(demandGeneration ?? 1))
          case 'sessions:release':
          case 'sessions:usage-release':
            return Promise.resolve(undefined)
          case 'sessions:resolve-terminal':
            return Promise.resolve({
              outcome: 'resolved' as const,
              handle: privateHandle,
              workspaceQualifier,
              livePty,
            })
          default:
            return Promise.reject(new Error(`Unexpected channel ${channel}`))
        }
      }),
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        if (channel === 'sessions:changed') listeners.add(listener)
        return () => listeners.delete(listener)
      }),
    },
  })
}

function observationSnapshot(demandGeneration: number): SessionsObservationSnapshot {
  const unsupported = { status: 'unsupported' as const }
  return {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration,
    revision: 7,
    providers: [
      {
        id: providerId,
        displayName: 'Codex',
        telemetrySupported: true,
        usageSupported: true,
        sessionKind: 'agent',
      },
    ],
    workspaces: [
      {
        projectId: asSessionsProjectHandle('opaque-project'),
        projectName: 'Project One',
        workspaceId: asSessionsWorkspaceHandle('opaque-workspace'),
        qualifier: workspaceQualifier,
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
        handle: privateHandle,
        workspaceId: asSessionsWorkspaceHandle('opaque-workspace'),
        providerId,
        profile: { status: 'available', value: { id: profileId } },
        title: 'Stored safe title',
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
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
