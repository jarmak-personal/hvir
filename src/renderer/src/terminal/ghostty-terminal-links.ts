import type { ILink, ILinkProvider } from 'ghostty-web'

import type { TerminalLinkActivation } from './terminal-pane'
import {
  detectTerminalFileLinks,
  detectTerminalWebLinks,
  isFileUri,
  isTerminalWebTarget,
} from './terminal-file-link'

export interface GhosttyLinkBufferCell {
  getCodepoint(): number
  getHyperlinkId(): number
}

export interface GhosttyLinkBufferLine {
  readonly length: number
  /** Ghostty marks a row when it continues the preceding soft-wrapped row. */
  readonly isWrapped: boolean
  getCell(x: number): GhosttyLinkBufferCell | undefined
}

export interface GhosttyLinkSource {
  readonly buffer: {
    readonly active: {
      readonly length: number
      getLine(y: number): GhosttyLinkBufferLine | undefined
    }
  }
  readonly wasmTerm?: {
    getHyperlinkUri(id: number): string | null
  }
}

interface LogicalTerminalLine {
  readonly text: string
  readonly positions: readonly BufferPosition[]
}

interface BufferPosition {
  readonly x: number
  readonly y: number
}

/** Registered after Ghostty's built-ins so file:// OSC 8 links stay inside hvir. */
export class GhosttyTerminalLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: GhosttyLinkSource,
    private readonly activateTarget: (activation: TerminalLinkActivation) => void,
  ) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.terminal.buffer.active.getLine(y)
    if (!line) {
      callback(undefined)
      return
    }

    const lineText = terminalLineText(line)
    const links = this.oscLinks(line, y)
    const logicalLine = readLogicalTerminalLine(this.terminal.buffer.active, y)
    if (logicalLine) {
      for (const candidate of detectTerminalFileLinks(logicalLine.text)) {
        const range = logicalRange(logicalLine, candidate.start, candidate.end)
        if (!range || y < range.start.y || y > range.end.y) continue
        links.push(this.link({ kind: 'file', target: candidate.target }, range))
      }
    }

    // Registered after Ghostty's built-in URL detector, so these exact ranges
    // replace its global window.open activations with typed terminal provenance.
    for (const candidate of detectTerminalWebLinks(lineText)) {
      links.push(
        this.link(
          { kind: 'loopback-http', target: candidate.target },
          {
            start: { x: candidate.start, y },
            end: { x: candidate.end, y },
          },
        ),
      )
    }
    callback(links.length > 0 ? links : undefined)
  }

  private oscLinks(line: GhosttyLinkBufferLine, y: number): ILink[] {
    const links: ILink[] = []
    const hyperlinkIds = new Set<number>()
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x)
      const id = cell?.getHyperlinkId() ?? 0
      if (id <= 0 || hyperlinkIds.has(id)) continue
      hyperlinkIds.add(id)
      const target = this.terminal.wasmTerm?.getHyperlinkUri(id)
      if (!target || (!isFileUri(target) && !isTerminalWebTarget(target))) continue
      let start = x
      let end = x
      while (start > 0 && line.getCell(start - 1)?.getHyperlinkId() === id) start -= 1
      while (end + 1 < line.length && line.getCell(end + 1)?.getHyperlinkId() === id) {
        end += 1
      }
      links.push(
        this.link(
          { kind: isFileUri(target) ? 'file' : 'loopback-http', target },
          { start: { x: start, y }, end: { x: end, y } },
        ),
      )
    }
    return links
  }

  private link(activation: TerminalLinkActivation, range: ILink['range']): ILink {
    return {
      text: activation.target,
      range,
      activate: (event) => {
        if (event.ctrlKey || event.metaKey) this.activateTarget(activation)
      },
    }
  }
}

function readLogicalTerminalLine(
  buffer: GhosttyLinkSource['buffer']['active'],
  requestedY: number,
): LogicalTerminalLine | undefined {
  if (!buffer.getLine(requestedY)) return undefined

  let startY = requestedY
  while (startY > 0 && buffer.getLine(startY)?.isWrapped) startY -= 1

  let endY = requestedY
  while (endY + 1 < buffer.length && buffer.getLine(endY + 1)?.isWrapped) {
    endY += 1
  }

  const text: string[] = []
  const positions: BufferPosition[] = []
  for (let y = startY; y <= endY; y += 1) {
    const line = buffer.getLine(y)
    if (!line) return undefined
    for (let x = 0; x < line.length; x += 1) {
      const cellText = terminalCellText(line, x)
      text.push(cellText)
      for (let offset = 0; offset < cellText.length; offset += 1) {
        positions.push({ x, y })
      }
    }
  }
  return { text: text.join(''), positions }
}

function terminalLineText(line: GhosttyLinkBufferLine): string {
  const text: string[] = []
  for (let x = 0; x < line.length; x += 1) {
    text.push(terminalCellText(line, x))
  }
  return text.join('')
}

function terminalCellText(line: GhosttyLinkBufferLine, x: number): string {
  const codepoint = line.getCell(x)?.getCodepoint() ?? 0
  return codepoint < 32 ? ' ' : String.fromCodePoint(codepoint)
}

function logicalRange(
  line: LogicalTerminalLine,
  start: number,
  end: number,
): ILink['range'] | undefined {
  const startPosition = line.positions[start]
  const endPosition = line.positions[end]
  if (!startPosition || !endPosition) return undefined
  return { start: startPosition, end: endPosition }
}
