import { afterEach, describe, expect, it, vi } from 'vitest'
import { MermaidRenderOwner } from '../src/main/viewer/mermaid-render-owner'
import { MERMAID_LIMITS } from '../src/shared/presentation/mermaid-contract'
import { isMermaidComputationAsset } from '../src/main/viewer/mermaid-computation-assets'

const owner = { id: 4, generation: 2 }
function deferredJob() {
  let resolve!: (svg: string) => void
  return {
    result: new Promise<string>((done) => {
      resolve = done
    }),
    resolve: (value: string) => resolve(value),
    dispose: vi.fn(),
  }
}
const request = (id: string) => ({
  id,
  source: 'graph TD; A-->B',
  theme: 'dark' as const,
})
afterEach(() => vi.useRealTimers())

describe('finite Mermaid computation owner', () => {
  it('rejects invalid source before creating a process and independently bounds returned data', async () => {
    const job = deferredJob()
    const start = vi.fn(() => job)
    const diagrams = new MermaidRenderOwner({ start })
    await expect(
      diagrams.render(owner, {
        ...request('a'),
        source: 'x'.repeat(MERMAID_LIMITS.sourceCharacters + 1),
      }),
    ).rejects.toThrow('limit')
    expect(start).not.toHaveBeenCalled()
    const result = diagrams.render(owner, request('a'))
    job.resolve('x'.repeat(MERMAID_LIMITS.outputCharacters + 1))
    await expect(result).rejects.toThrow('output')
    expect(job.dispose).toHaveBeenCalledOnce()
  })

  it('has no unbounded queue and cancellation rejects a late completion', async () => {
    const jobs = [deferredJob(), deferredJob(), deferredJob()]
    const start = vi
      .fn()
      .mockReturnValueOnce(jobs[0])
      .mockReturnValueOnce(jobs[1])
      .mockReturnValueOnce(jobs[2])
    const diagrams = new MermaidRenderOwner({ start })
    const first = diagrams.render(owner, request('a'))
    const second = diagrams.render(owner, request('b'))
    await expect(diagrams.render(owner, request('c'))).rejects.toThrow('capacity')
    diagrams.cancel({ ...owner, generation: 1 })
    expect(jobs[0]!.dispose).not.toHaveBeenCalled()
    diagrams.cancel(owner, 'a')
    jobs[0]!.resolve('<svg>late</svg>')
    await expect(first).rejects.toThrow('cancelled')
    const third = diagrams.render(owner, request('c'))
    jobs[1]!.resolve('<svg/>')
    jobs[2]!.resolve('<svg/>')
    await expect(second).resolves.toBe('<svg/>')
    await expect(third).resolves.toBe('<svg/>')
  })

  it('disposes stuck work at its deadline and on owner revocation', async () => {
    vi.useFakeTimers()
    const job = deferredJob()
    const diagrams = new MermaidRenderOwner({ start: () => job })
    const pending = diagrams.render(owner, request('a'))
    const rejected = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(MERMAID_LIMITS.deadlineMs)
    await rejected
    expect(job.dispose).toHaveBeenCalled()
    const next = diagrams.render(owner, request('b'))
    diagrams.cancel(owner)
    diagrams.cancel(owner)
    await expect(next).rejects.toThrow('cancelled')
  })
})

describe('diagram computation asset admission', () => {
  const entry = 'file:///app/out/renderer/mermaid.html'
  it('admits the packaged entry and application module assets only', () => {
    expect(isMermaidComputationAsset(entry, entry)).toBe(true)
    expect(
      isMermaidComputationAsset('file:///app/out/renderer/assets/mermaid-123.js', entry),
    ).toBe(true)
    for (const candidate of [
      'file:///etc/passwd',
      'file:///app/out/renderer/assets/image.svg',
      'file:///app/out/renderer/index.html',
      'https://example.com/x.js',
      'file:///app/out/renderer/assets/../secret.js',
    ])
      expect(isMermaidComputationAsset(candidate, entry)).toBe(false)
  })
})
