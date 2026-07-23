import { describe, expect, it } from 'vitest'

import {
  initialTerminalWorkspaceModel,
  nextTerminalSplitPane,
  terminalPaneActiveId,
  terminalWorkspaceReducer,
  type TerminalSession,
  type TerminalWorkspaceModel,
} from '../src/renderer/src/terminal/terminal-workspace-model'
import { asHarnessProfileId, asHarnessProviderId, localPath } from '../src/shared'
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

  it('replaces one session in place while preserving split selection', () => {
    const original = session('a', 'primary')
    let model = reduce(initialTerminalWorkspaceModel, {
      type: 'sessions-replaced',
      sessions: [original, session('b', 'secondary')],
      activeId: original.id,
    })
    const replacement = {
      ...original,
      id: 'a-fresh',
      status: 'New session · pid 42',
    }

    model = reduce(model, {
      type: 'session-replaced',
      id: original.id,
      session: replacement,
    })

    expect(model.sessions.map(({ id }) => id)).toEqual(['a-fresh', 'b'])
    expect(model.activeId).toBe('a-fresh')
    expect(terminalPaneActiveId(model, 'primary')).toBe('a-fresh')
    expect(terminalPaneActiveId(model, 'secondary')).toBe('b')
    expect(
      reduce(model, {
        type: 'session-replaced',
        id: 'missing',
        session: session('duplicate', 'primary'),
      }),
    ).toBe(model)
    expect(
      reduce(model, {
        type: 'session-replaced',
        id: 'a-fresh',
        session: session('b', 'primary'),
      }),
    ).toBe(model)
  })

  it('bounds persisted split recovery data without accepting malformed widths', () => {
    const ids = Array.from({ length: 510 }, (_, index) => `terminal-${index}`)
    expect(
      decodeTerminalSplitLayout(
        JSON.stringify({
          secondaryIds: ids,
          primaryWidth: 320,
          activeByPane: { primary: 'terminal-2', secondary: 'terminal-9' },
        }),
      ),
    ).toMatchObject({
      secondaryIds: ids.slice(0, 500),
      primaryWidth: 320,
      activeByPane: { primary: 'terminal-2', secondary: 'terminal-9' },
    })
    expect(
      decodeTerminalSplitLayout(
        JSON.stringify({ secondaryIds: ['ok'], primaryWidth: 'wide' }),
      ),
    ).toEqual({ secondaryIds: ['ok'], primaryWidth: undefined })
  })

  it('starts a selected dormant row once and queues only the remaining dormant rows', () => {
    let model = reduce(initialTerminalWorkspaceModel, {
      type: 'sessions-replaced',
      sessions: [
        { ...session('active', 'primary'), dormant: false },
        { ...session('selected', 'primary'), dormant: true, resumeOnStart: true },
        { ...session('bulk', 'primary'), dormant: true },
      ],
      activeId: 'active',
    })

    model = reduce(model, { type: 'session-focused', id: 'selected' })
    expect(model.sessions[1]).toMatchObject({
      dormant: false,
      startMode: 'interactive',
      status: 'Resuming…',
    })
    model = reduce(model, { type: 'session-focused', id: 'selected' })
    expect(model.sessions[1]?.status).toBe('Resuming…')

    model = reduce(model, { type: 'dormant-sessions-start-requested' })
    expect(model.sessions[0]?.startMode).toBeUndefined()
    expect(model.sessions[1]?.startMode).toBe('interactive')
    expect(model.sessions[2]).toMatchObject({
      dormant: false,
      startMode: 'bulk',
      status: 'Queued to start',
    })
  })

  it('forgets a dormant row without admitting another process', () => {
    const live = { ...session('live', 'primary'), dormant: false }
    const dormant = { ...session('dormant', 'primary'), dormant: true }
    const model = reduce(
      reduce(initialTerminalWorkspaceModel, {
        type: 'sessions-replaced',
        sessions: [live, dormant],
        activeId: live.id,
      }),
      { type: 'session-closed', id: dormant.id },
    )

    expect(model.sessions).toEqual([live])
    expect(model.activeId).toBe(live.id)
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
    cwd: localPath('/project'),
  }
}
