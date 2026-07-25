/// <reference lib="dom" />

import { readFileSync } from 'node:fs'

import {
  Ghostty,
  Terminal as GhosttyCanvasTerminal,
  type GhosttyCell,
  type ILink,
} from 'ghostty-web'
import { beforeAll, describe, expect, it } from 'vitest'

import { GhosttyTerminalLinkProvider } from '../src/renderer/src/terminal/ghostty-terminal-links'
import type { TerminalLinkActivation } from '../src/renderer/src/terminal/terminal-pane'

describe('Ghostty buffer contract', () => {
  let ghostty: Ghostty

  beforeAll(async () => {
    const wasm = readFileSync(
      `${process.cwd()}/src/renderer/src/terminal/ghostty-vt.wasm`,
    )
    ghostty = await Ghostty.load(
      `data:application/wasm;base64,${wasm.toString('base64')}`,
    )
  })

  it('marks the row that continues a soft-wrapped predecessor', () => {
    const terminal = ghostty.createTerminal(12, 4)
    terminal.write('123456789012abcdef')

    expect(
      [0, 1].map((y) => {
        return {
          text: terminalLineText(terminal.getLine(y)),
          isWrapped: terminal.isRowWrapped(y),
        }
      }),
    ).toEqual([
      { text: '123456789012', isWrapped: false },
      { text: 'abcdef', isWrapped: true },
    ])

    terminal.free()
  })

  it('retains continuation state after a logical line enters scrollback', () => {
    const terminal = ghostty.createTerminal(12, 4)
    const canvasTerminal = new GhosttyCanvasTerminal({
      cols: 12,
      rows: 4,
      ghostty,
    })
    Reflect.set(canvasTerminal, 'wasmTerm', terminal)
    terminal.write('123456789012abcdef\r\nline-2\r\nline-3\r\nline-4\r\nline-5')

    const scrollbackLength = terminal.getScrollbackLength()
    expect(
      Array.from({ length: scrollbackLength }, (_, offset) => ({
        text: bufferLineText(canvasTerminal.buffer.active.getLine(offset)),
        isWrapped: canvasTerminal.buffer.active.getLine(offset)?.isWrapped,
      })),
    ).toEqual([
      { text: '123456789012', isWrapped: false },
      { text: 'abcdef', isWrapped: true },
    ])

    terminal.free()
  })

  it('detects one complete wrapped file target after both rows enter scrollback', () => {
    const target = 'src/renderer/src/terminal/terminal-probe-policy.ts'
    const terminal = ghostty.createTerminal(50, 4)
    const canvasTerminal = new GhosttyCanvasTerminal({
      cols: 50,
      rows: 4,
      ghostty,
    })
    Reflect.set(canvasTerminal, 'wasmTerm', terminal)
    terminal.write(
      `\u001bcHere you go: ${target}\r\nline-2\r\nline-3\r\nline-4\r\nline-5`,
    )

    const activated: TerminalLinkActivation[] = []
    const provider = new GhosttyTerminalLinkProvider(
      canvasTerminal,
      (activation) => activated.push(activation),
    )
    const firstRowLinks = linksAt(provider, 0)
    const continuationLinks = linksAt(provider, 1)

    expect(firstRowLinks.map((link) => link.text)).toEqual([target])
    expect(continuationLinks.map((link) => link.text)).toEqual([target])
    continuationLinks[0]?.activate({
      ctrlKey: true,
      metaKey: false,
    } as unknown as MouseEvent)
    expect(activated).toEqual([{ kind: 'file', target }])

    terminal.free()
  })
})

function terminalLineText(cells: readonly GhosttyCell[] | null): string {
  return (
    cells
      ?.map((cell) => (cell.codepoint < 32 ? ' ' : String.fromCodePoint(cell.codepoint)))
      .join('')
      .trimEnd() ?? ''
  )
}

function bufferLineText(
  line: ReturnType<GhosttyCanvasTerminal['buffer']['active']['getLine']>,
): string {
  if (!line) return ''
  return Array.from({ length: line.length }, (_, x) => {
    const codepoint = line.getCell(x)?.getCodepoint() ?? 0
    return codepoint < 32 ? ' ' : String.fromCodePoint(codepoint)
  })
    .join('')
    .trimEnd()
}

function linksAt(provider: GhosttyTerminalLinkProvider, y: number): ILink[] {
  let result: ILink[] | undefined
  provider.provideLinks(y, (links) => {
    result = links
  })
  return result ?? []
}
