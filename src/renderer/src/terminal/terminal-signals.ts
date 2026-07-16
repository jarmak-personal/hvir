export interface TerminalSignals {
  readonly titles: readonly string[]
  readonly oscillators: readonly TerminalOscSignal[]
  readonly bells: number
}

interface TerminalOscSignal {
  readonly code: number
  readonly data: string
}

const ESC = '\u001b'
const BEL = '\u0007'
const MAX_OSC_CARRY = 64 * 1024

/**
 * Separates real BEL/OSC 9 signals from BEL bytes used only to terminate OSC.
 * ghostty-web's bell hook currently reports both, so hvir inspects the raw PTY
 * stream once at the terminal seam instead.
 */
export class TerminalSignalParser {
  private carry = ''
  private discardingOsc = false
  private discardSawEscape = false

  consume(chunk: string): TerminalSignals {
    const titles: string[] = []
    const oscillators: TerminalOscSignal[] = []
    let bells = 0
    let input = this.carry + chunk
    this.carry = ''
    let cursor = 0

    if (this.discardingOsc) {
      const discarded = discardThroughOscTerminator(input, this.discardSawEscape)
      this.discardSawEscape = discarded.sawEscape
      if (!discarded.terminated) {
        return { titles, oscillators, bells }
      }
      this.discardingOsc = false
      this.discardSawEscape = false
      input = input.slice(discarded.consumed)
    }

    while (cursor < input.length) {
      const start = input.indexOf(`${ESC}]`, cursor)
      if (start < 0) {
        let end = input.length
        if (input.endsWith(ESC)) {
          this.carry = ESC
          end -= 1
        }
        bells += countBells(input.slice(cursor, end))
        break
      }

      bells += countBells(input.slice(cursor, start))
      const bel = input.indexOf(BEL, start + 2)
      const st = input.indexOf(`${ESC}\\`, start + 2)
      const usesBel = bel >= 0 && (st < 0 || bel < st)
      const end = usesBel ? bel : st
      if (end < 0) {
        const incomplete = input.slice(start)
        if (incomplete.length <= MAX_OSC_CARRY) {
          this.carry = incomplete
        } else {
          this.discardingOsc = true
          this.discardSawEscape = incomplete.endsWith(ESC)
        }
        break
      }

      const body = input.slice(start + 2, end)
      const separator = body.indexOf(';')
      const codeText = separator < 0 ? body : body.slice(0, separator)
      const code = Number.parseInt(codeText, 10)
      const payload = separator < 0 ? '' : body.slice(separator + 1)
      if (Number.isFinite(code)) {
        if (code === 0 || code === 2) titles.push(payload)
        else {
          oscillators.push({ code, data: payload })
          if (code === 9) bells += 1
        }
      }
      cursor = end + (usesBel ? 1 : 2)
    }

    return { titles, oscillators, bells }
  }

  reset(): void {
    this.carry = ''
    this.discardingOsc = false
    this.discardSawEscape = false
  }
}

function discardThroughOscTerminator(
  value: string,
  sawEscape: boolean,
): {
  readonly terminated: boolean
  readonly consumed: number
  readonly sawEscape: boolean
} {
  if (sawEscape && value.startsWith('\\')) {
    return { terminated: true, consumed: 1, sawEscape: false }
  }
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === BEL) {
      return { terminated: true, consumed: index + 1, sawEscape: false }
    }
    if (character === ESC && value[index + 1] === '\\') {
      return { terminated: true, consumed: index + 2, sawEscape: false }
    }
  }
  return {
    terminated: false,
    consumed: value.length,
    sawEscape: value.endsWith(ESC),
  }
}

function countBells(value: string): number {
  let count = 0
  for (const character of value) if (character === BEL) count += 1
  return count
}
