import { describe, expect, it } from 'vitest'

import {
  initialTerminalWorkspaceModel,
  nextTerminalSplitPane,
  terminalPaneActiveId,
  terminalWorkspaceReducer,
  type TerminalSession,
  type TerminalWorkspaceModel,
} from '../src/renderer/src/terminal/terminal-workspace-model'
import { asHarnessProfileId, asHarnessProviderId } from '../src/shared'
import { decodeTerminalSplitLayout } from '../src/renderer/src/terminal/terminal-split-persistence'

describe('terminal workspace model', () => {
  it('adds, selects, splits, moves, and closes sessions deterministically', () => {
    let model = reduce(initialTerminalWorkspaceModel, {
      type: 'session-added',
      session: session('a', 'primary'),
    })
    expect(nextTerminalSplitPane(model)).toBe('secondary')
    model = reduce(model, {
      type: 'session-added',
      session: session('b', nextTerminalSplitPane(model)),
    })
    expect(model).toMatchObject({ activeId: 'b', activePane: 'secondary' })
    expect(terminalPaneActiveId(model, 'primary')).toBe('a')
    expect(terminalPaneActiveId(model, 'secondary')).toBe('b')

    model = reduce(model, { type: 'session-moved', id: 'a' })
    expect(model.sessions.find(({ id }) => id === 'a')?.pane).toBe('secondary')
    expect(model.activeId).toBe('a')
    model = reduce(model, { type: 'session-closed', id: 'a' })
    expect(model.activeId).toBe('b')
    expect(model.activePane).toBe('secondary')
  })

  it('clears attention on focus and preserves the nearest active session on close', () => {
    let model = reduce(initialTerminalWorkspaceModel, {
      type: 'sessions-replaced',
      sessions: [
        { ...session('a', 'primary'), attention: 'idle' },
        session('b', 'primary'),
        session('c', 'secondary'),
      ],
      activeId: 'a',
    })
    model = reduce(model, { type: 'session-focused', id: 'a' })
    expect(model.sessions[0]?.attention).toBeUndefined()
    model = reduce(model, { type: 'session-closed', id: 'a' })
    expect(model.activeId).toBe('b')
  })

  it('bounds persisted split recovery data without accepting malformed widths', () => {
    const ids = Array.from({ length: 510 }, (_, index) => `terminal-${index}`)
    expect(
      decodeTerminalSplitLayout(JSON.stringify({ secondaryIds: ids, primaryWidth: 320 })),
    ).toMatchObject({ secondaryIds: ids.slice(0, 500), primaryWidth: 320 })
    expect(
      decodeTerminalSplitLayout(
        JSON.stringify({ secondaryIds: ['ok'], primaryWidth: 'wide' }),
      ),
    ).toEqual({ secondaryIds: ['ok'], primaryWidth: undefined })
  })
})

function reduce(
  model: TerminalWorkspaceModel,
  action: Parameters<typeof terminalWorkspaceReducer>[1],
): TerminalWorkspaceModel {
  return terminalWorkspaceReducer(model, action)
}

function session(id: string, pane: 'primary' | 'secondary'): TerminalSession {
  return {
    id,
    providerId: asHarnessProviderId('shell'),
    profileId: asHarnessProfileId('shell-default'),
    launchRevision: 1,
    riskAcknowledged: true,
    capabilities: {
      sessionIdentity: 'none',
      exactResume: false,
      contextPresentation: 'none',
    },
    fallbackTitle: id,
    title: id,
    status: 'Ready',
    resumeOnStart: false,
    pane,
  }
}
