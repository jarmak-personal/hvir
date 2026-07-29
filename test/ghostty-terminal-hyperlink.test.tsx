import { describe, expect, it, vi } from 'vitest'

import type { ILink, Terminal } from 'ghostty-web'

import { FileLinkProvider } from '../src/renderer/src/terminal/ghostty-terminal-pane'

function line(
  ids: readonly number[],
  text = 'link',
): {
  readonly length: number
  getCell(column: number):
    | {
        getCodepoint(): number
        getHyperlinkId(): number
      }
    | undefined
} {
  return {
    length: ids.length,
    getCell: (column) => {
      const id = ids[column]
      if (id === undefined) return undefined
      return {
        getCodepoint: () => text.codePointAt(column) ?? 32,
        getHyperlinkId: () => id,
      }
    },
  }
}

function linksFrom(provider: FileLinkProvider, row: number): ILink[] {
  let links: ILink[] | undefined
  provider.provideLinks(row, (provided) => {
    links = provided
  })
  return links ?? []
}

describe('Ghostty terminal OSC 8 hyperlink compatibility', () => {
  it('resolves active-screen targets by cell coordinates and URI identity', () => {
    const targets = [
      'file:///workspace/first.ts',
      'file:///workspace/first.ts',
      'file:///workspace/second.ts',
    ]
    const getHyperlinkUri = vi.fn((row: number, column: number) => {
      expect(row).toBe(3)
      return targets[column] ?? null
    })
    const activate = vi.fn()
    const terminal = {
      buffer: { active: { getLine: () => line([7, 7, 7, 0]) } },
      wasmTerm: {
        getScrollbackLength: () => 2,
        getHyperlinkUri,
        getScrollbackHyperlinkUri: vi.fn(),
      },
    } as unknown as Terminal
    const provider = new FileLinkProvider(terminal, activate)

    const links = linksFrom(provider, 5)

    expect(links.map(({ text, range }) => ({ text, range }))).toEqual([
      {
        text: targets[0],
        range: { start: { x: 0, y: 5 }, end: { x: 1, y: 5 } },
      },
      {
        text: targets[2],
        range: { start: { x: 2, y: 5 }, end: { x: 2, y: 5 } },
      },
    ])

    links[0]?.activate({ metaKey: true, ctrlKey: false } as unknown as MouseEvent)
    expect(activate).toHaveBeenCalledWith({
      kind: 'file',
      target: targets[0],
    })
  })

  it('uses the scrollback coordinate API for historical rows', () => {
    const getHyperlinkUri = vi.fn()
    const getScrollbackHyperlinkUri = vi.fn((offset: number, column: number) =>
      offset === 1 && column < 2 ? 'http://localhost:4173/status' : null,
    )
    const terminal = {
      buffer: { active: { getLine: () => line([3, 3, 0]) } },
      wasmTerm: {
        getScrollbackLength: () => 4,
        getHyperlinkUri,
        getScrollbackHyperlinkUri,
      },
    } as unknown as Terminal

    const links = linksFrom(new FileLinkProvider(terminal, vi.fn()), 1)

    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe('http://localhost:4173/status')
    expect(getScrollbackHyperlinkUri).toHaveBeenCalledWith(1, 0)
    expect(getHyperlinkUri).not.toHaveBeenCalled()
  })
})
