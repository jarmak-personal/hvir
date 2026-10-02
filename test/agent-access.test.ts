import { describe, expect, it, vi } from 'vitest'
import { LocalAgentAccessOwner } from '../src/main/agent/access-owner'
import type { AgentSettings } from '../src/shared/agent/contract'

const enabled = { enabled: true, confirmDestructive: false }
const consent = {
  allowed: () => ['reference'],
  writable: () => true,
  signal: () => new AbortController().signal,
}
const disabled = { ...enabled, enabled: false }
function deferred() {
  let resolve!: () => void, reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
describe('local agent authorization lifetime', () => {
  it.each(['success', 'failure'])(
    'serializes older save %s without overwriting the newer trusted setting',
    async (outcome) => {
      const first = deferred(),
        saved: AgentSettings[] = []
      const owner = new LocalAgentAccessOwner(
        () => undefined,
        async (settings) => {
          saved.push(settings)
          if (saved.length === 1) await first.promise
        },
      )
      const older = owner.configure(enabled).catch(() => undefined)
      await vi.waitFor(() => expect(saved).toHaveLength(1))
      const admitted = owner.admit(new AbortController().signal)
      const newer = owner.configure(disabled)
      expect(() => admitted.current()).toThrow()
      expect(saved).toHaveLength(1)
      if (outcome === 'success') first.resolve()
      else first.reject(new Error('older write failed'))
      await Promise.all([older, newer])
      expect(saved).toEqual([enabled, disabled])
      expect(owner.snapshot().enabled).toBe(false)
    },
  )
  it('requires an exact trusted destructive decision and revokes pending decisions on stricter access', async () => {
    const owner = new LocalAgentAccessOwner(vi.fn(), () => Promise.resolve(), consent)
    await owner.configure({ ...enabled, confirmDestructive: true })
    const admitted = owner.admit(new AbortController().signal)
    const binding = {
      installation: 'reference',
      title: 'Replace exact target',
      input: '{"path":"first"}',
      workspace: 'workspace',
      effects: { delete: false, replace: true },
    }
    const pending = owner.authorizeAction(binding, admitted.current, admitted.signal)
    const decision = owner.snapshot().confirmations[0]!
    expect(decision.input).toBe(binding.input)
    expect(() => owner.decide('caller-claim', true)).toThrow('stale')
    owner.decide(decision.id, true)
    await expect(pending).resolves.toBe('interactive')
    const cancelled = owner.authorizeAction(binding, admitted.current, admitted.signal)
    const cancellation = expect(cancelled).rejects.toThrow()
    await owner.configure(disabled)
    await cancellation
    expect(owner.snapshot().confirmations).toEqual([])
    expect(() => owner.decide(decision.id, true)).toThrow('stale')
    owner.dispose()
  })
  it('keeps ordinary standing admission independent of claims and refuses disabled extension access', async () => {
    const owner = new LocalAgentAccessOwner(
      () => undefined,
      () => Promise.resolve(),
      consent,
    )
    expect(() => owner.admit(new AbortController().signal)).toThrow('off')
    await owner.configure(enabled)
    const admitted = owner.admit(new AbortController().signal)
    await expect(
      owner.authorizeAction(
        {
          installation: 'reference',
          title: 'Declared replace',
          input: 'null',
          effects: { delete: false, replace: true },
        },
        admitted.current,
        admitted.signal,
      ),
    ).resolves.toBe('standing')
    expect(owner.snapshot().confirmations).toEqual([])
    expect(() => owner.assertExtension('other')).toThrow('off')
    owner.dispose()
    expect(() => admitted.current()).toThrow()
  })
})
