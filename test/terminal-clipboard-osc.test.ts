import { describe, expect, it } from 'vitest'

import {
  MAX_CLIPBOARD_OSC_PAYLOAD,
  decodeClipboardOsc,
} from '../src/renderer/src/terminal/terminal-clipboard-osc'

const ESC = '\x1b'
const NUL = '\x00'
const BEL = '\x07'

function encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function write(data: string, selection = 'c') {
  return { selection, data }
}

describe('OSC 52 clipboard decoding', () => {
  it('decodes the base64 payload rather than passing it through', () => {
    // The engine parses the escape sequence but leaves the payload encoded.
    // Forwarding it unchanged put base64 on the clipboard instead of the text.
    const text = 'git switch feat/osc'
    const payload = encode(text)

    const decision = decodeClipboardOsc(write(payload))

    expect(decision).toEqual({ kind: 'write', text, removedControls: 0 })
    expect(decision).not.toMatchObject({ text: payload })
  })

  it('decodes multi-byte UTF-8 payloads', () => {
    expect(decodeClipboardOsc(write(encode('héllo ✓ 世界')))).toEqual({
      kind: 'write',
      text: 'héllo ✓ 世界',
      removedControls: 0,
    })
  })

  it('treats an empty selection as the clipboard and honors multi-target selections', () => {
    expect(decodeClipboardOsc(write(encode('empty selection'), ''))).toEqual({
      kind: 'write',
      text: 'empty selection',
      removedControls: 0,
    })
    expect(decodeClipboardOsc(write(encode('both targets'), 'pc'))).toEqual({
      kind: 'write',
      text: 'both targets',
      removedControls: 0,
    })
  })

  it('refuses a clipboard read query so a remote host cannot exfiltrate the clipboard', () => {
    expect(decodeClipboardOsc(write('?'))).toEqual({
      kind: 'refused',
      reason: 'query-refused',
    })
    expect(decodeClipboardOsc(write('?', ''))).toEqual({
      kind: 'refused',
      reason: 'query-refused',
    })
  })

  it('refuses selections that are not the system clipboard', () => {
    for (const selection of ['p', 'q', '0']) {
      expect(decodeClipboardOsc(write(encode('other target'), selection))).toEqual({
        kind: 'refused',
        reason: 'unsupported-selection',
      })
    }
  })

  it('refuses payloads that are not strict base64', () => {
    for (const payload of ['not base64!', 'YWJj=ZGVm', 'YWJjZA=', 'YWJ j', 'YWJ!', 'YW=J']) {
      expect(decodeClipboardOsc(write(payload))).toEqual({
        kind: 'refused',
        reason: 'invalid-base64',
      })
    }
  })

  it('refuses payloads that do not decode as UTF-8 text', () => {
    expect(decodeClipboardOsc(write('//4='))).toEqual({
      kind: 'refused',
      reason: 'invalid-text',
    })
  })

  it('refuses an empty payload rather than letting a remote host clear the clipboard', () => {
    expect(decodeClipboardOsc(write(''))).toEqual({ kind: 'refused', reason: 'empty' })
  })

  it('bounds the payload a remote host can place on the clipboard', () => {
    const oversized = 'A'.repeat(MAX_CLIPBOARD_OSC_PAYLOAD + 4)
    expect(decodeClipboardOsc(write(oversized))).toEqual({
      kind: 'refused',
      reason: 'oversized',
    })

    const atLimit = encode('x'.repeat(1024))
    expect(atLimit.length).toBeLessThan(MAX_CLIPBOARD_OSC_PAYLOAD)
    expect(decodeClipboardOsc(write(atLimit))).toEqual({
      kind: 'write',
      text: 'x'.repeat(1024),
      removedControls: 0,
    })
  })

  it('strips control characters that would execute when pasted into a shell', () => {
    expect(decodeClipboardOsc(write(encode('rm -rf /\rwhoami')))).toEqual({
      kind: 'write',
      text: 'rm -rf /whoami',
      removedControls: 1,
    })
    expect(decodeClipboardOsc(write(encode(`${ESC}[31mred${ESC}[0m`)))).toEqual({
      kind: 'write',
      text: '[31mred[0m',
      removedControls: 2,
    })
  })

  it('keeps newlines and tabs, which carry meaning in copied terminal text', () => {
    expect(decodeClipboardOsc(write(encode('one\ttwo\nthree\n')))).toEqual({
      kind: 'write',
      text: 'one\ttwo\nthree\n',
      removedControls: 0,
    })
  })

  it('refuses a payload that is only control characters', () => {
    expect(decodeClipboardOsc(write(encode(`${NUL}${BEL}`)))).toEqual({
      kind: 'refused',
      reason: 'empty',
    })
  })
})
