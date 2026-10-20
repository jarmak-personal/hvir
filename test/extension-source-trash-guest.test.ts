import { expect, it, vi } from 'vitest'
import { attached, fixture } from './fixtures/extension-guest'
import type { SourceCaller } from '../src/main/extensions/source-reading'
import { DEFAULT_EXTENSION_PRESENTATION } from '../src/main/extensions/guest-owner'

it('ignores additive Trash input fields with a warning and keeps current human visibility live', async () => {
  let caller: SourceCaller | undefined
  const request = vi.fn((next: SourceCaller) => {
    caller = next
    return Promise.resolve({ outcome: 'cancelled' as const })
  })
  const f = fixture({}, { requiredCapabilities: ['source.request-trash'] }, undefined, {
    sourceTrash: { request, revalidate: vi.fn() },
  })
  try {
    const view = await attached(f)
    f.owner.receive(10, { kind: 'hello', contract: '1.0' })
    f.owner.receive(10, {
      kind: 'request',
      id: 'trash',
      capability: 'source.request-trash',
      input: {
        source: 'project',
        workspaceId: 'workspace',
        path: { hostId: 'local', path: '/project/skill' },
        futureField: true,
      },
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(f.sent.find(({ message }) => message.kind === 'result')).toMatchObject({
        message: {
          id: 'trash',
          ok: true,
          warnings: [expect.stringContaining('futureField')],
        },
      }),
    )
    expect(caller?.allowed).toBe(true)
    expect(() => caller!.current()).not.toThrow()
    f.owner.runnable(view.id, 'new-action', true)
    expect(() => caller!.current()).toThrow(/ordinary human/)
    f.owner.runnable(view.id, 'new-action', false)
    f.owner.presentation(
      f.renderer,
      view.id,
      DEFAULT_EXTENSION_PRESENTATION,
      false,
      false,
    )
    expect(() => caller!.current()).toThrow(/hidden/)
  } finally {
    await f.owner.dispose()
  }
})

it('does not negotiate a Trash request capability for an updater', async () => {
  const f = fixture(
    {},
    {
      updater: 'index.html',
      requiredCapabilities: ['presentation.read'],
      optionalCapabilities: ['source.request-trash'],
    },
  )
  try {
    const view = await f.owner.open(f.renderer, 'installation', 'updater', undefined, {
      updater: true,
    })
    f.owner.claim(f.renderer, view.partition, view.url, view.id)
    f.owner.bind(f.renderer, view.partition, 10)
    f.owner.receive(10, { kind: 'hello', contract: '1.0' })
    expect(f.sent.find(({ message }) => message.kind === 'hello')?.message).toMatchObject(
      {
        capabilities: ['presentation.read'],
      },
    )
  } finally {
    await f.owner.dispose()
  }
})
