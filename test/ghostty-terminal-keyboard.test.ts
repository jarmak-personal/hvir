import { describe, expect, it } from 'vitest'

import {
  ghosttyKeyboardOverride,
  type GhosttyKeyboardEvent,
  type GhosttyKeyboardOptions,
} from '../src/renderer/src/terminal/ghostty-terminal-keyboard'

function options(
  modifiedKeyProtocol: GhosttyKeyboardOptions['modifiedKeyProtocol'],
  overrides: Partial<GhosttyKeyboardOptions> = {},
): GhosttyKeyboardOptions {
  return {
    modifiedKeyProtocol,
    metaEnterAliasesControl: false,
    composerSubmitMode: 'enter',
    ...overrides,
  }
}

function key(
  code: string,
  modifiers: Partial<Omit<GhosttyKeyboardEvent, 'code'>> = {},
): GhosttyKeyboardEvent {
  return {
    code,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  }
}

describe('ghostty terminal keyboard compatibility', () => {
  it('forwards image-paste chords instead of waiting for text paste', () => {
    expect(ghosttyKeyboardOverride(key('KeyV', { ctrlKey: true }))).toBe('\x16')
    expect(ghosttyKeyboardOverride(key('KeyV', { ctrlKey: true, altKey: true }))).toBe(
      '\x1b\x16',
    )
  })

  it.each([
    ['Tab', '\x1b[Z'],
    ['Home', '\x1b[1;2H'],
    ['End', '\x1b[1;2F'],
    ['Insert', '\x1b[2;2~'],
    ['Delete', '\x1b[3;2~'],
    ['PageUp', '\x1b[5;2~'],
    ['PageDown', '\x1b[6;2~'],
    ['F1', '\x1b[1;2P'],
    ['F2', '\x1b[1;2Q'],
    ['F3', '\x1b[13;2~'],
    ['F4', '\x1b[1;2S'],
    ['F5', '\x1b[15;2~'],
    ['F6', '\x1b[17;2~'],
    ['F7', '\x1b[18;2~'],
    ['F8', '\x1b[19;2~'],
    ['F9', '\x1b[20;2~'],
    ['F10', '\x1b[21;2~'],
    ['F11', '\x1b[23;2~'],
    ['F12', '\x1b[24;2~'],
  ])('preserves Shift on %s', (code, sequence) => {
    expect(ghosttyKeyboardOverride(key(code, { shiftKey: true }))).toBe(sequence)
  })

  it.each([
    ['Enter', '\x1b[27;2;13~'],
    ['Escape', '\x1b[27;2;27~'],
  ])('uses modifyOtherKeys for compatible harnesses on Shift+%s', (code, sequence) => {
    const event = key(code, { shiftKey: true })
    expect(ghosttyKeyboardOverride(event)).toBeUndefined()
    expect(ghosttyKeyboardOverride(event, options('modify-other-keys'))).toBe(
      sequence,
    )
  })

  it.each([
    [{ shiftKey: true }, '\x1b[13;2u'],
    [{ altKey: true }, '\x1b[13;3u'],
    [{ ctrlKey: true }, '\x1b[13;5u'],
    [{ ctrlKey: true, shiftKey: true }, '\x1b[13;6u'],
    [{ metaKey: true }, '\x1b[13;9u'],
  ])('uses CSI-u for Codex modified Enter %#', (modifiers, sequence) => {
    expect(
      ghosttyKeyboardOverride(key('Enter', modifiers), options('csi-u')),
    ).toBe(sequence)
  })

  it('aliases Command+Enter to Codex Ctrl+Enter only in intentional-submit mode', () => {
    const commandEnter = key('Enter', { metaKey: true })
    expect(
      ghosttyKeyboardOverride(
        commandEnter,
        options('csi-u', {
          metaEnterAliasesControl: true,
          composerSubmitMode: 'ctrl-enter',
        }),
      ),
    ).toBe('\x1b[13;5u')
    expect(
      ghosttyKeyboardOverride(
        commandEnter,
        options('csi-u', { metaEnterAliasesControl: true }),
      ),
    ).toBe('\x1b[13;9u')
    expect(
      ghosttyKeyboardOverride(
        commandEnter,
        options('csi-u', { composerSubmitMode: 'ctrl-enter' }),
      ),
    ).toBe('\x1b[13;9u')
  })

  it('uses CSI-u for Codex modified Escape', () => {
    expect(
      ghosttyKeyboardOverride(
        key('Escape', { shiftKey: true }),
        options('csi-u'),
      ),
    ).toBe('\x1b[27;2u')
  })

  it('leaves ordinary paste and unrelated keys to the terminal engine', () => {
    expect(ghosttyKeyboardOverride(key('KeyV', { metaKey: true }))).toBeUndefined()
    expect(
      ghosttyKeyboardOverride(key('KeyV', { ctrlKey: true, shiftKey: true })),
    ).toBeUndefined()
    expect(ghosttyKeyboardOverride(key('Enter'))).toBeUndefined()
    expect(ghosttyKeyboardOverride(key('ArrowUp', { shiftKey: true }))).toBeUndefined()
    expect(ghosttyKeyboardOverride(key('Backspace', { shiftKey: true }))).toBeUndefined()
  })
})
