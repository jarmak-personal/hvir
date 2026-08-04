import { describe, expect, it } from 'vitest'

import { RendererSshPrompter } from '../src/main/project-host'

describe('RendererSshPrompter', () => {
  it('keeps concurrent prompts addressable and removes an aborted host presentation', async () => {
    const emitted: { id: number; hostId: string }[] = []
    const cancelled: string[] = []
    const prompter = new RendererSshPrompter(
      (_owner, prompt) => emitted.push(prompt),
      (_owner, hostId) => cancelled.push(hostId),
    )
    const owner = { id: 7, generation: 1 }
    const alpha = new AbortController()
    const beta = new AbortController()
    prompter.activateOwner(owner)
    const first = prompter.runForOwner(owner, () =>
      prompter.prompt(
        { hostId: 'alpha', kind: 'password', title: 'Alpha', prompts: [] },
        alpha.signal,
      ),
    )
    const second = prompter.runForOwner(owner, () =>
      prompter.prompt(
        { hostId: 'beta', kind: 'password', title: 'Beta', prompts: [] },
        beta.signal,
      ),
    )

    expect(emitted).toEqual([
      expect.objectContaining({ id: 1, hostId: 'alpha' }),
      expect.objectContaining({ id: 2, hostId: 'beta' }),
    ])
    alpha.abort()
    prompter.respond(owner, 1, ['late'])
    prompter.respond(owner, 2, ['secret'])
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toEqual(['secret'])
    expect(cancelled).toEqual(['alpha'])
  })

  it('moves a prompt presentation lease across a renderer reload', async () => {
    const emitted: { owner: number; generation: number; id: number }[] = []
    const prompter = new RendererSshPrompter((owner, prompt) =>
      emitted.push({ owner: owner.id, generation: owner.generation, id: prompt.id }),
    )
    const previous = { id: 7, generation: 1 }
    const current = { id: 7, generation: 2 }
    const connection = new AbortController()
    prompter.activateOwner(previous)
    const response = prompter.runForOwner(previous, () =>
      prompter.prompt(
        { hostId: 'alpha', kind: 'password', title: 'Alpha', prompts: [] },
        connection.signal,
      ),
    )

    prompter.revokeOwner(previous)
    prompter.respond(previous, 1, ['stale'])
    prompter.activateOwner(current)
    prompter.respond(current, 1, ['current'])

    await expect(response).resolves.toEqual(['current'])
    expect(emitted).toEqual([
      { owner: 7, generation: 1, id: 1 },
      { owner: 7, generation: 2, id: 1 },
    ])
  })

  it('cancels every outstanding prompt when the application owner disposes', async () => {
    const cancelled: string[] = []
    const prompter = new RendererSshPrompter(
      () => undefined,
      (_owner, hostId) => cancelled.push(hostId),
    )
    const owner = { id: 7, generation: 1 }
    prompter.activateOwner(owner)
    const alpha = prompter.prompt(
      { hostId: 'alpha', kind: 'password', title: 'Alpha', prompts: [] },
      new AbortController().signal,
    )
    const beta = prompter.prompt(
      { hostId: 'beta', kind: 'host-key', title: 'Beta', prompts: [] },
      new AbortController().signal,
    )

    prompter.cancelAll()

    await expect(alpha).resolves.toBeUndefined()
    await expect(beta).resolves.toBeUndefined()
    expect(cancelled.sort()).toEqual(['alpha', 'beta'])
  })
})
