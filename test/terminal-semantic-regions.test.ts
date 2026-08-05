import { describe, expect, it } from 'vitest'

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
  it('derives prompt, command, and output regions only from ordered semantic markers', () => {
    const regions = new TerminalSemanticRegions()
    regions.consume(marker('fresh-line-new-prompt', 1, 10))
    regions.consume(marker('prompt-start', 2, 10))
    regions.consume(marker('end-prompt-start-input', 3, 11))
    regions.consume(marker('end-input-start-output', 4, 12))
    regions.consume(marker('end-command', 5, 18))

    const first = regions.navigationPlan('next', 'normal', retain)
    expect(first.resolved.map(({ kind, location }) => [kind, location.row])).toEqual([
      ['prompt', 10],
      ['command', 11],
      ['output', 12],
    ])
    expect(regions.activate(first.candidates[0]!.id, 'normal', first.resolved)).toEqual({
      kind: 'prompt',
      index: 1,
      total: 3,
    })

    const second = regions.navigationPlan('next', 'normal', retain)
    expect(second.candidates[0]?.kind).toBe('command')
    expect(regions.activate(second.candidates[0]!.id, 'normal', second.resolved)).toEqual(
      {
        kind: 'command',
        index: 2,
        total: 3,
      },
    )
    expect(regions.navigationPlan('previous', 'normal', retain).candidates[0]?.kind).toBe(
      'prompt',
    )
  })

  it('fails closed for malformed order and ignores consecutive duplicate boundaries', () => {
    const regions = new TerminalSemanticRegions()
    regions.consume(marker('end-prompt-start-input', 1, 1))
    regions.consume(marker('end-input-start-output', 2, 2))
    regions.consume(marker('fresh-line-new-prompt', 3, 3))
    regions.consume(marker('end-prompt-start-input', 4, 4))
    regions.consume(marker('end-prompt-start-input', 5, 4))
    regions.consume(marker('end-input-start-output', 6, 5))

    expect(
      regions.navigationPlan('next', 'normal', retain).resolved.map(({ kind }) => kind),
    ).toEqual(['prompt', 'command', 'output'])

    const incomplete = new TerminalSemanticRegions()
    incomplete.consume(marker('fresh-line-new-prompt', 20, 20))
    incomplete.consume(marker('end-prompt-start-input', 21, 21))
    incomplete.consume(marker('prompt-start', 22, 22))
    expect(
      incomplete
        .navigationPlan('next', 'normal', retain)
        .resolved.map(({ kind, location }) => [kind, location.row]),
    ).toEqual([
      ['prompt', 20],
      ['prompt', 22],
    ])

    regions.consume(marker('prompt-start', 7, 6))
    regions.consume(marker('end-command', 8, 7))
    expect(
      regions.navigationPlan('next', 'normal', retain).resolved.map(({ kind }) => kind),
    ).toEqual(['prompt', 'command', 'output'])
  })

  it('keeps alternate and normal screen transitions independent', () => {
    const regions = new TerminalSemanticRegions()
    regions.consume(marker('fresh-line-new-prompt', 1, 1, 'normal'))
    regions.consume(marker('fresh-line-new-prompt', 2, 0, 'alternate'))
    regions.consume(marker('end-prompt-start-input', 3, 1, 'alternate'))
    regions.consume(marker('end-input-start-output', 4, 2, 'alternate'))
    regions.consume(marker('end-prompt-start-input', 5, 2, 'normal'))

    const resolved = regions.navigationPlan('next', 'normal', retain).resolved
    expect(resolved.map(({ kind, location }) => [location.screen, kind])).toEqual([
      ['normal', 'prompt'],
      ['alternate', 'prompt'],
      ['alternate', 'command'],
      ['alternate', 'output'],
      ['normal', 'command'],
    ])
    const alternate = resolved.filter(({ location }) => location.screen === 'alternate')
    expect(regions.activate(alternate[1]!.id, 'alternate', resolved)).toEqual({
      kind: 'command',
      index: 2,
      total: 3,
    })
    expect(
      regions.navigationPlan('previous', 'normal', retain).candidates[0],
    ).toMatchObject({
      kind: 'command',
      location: { screen: 'normal' },
    })
  })

  it('bounds metadata and releases every region whose terminal provenance expired', () => {
    const regions = new TerminalSemanticRegions()
    let id = 1
    for (let index = 0; index < MAX_TERMINAL_SEMANTIC_REGIONS + 80; index += 1) {
      regions.consume(marker('fresh-line-new-prompt', id++, index * 2))
      regions.consume(marker('end-prompt-start-input', id++, index * 2 + 1))
    }

    expect(regions.size).toBe(MAX_TERMINAL_SEMANTIC_REGIONS)
    const newestProvenanceId = id - 1
    const plan = regions.navigationPlan('previous', 'normal', (provenance) =>
      provenance.id > newestProvenanceId - 12 ? retain(provenance) : undefined,
    )
    expect(plan.changed).toBe(true)
    expect(regions.size).toBe(7)

    const reset = regions.navigationPlan('next', 'normal', () => undefined)
    expect(reset.changed).toBe(true)
    expect(reset.resolved).toEqual([])
    expect(regions.size).toBe(0)

    const reusedRow = new TerminalSemanticRegions()
    reusedRow.consume(marker('fresh-line-new-prompt', 1, 0))
    reusedRow.navigationPlan('next', 'normal', () => undefined)
    reusedRow.consume(marker('fresh-line-new-prompt', 2, 0))
    expect(reusedRow.size).toBe(1)
  })

  it('clears all per-pane state idempotently for replacement and disposal', () => {
    const regions = new TerminalSemanticRegions()
    regions.consume(marker('fresh-line-new-prompt', 1, 1))
    regions.consume(marker('end-prompt-start-input', 2, 2))

    regions.clear()
    regions.clear()

    expect(regions.size).toBe(0)
    expect(regions.navigationPlan('next', 'normal', retain).resolved).toEqual([])
  })
})

function marker(
  action: TerminalSemanticAction,
  id: number,
  row: number,
  screen: 'normal' | 'alternate' = 'normal',
) {
  return { action, provenance: { id, row, column: 0, screen } }
}

function retain(provenance: TerminalEventProvenance): TerminalEventLocation {
  return { screen: provenance.screen, row: provenance.row, column: provenance.column }
}
