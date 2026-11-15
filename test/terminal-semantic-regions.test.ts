import { describe, expect, it, vi } from 'vitest'
import type {
  TerminalEventLocation,
  TerminalEventProvenance,
  TerminalSemanticAction,
} from '../src/renderer/src/terminal/terminal-pane'
import {
  MAX_TERMINAL_SEMANTIC_REGIONS,
  TerminalSemanticRegions,
} from '../src/renderer/src/terminal/terminal-semantic-regions'

describe('terminal semantic regions', () => {
  it('derives prompt, command and output order and ordinals from authentic markers', async () => {
    const regions = new TerminalSemanticRegions()
    regions.consume(marker('fresh-line-new-prompt', 1, 10))
    regions.consume(marker('prompt-start', 2, 10))
    regions.consume(marker('end-prompt-start-input', 3, 11))
    regions.consume(marker('end-input-start-output', 4, 12))
    regions.consume(marker('end-command', 5, 18))
    expect(await walk(regions, 'normal')).toEqual([
      { kind: 'prompt', row: 10, index: 1, total: 3 },
      { kind: 'command', row: 11, index: 2, total: 3 },
      { kind: 'output', row: 12, index: 3, total: 3 },
    ])
    expect(await navigate(regions, 'previous', 'normal')).toMatchObject({
      kind: 'command',
      index: 2,
      total: 3,
    })
    expect(await navigate(regions, 'previous', 'normal')).toMatchObject({
      kind: 'prompt',
      index: 1,
      total: 3,
    })
  })

  it('fails closed for malformed order and ignores duplicate boundaries', async () => {
    const regions = new TerminalSemanticRegions()
    regions.consume(marker('end-prompt-start-input', 1, 1))
    regions.consume(marker('end-input-start-output', 2, 2))
    regions.consume(marker('fresh-line-new-prompt', 3, 3))
    regions.consume(marker('end-prompt-start-input', 4, 4))
    regions.consume(marker('end-prompt-start-input', 5, 4))
    regions.consume(marker('end-input-start-output', 6, 5))
    expect((await walk(regions, 'normal')).map(({ kind }) => kind)).toEqual([
      'prompt',
      'command',
      'output',
    ])
    regions.consume(marker('prompt-start', 7, 6))
    regions.consume(marker('end-command', 8, 7))
    expect(regions.size).toBe(3)
    expect(regions.currentCopyRange('normal')?.kind).toBe('output')

    const incomplete = new TerminalSemanticRegions()
    incomplete.consume(marker('fresh-line-new-prompt', 20, 20))
    incomplete.consume(marker('end-prompt-start-input', 21, 21))
    incomplete.consume(marker('prompt-start', 22, 22))
    expect(
      (await walk(incomplete, 'normal')).map(({ kind, row }) => [kind, row]),
    ).toEqual([
      ['prompt', 20],
      ['prompt', 22],
    ])
  })

  it('distinguishes different authenticated boundaries at identical coordinates', async () => {
    const regions = new TerminalSemanticRegions()
    regions.consume({
      ...marker('prompt-start', 1, 4),
      provenance: { ...marker('prompt-start', 1, 4).provenance, boundaryId: 'first' },
    })
    regions.consume({
      ...marker('prompt-start', 2, 4),
      provenance: {
        ...marker('prompt-start', 2, 4).provenance,
        boundaryId: 'replacement',
      },
    })
    expect(regions.size).toBe(1)
    expect(await navigate(regions, 'next', 'normal')).toMatchObject({
      kind: 'prompt',
      index: 1,
      total: 1,
    })
    expect(regions.currentCopyRange('normal')?.start.boundaryId).toBe('replacement')
  })

  it('keeps alternate and normal transitions and ordinals independent', async () => {
    const regions = new TerminalSemanticRegions()
    regions.consume(marker('fresh-line-new-prompt', 1, 1, 'normal'))
    regions.consume(marker('fresh-line-new-prompt', 2, 0, 'alternate'))
    regions.consume(marker('end-prompt-start-input', 3, 1, 'alternate'))
    regions.consume(marker('end-input-start-output', 4, 2, 'alternate'))
    regions.consume(marker('end-prompt-start-input', 5, 2, 'normal'))
    expect((await walk(regions, 'normal')).map(({ kind, row }) => [kind, row])).toEqual([
      ['prompt', 1],
      ['command', 2],
    ])
    expect(
      (await walk(regions, 'alternate')).map(({ kind, row }) => [kind, row]),
    ).toEqual([
      ['prompt', 0],
      ['command', 1],
      ['output', 2],
    ])
    expect(await navigate(regions, 'previous', 'normal')).toMatchObject({
      kind: 'command',
      index: 2,
      total: 2,
    })
  })

  it('bounds metadata and prunes expired provenance only when encountered', async () => {
    const regions = new TerminalSemanticRegions()
    let id = 1
    for (let index = 0; index < MAX_TERMINAL_SEMANTIC_REGIONS + 80; index++) {
      regions.consume(marker('fresh-line-new-prompt', id++, index * 2))
      regions.consume(marker('end-prompt-start-input', id++, index * 2 + 1))
    }
    expect(regions.size).toBe(MAX_TERMINAL_SEMANTIC_REGIONS)
    const newest = id - 1
    const resolve = (boundary: TerminalEventProvenance) =>
      boundary.id > newest - 12 ? retain(boundary) : undefined
    await walk(regions, 'normal', resolve)
    expect(regions.size).toBe(7)
    expect(await navigate(regions, 'previous', 'normal', () => undefined)).toBeUndefined()
    expect(regions.size).toBe(0)
    regions.consume(marker('fresh-line-new-prompt', id, 0))
    expect(regions.size).toBe(1)
    regions.clear()
    regions.clear()
    expect(regions.size).toBe(0)
    expect(await navigate(regions, 'next', 'normal')).toBeUndefined()
  })

  it('resolves only the nearest candidate and active anchor instead of sweeping retained metadata', async () => {
    const regions = new TerminalSemanticRegions()
    for (let index = 0; index < 60; index++) {
      const id = index * 4 + 1
      regions.consume(marker('prompt-start', id, id))
      regions.consume(marker('end-prompt-start-input', id + 1, id + 1))
      regions.consume(marker('end-input-start-output', id + 2, id + 2))
      regions.consume(marker('end-command', id + 3, id + 3))
    }
    const resolve = vi.fn((boundary: TerminalEventProvenance) =>
      Promise.resolve(retain(boundary)),
    )
    const reveal = vi.fn(() => Promise.resolve(true))
    const navigate = () =>
      regions.navigateCandidates(
        regions.navigationCandidateIds('previous', 'normal'),
        'normal',
        resolve,
        reveal,
        new AbortController().signal,
      )
    expect(await navigate()).toEqual({ kind: 'output', index: 180, total: 180 })
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(reveal).toHaveBeenCalledOnce()
    resolve.mockClear()
    reveal.mockClear()
    expect(await navigate()).toEqual({ kind: 'command', index: 179, total: 180 })
    expect(resolve).toHaveBeenCalledTimes(4)
    expect(reveal).toHaveBeenCalledOnce()
  })

  it('prunes only encountered expired candidates and never resolves another screen', async () => {
    const regions = new TerminalSemanticRegions()
    regions.consume(marker('prompt-start', 1, 1))
    regions.consume(marker('end-prompt-start-input', 2, 2))
    regions.consume(marker('end-input-start-output', 3, 3))
    regions.consume(marker('end-command', 4, 4))
    regions.consume(marker('prompt-start', 10, 1, 'alternate'))
    regions.consume(marker('end-prompt-start-input', 11, 2, 'alternate'))
    const resolve = vi.fn((boundary: TerminalEventProvenance) =>
      Promise.resolve(boundary.id === 3 ? undefined : retain(boundary)),
    )
    const reveal = vi.fn(() => Promise.resolve(true))
    expect(
      await regions.navigateCandidates(
        regions.navigationCandidateIds('previous', 'normal'),
        'normal',
        resolve,
        reveal,
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'prompt', index: 1, total: 1 })
    expect(resolve.mock.calls.every(([boundary]) => boundary.screen === 'normal')).toBe(
      true,
    )
    expect(reveal).toHaveBeenCalledOnce()
    expect(regions.size).toBe(3)
  })

  it('refuses a boundary resolved on a different screen without revealing it', async () => {
    const regions = new TerminalSemanticRegions()
    regions.consume(marker('prompt-start', 1, 1))
    const reveal = vi.fn(() => Promise.resolve(true))
    expect(
      await regions.navigateCandidates(
        regions.navigationCandidateIds('next', 'normal'),
        'normal',
        () =>
          Promise.resolve<TerminalEventLocation>({
            screen: 'alternate',
            row: 1,
            column: 0,
          }),
        reveal,
        new AbortController().signal,
      ),
    ).toBeUndefined()
    expect(reveal).not.toHaveBeenCalled()
    expect(regions.size).toBe(0)
  })
})

async function navigate(
  regions: TerminalSemanticRegions,
  direction: 'previous' | 'next',
  screen: 'normal' | 'alternate',
  resolve: (
    boundary: TerminalEventProvenance,
  ) => TerminalEventLocation | undefined = retain,
  reveal: (boundary: TerminalEventProvenance) => Promise<boolean> = () =>
    Promise.resolve(true),
) {
  return regions.navigateCandidates(
    regions.navigationCandidateIds(direction, screen),
    screen,
    (boundary) => Promise.resolve(resolve(boundary)),
    reveal,
    new AbortController().signal,
  )
}
async function walk(
  regions: TerminalSemanticRegions,
  screen: 'normal' | 'alternate',
  resolve: (
    boundary: TerminalEventProvenance,
  ) => TerminalEventLocation | undefined = retain,
) {
  const visited: Array<{ kind: string; row: number; index: number; total: number }> = []
  for (let step = 0; step <= MAX_TERMINAL_SEMANTIC_REGIONS; step++) {
    let row = -1
    const summary = await navigate(regions, 'next', screen, resolve, (boundary) => {
      row = resolve(boundary)!.row
      return Promise.resolve(true)
    })
    if (!summary) return visited
    visited.push({ ...summary, row })
  }
  throw new Error('semantic navigation did not exhaust its bounded metadata')
}
function marker(
  action: TerminalSemanticAction,
  id: number,
  row: number,
  screen: 'normal' | 'alternate' = 'normal',
) {
  return { action, provenance: { id, row, column: 0, screen } }
}
function retain(boundary: TerminalEventProvenance): TerminalEventLocation {
  return { screen: boundary.screen, row: boundary.row, column: boundary.column }
}
