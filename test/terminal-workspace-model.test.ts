import { describe, expect, it } from 'vitest'

import {
  initialTerminalWorkspaceModel,
  createTerminalForkSession,
  nextTerminalSplitPane,
  terminalPaneActiveId,
  terminalWorkspaceReducer,
  terminalWorkspaceActionAffectsSessionsProjection,
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

  it('selects an exact Sessions target without clearing attention or starting it', () => {
    const selected = { ...session('selected', 'secondary'), attention: 'idle' as const }
    const model = reduce(
      reduce(initialTerminalWorkspaceModel, {
        type: 'sessions-replaced',
        sessions: [session('current', 'primary'), selected],
        activeId: 'current',
      }),
      { type: 'session-selected', id: selected.id },
    )

    expect(model.activeId).toBe(selected.id)
    expect(model.activePane).toBe('secondary')
    expect(model.sessions[1]).toBe(selected)
    expect(model.sessions[1]?.attention).toBe('idle')
    expect(model.sessions[1]?.startMode).toBeUndefined()
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

  it('starts only the selected dormant row', () => {
    let model = reduce(initialTerminalWorkspaceModel, {
      type: 'sessions-replaced',
      sessions: [
        { ...session('active', 'primary'), dormant: false },
        { ...session('selected', 'primary'), dormant: true, resumeOnStart: true },
        { ...session('waiting', 'primary'), dormant: true },
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

    expect(model.sessions[0]?.startMode).toBeUndefined()
    expect(model.sessions[1]?.startMode).toBe('interactive')
    expect(model.sessions[2]?.dormant).toBe(true)
    expect(model.sessions[2]?.startMode).toBeUndefined()
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

  it('keeps pointer resize changes out of Sessions observation notifications', () => {
    expect(
      terminalWorkspaceActionAffectsSessionsProjection({
        type: 'primary-width-changed',
        width: 420,
      }),
    ).toBe(false)
    expect(
      terminalWorkspaceActionAffectsSessionsProjection({
        type: 'session-updated',
        session: session('changed', 'primary'),
      }),
    ).toBe(true)
  })

  it('stages one adjacent unfocused fork and settles it without changing pane focus', () => {
    const source = {
      ...session('source', 'secondary'),
      harnessSessionId: '019ab123-4567-7890-abcd-ef0123456789',
      identityStatus: 'identified' as const,
    }
    let model = reduce(initialTerminalWorkspaceModel, {
      type: 'sessions-replaced',
      sessions: [session('before', 'primary'), source, session('after', 'secondary')],
      activeId: source.id,
    })
    const fork = createTerminalForkSession('fork', source)
    if (!fork) throw new Error('fork fixture unavailable')

    model = reduce(model, {
      type: 'session-fork-requested',
      sourceId: source.id,
      session: fork,
    })

    expect(model.sessions.map(({ id }) => id)).toEqual([
      'before',
      'source',
      'fork',
      'after',
    ])
    expect(model.activeId).toBe(source.id)
    expect(model.activeByPane.secondary).toBe(source.id)
    expect(model.sessions[1]?.forkPending).toBe(true)
    expect(model.sessions[2]).toMatchObject({
      pane: 'secondary',
      cwd: source.cwd,
      profileId: source.profileId,
      forkRequest: {
        sourceSessionId: source.id,
        parentHarnessSessionId: source.harnessSessionId,
      },
    })
    expect(
      reduce(model, {
        type: 'session-fork-requested',
        sourceId: source.id,
        session: { ...fork, id: 'duplicate' },
      }),
    ).toBe(model)

    model = reduce(model, {
      type: 'session-fork-succeeded',
      sourceId: source.id,
      session: {
        ...fork,
        harnessSessionId: '129ab123-4567-7890-abcd-ef0123456789',
        identityStatus: 'identified',
        forkRequest: undefined,
      },
    })
    expect(model.sessions[1]?.forkPending).toBeUndefined()
    expect(model.sessions[2]?.forkRequest).toBeUndefined()
    expect(model.activeId).toBe(source.id)
  })

  it('removes a failed hidden fork and releases its source for another request', () => {
    const source = {
      ...session('source', 'primary'),
      harnessSessionId: '019ab123-4567-7890-abcd-ef0123456789',
      identityStatus: 'identified' as const,
    }
    const fork = createTerminalForkSession('fork', source)
    if (!fork) throw new Error('fork fixture unavailable')
    const pending = reduce(
      reduce(initialTerminalWorkspaceModel, {
        type: 'sessions-replaced',
        sessions: [source],
        activeId: source.id,
      }),
      { type: 'session-fork-requested', sourceId: source.id, session: fork },
    )

    const failed = reduce(pending, {
      type: 'session-fork-failed',
      sourceId: source.id,
      id: fork.id,
    })

    expect(failed.sessions).toHaveLength(1)
    expect(failed.sessions[0]?.id).toBe(source.id)
    expect(failed.sessions[0]?.forkPending).toBeUndefined()
    expect(failed.activeId).toBe(source.id)
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
