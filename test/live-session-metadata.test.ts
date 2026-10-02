import { describe, expect, it, vi } from 'vitest'
import { ExtensionContextOwner } from '../src/main/extensions/context-owner'
import { SessionsObservationPort } from '../src/main/sessions/sessions-observation-port'
import { contextFixture } from './fixtures/extension-context'

describe('shared raw live-session metadata sources', () => {
  it('admits application and exact shell metadata without Sessions demand, projections or providers', async () => {
    const data = contextFixture()
    const refused = () => {
      throw new Error('Unrelated Sessions feature was accessed')
    }
    const providers = vi.fn(refused),
      hosts = vi.fn(refused),
      emit = vi.fn(refused)
    const sessions = new SessionsObservationPort({
      ...data.sources,
      providers,
      hosts,
      emit,
    })
    const acquire = vi.spyOn(sessions, 'acquire').mockImplementation(refused)
    expect(Object.keys(sessions.context).sort()).toEqual([
      'observeProjects',
      'projectState',
      'ptys',
      'sessions',
    ])
    const contexts = new ExtensionContextOwner(sessions.context),
      changed = vi.fn()
    const dispose = contexts.observe(changed)
    expect(contexts.admit({ id: 1, generation: 1 }, { surface: 'top' }).current()).toBe(
      true,
    )
    expect(contexts.sessions({ id: 1, generation: 1 })).toEqual(
      data.contexts.sessions({ id: 1, generation: 1 }),
    )
    data.change('title')
    await Promise.resolve()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(contexts.sessions({ id: 1, generation: 1 })[0]!.title).toBe('Updated')
    for (const unrelated of [acquire, providers, hosts, emit])
      expect(unrelated).not.toHaveBeenCalled()
    dispose()
    sessions.dispose()
    expect(data.listeners.flat()).toHaveLength(0)
  })
})
