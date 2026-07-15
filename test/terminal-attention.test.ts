import { describe, expect, it } from 'vitest'

import {
  nextTerminalAttention,
  terminalAttentionLabel,
  terminalAttentionRollup,
  terminalIdleAttentionAfterInput,
  terminalInputArmsIdleAttention,
  terminalOutputAttentionDecision,
} from '../src/renderer/src/terminal/terminal-attention'

describe('terminal attention', () => {
  it('suppresses every signal while the terminal is focused', () => {
    expect(nextTerminalAttention(undefined, 'output', true)).toBeUndefined()
    expect(nextTerminalAttention(undefined, 'bell', true)).toBeUndefined()
    expect(nextTerminalAttention(undefined, 'idle', true)).toBeUndefined()
    expect(nextTerminalAttention('idle', 'bell', true)).toBeUndefined()
  })

  it('raises background output, bell, and idle notifications', () => {
    expect(nextTerminalAttention(undefined, 'output', false)).toBe('output')
    expect(nextTerminalAttention(undefined, 'bell', false)).toBe('bell')
    expect(nextTerminalAttention(undefined, 'idle', false)).toBe('idle')
  })

  it('keeps the highest-priority unseen signal', () => {
    expect(nextTerminalAttention('output', 'bell', false)).toBe('bell')
    expect(nextTerminalAttention('bell', 'output', false)).toBe('bell')
    expect(nextTerminalAttention('bell', 'idle', false)).toBe('idle')
    expect(nextTerminalAttention('idle', 'bell', false)).toBe('idle')
  })

  it('labels signals without relying on color and aggregates distinct terminals', () => {
    expect(terminalAttentionLabel('output')).toBe('New output')
    expect(terminalAttentionLabel('bell')).toBe('Bell')
    expect(terminalAttentionLabel('idle')).toBe('Ready')
    expect(terminalAttentionRollup(['output', 'bell', 'idle', undefined])).toEqual({
      unseen: 3,
      actionable: 2,
    })
  })

  it('arms idle-after-burst only at a submitted terminal-input boundary', () => {
    expect(terminalInputArmsIdleAttention('hello')).toBe(false)
    expect(terminalInputArmsIdleAttention('\u001b[A')).toBe(false)
    expect(terminalInputArmsIdleAttention('\r')).toBe(true)
    expect(terminalInputArmsIdleAttention('prompt\n')).toBe(true)
  })

  it('ignores startup output and raises Ready only once per submitted turn', () => {
    let state = terminalIdleAttentionAfterInput('initial', 'typing')
    expect(state).toBe('initial')
    expect(terminalOutputAttentionDecision(state)).toEqual({
      notify: false,
      scheduleIdle: false,
    })

    state = terminalIdleAttentionAfterInput(state, '\r')
    expect(terminalOutputAttentionDecision(state)).toEqual({
      notify: true,
      scheduleIdle: true,
    })

    state = 'settled'
    expect(terminalOutputAttentionDecision(state)).toEqual({
      notify: true,
      scheduleIdle: false,
    })
    expect(terminalIdleAttentionAfterInput(state, '\n')).toBe('armed')
  })
})
