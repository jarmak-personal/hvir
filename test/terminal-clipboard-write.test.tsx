import { afterEach, describe, expect, it, vi } from 'vitest'

import { MAX_CLIPBOARD_OSC_PAYLOAD } from '../src/renderer/src/terminal/terminal-clipboard-osc'
import { writeClipboardFromOsc } from '../src/renderer/src/terminal/terminal-clipboard-write'

function encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function stubSend() {
  const send = vi.fn()
  vi.stubGlobal('window', { hvir: { send } })
  return send
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('writeClipboardFromOsc', () => {
  it('sends the decoded text, never the encoded payload', () => {
    const send = stubSend()
    const text = 'copied from a remote tmux'

    writeClipboardFromOsc({ selection: 'c', data: encode(text) })

    expect(send).toHaveBeenCalledExactlyOnceWith('terminal:clipboard-write', { text })
  })

  it('does not send a refused selection', () => {
    const send = stubSend()

    writeClipboardFromOsc({ selection: 'p', data: encode('primary only') })

    expect(send).not.toHaveBeenCalled()
  })

  it('does not send a read query', () => {
    const send = stubSend()

    writeClipboardFromOsc({ selection: 'c', data: '?' })

    expect(send).not.toHaveBeenCalled()
  })

  it('does not send an undecodable payload', () => {
    const send = stubSend()

    writeClipboardFromOsc({ selection: 'c', data: 'not base64!' })

    expect(send).not.toHaveBeenCalled()
  })

  it('drops an oversized payload rather than truncating it', () => {
    const send = stubSend()

    writeClipboardFromOsc({
      selection: 'c',
      data: 'A'.repeat(MAX_CLIPBOARD_OSC_PAYLOAD + 4),
    })

    expect(send).not.toHaveBeenCalled()
  })
})
