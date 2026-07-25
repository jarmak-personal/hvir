// @vitest-environment happy-dom

import type { ILink } from 'ghostty-web'
import { describe, expect, it } from 'vitest'

import {
  GhosttyTerminalLinkProvider,
  type GhosttyLinkBufferLine,
  type GhosttyLinkSource,
} from '../src/renderer/src/terminal/ghostty-terminal-links'
import { resolveTerminalFileTarget } from '../src/renderer/src/terminal/terminal-file-link'
import type { TerminalLinkActivation } from '../src/renderer/src/terminal/terminal-pane'
import { asHostId, hostPath } from '../src/shared'

const workspaceRoot = hostPath(asHostId('remote'), '/srv/project')

describe('Ghostty terminal links', () => {
  it('maps one wrapped path and its line decoration across every physical row', () => {
    const target = '/srv/project/src/deep/file.ts:91:7'
    const activated: TerminalLinkActivation[] = []
    const provider = providerFor(wrappedRows(target, 18), activated)

    const firstRowLinks = linksAt(provider, 0)
    const continuationLinks = linksAt(provider, 1)
    expect(firstRowLinks).toHaveLength(1)
    expect(continuationLinks).toHaveLength(1)
    expect(continuationLinks[0]).toMatchObject({
      text: target,
      range: {
        start: { x: 0, y: 0 },
        end: { x: 15, y: 1 },
      },
    })

    firstRowLinks[0]?.activate(modifiedClick())
    continuationLinks[0]?.activate(modifiedClick())
    expect(activated).toEqual([
      { kind: 'file', target },
      { kind: 'file', target },
    ])
    expect(resolveTerminalFileTarget(activated[1]?.target ?? '', workspaceRoot)).toEqual({
      path: hostPath(asHostId('remote'), '/srv/project/src/deep/file.ts'),
      line: 91,
      column: 7,
    })
  })

  it('does not link the first fragment of a wrapped relative path', () => {
    const prefix = 'Here you go: '
    const target = 'src/renderer/src/terminal/terminal-probe-policy.ts'
    const firstRow = `${prefix}src/renderer/src/terminal/terminal-`
    const activated: TerminalLinkActivation[] = []
    const provider = providerFor(
      wrappedRows(`${prefix}${target}`, firstRow.length),
      activated,
    )

    const firstRowLinks = linksAt(provider, 0)
    const continuationLinks = linksAt(provider, 1)
    expect(firstRowLinks).toHaveLength(1)
    expect(continuationLinks).toHaveLength(1)
    expect(firstRowLinks[0]).toMatchObject({
      text: target,
      range: {
        start: { x: prefix.length, y: 0 },
        end: { x: 'probe-policy.ts'.length - 1, y: 1 },
      },
    })
    expect(firstRowLinks[0]?.text).not.toBe('src/renderer/src/terminal/terminal-')

    firstRowLinks[0]?.activate(modifiedClick())
    continuationLinks[0]?.activate(modifiedClick())
    expect(activated).toEqual([
      { kind: 'file', target },
      { kind: 'file', target },
    ])
    expect(resolveTerminalFileTarget(target, workspaceRoot)).toEqual({
      path: hostPath(
        asHostId('remote'),
        '/srv/project/src/renderer/src/terminal/terminal-probe-policy.ts',
      ),
    })
  })

  it('never promotes a path-like wrapped suffix to a workspace-relative target', () => {
    const target = '/srv/worktrees/topic/.codex-drafts/report.md'
    const activated: TerminalLinkActivation[] = []
    const provider = providerFor(wrappedRows(target, '/srv/worktrees/'.length), activated)

    const links = linksAt(provider, 1)
    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe(target)
    expect(links[0]?.text).not.toBe('topic/.codex-drafts/report.md')

    links[0]?.activate(modifiedClick())
    expect(activated).toEqual([{ kind: 'file', target }])
    expect(resolveTerminalFileTarget(target, workspaceRoot)).toBeUndefined()
  })

  it('keeps a hard newline as a boundary between independent paths', () => {
    const activated: TerminalLinkActivation[] = []
    const provider = providerFor(
      rowsFromText(['/srv/project/first.ts', 'src/second.ts:4'], 24),
      activated,
    )

    const first = linksAt(provider, 0)
    const second = linksAt(provider, 1)
    expect(first.map((link) => link.text)).toEqual(['/srv/project/first.ts'])
    expect(second.map((link) => link.text)).toEqual(['src/second.ts:4'])
    expect(second[0]?.range).toEqual({
      start: { x: 0, y: 1 },
      end: { x: 14, y: 1 },
    })
  })

  it('suppresses both fragments of an application-wrapped path', () => {
    const directory = 'src/renderer/src/terminal'
    const firstRow = `${directory}/terminal-`
    const continuation = 'probe-policy.ts'
    const activated: TerminalLinkActivation[] = []
    const provider = providerFor(
      [
        bufferLine(
          firstRow,
          firstRow.length,
          false,
          Array.from({ length: firstRow.length }, (_, x) =>
            x < directory.length ? 9 : 0,
          ),
        ),
        bufferLine(continuation, firstRow.length, false),
      ],
      activated,
      new Map([[9, `file:///srv/project/${directory}`]]),
    )

    const prefixLinks = linksAt(provider, 0)
    expect(prefixLinks).toHaveLength(1)
    prefixLinks[0]?.activate(modifiedClick())
    expect(linksAt(provider, 1)).toEqual([])
    expect(activated).toEqual([])
  })

  it('retains an exact OSC file target across an ambiguous hard row boundary', () => {
    const directory = 'src/renderer/src/terminal'
    const target = `${directory}/terminal-probe-policy.ts`
    const firstRow = `${directory}/terminal-`
    const provider = providerFor(
      [
        bufferLine(
          firstRow,
          firstRow.length,
          false,
          Array.from({ length: firstRow.length }, () => 9),
        ),
        bufferLine('probe-policy.ts', firstRow.length, false),
      ],
      [],
      new Map([[9, `file:///srv/project/${target}`]]),
    )

    expect(linksAt(provider, 0).map((link) => link.text)).toEqual([
      `file:///srv/project/${target}`,
    ])
    expect(linksAt(provider, 1)).toEqual([])
  })

  it('retains OSC 8 file links and physical-row loopback handling', () => {
    const activated: TerminalLinkActivation[] = []
    const provider = providerFor(
      [
        bufferLine('open', 24, false, [7, 7, 7, 7]),
        bufferLine('serve localhost:5173/app', 24, false),
      ],
      activated,
      new Map([[7, 'file:///srv/project/from-osc.ts']]),
    )

    const oscLinks = linksAt(provider, 0)
    expect(oscLinks).toHaveLength(1)
    expect(oscLinks[0]).toMatchObject({
      text: 'file:///srv/project/from-osc.ts',
      range: { start: { x: 0, y: 0 }, end: { x: 3, y: 0 } },
    })
    oscLinks[0]?.activate(modifiedClick())

    const webLinks = linksAt(provider, 1)
    expect(webLinks).toHaveLength(1)
    expect(webLinks[0]).toMatchObject({
      text: 'localhost:5173/app',
      range: { start: { x: 6, y: 1 }, end: { x: 23, y: 1 } },
    })
    webLinks[0]?.activate(modifiedClick())
    expect(activated).toEqual([
      { kind: 'file', target: 'file:///srv/project/from-osc.ts' },
      { kind: 'loopback-http', target: 'localhost:5173/app' },
    ])
  })
})

function providerFor(
  lines: readonly GhosttyLinkBufferLine[],
  activated: TerminalLinkActivation[],
  hyperlinkUris = new Map<number, string>(),
): GhosttyTerminalLinkProvider {
  const source: GhosttyLinkSource = {
    buffer: {
      active: {
        length: lines.length,
        getLine: (y) => lines[y],
      },
    },
    wasmTerm: {
      getHyperlinkUri: (id) => hyperlinkUris.get(id) ?? null,
    },
  }
  return new GhosttyTerminalLinkProvider(source, (activation) =>
    activated.push(activation),
  )
}

function linksAt(provider: GhosttyTerminalLinkProvider, y: number): ILink[] {
  let result: ILink[] | undefined
  provider.provideLinks(y, (links) => {
    result = links
  })
  return result ?? []
}

function wrappedRows(text: string, columns: number): GhosttyLinkBufferLine[] {
  const chunks: string[] = []
  for (let start = 0; start < text.length; start += columns) {
    chunks.push(text.slice(start, start + columns))
  }
  return chunks.map((chunk, index) => bufferLine(chunk, columns, index > 0))
}

function rowsFromText(rows: readonly string[], columns: number): GhosttyLinkBufferLine[] {
  return rows.map((row) => bufferLine(row, columns, false))
}

function bufferLine(
  text: string,
  columns: number,
  isWrapped: boolean,
  hyperlinkIds: readonly number[] = [],
): GhosttyLinkBufferLine {
  return {
    length: columns,
    isWrapped,
    getCell: (x) => ({
      getCodepoint: () => text.codePointAt(x) ?? 0,
      getHyperlinkId: () => hyperlinkIds[x] ?? 0,
    }),
  }
}

function modifiedClick(): MouseEvent {
  return new MouseEvent('click', { ctrlKey: true })
}
