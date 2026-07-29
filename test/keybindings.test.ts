import { describe, expect, it } from 'vitest'

import {
  keybindingAvailableInContext,
  matchesKeybinding,
  parseKeybindingOverrides,
} from '../src/renderer/src/settings/keybindings'

describe('configurable keybindings', () => {
  it('merges validated overrides with the documented defaults', () => {
    const bindings = parseKeybindingOverrides({ focusTerminal: 'Mod+Alt+T' })
    expect(bindings.focusTerminal).toBe('Mod+Alt+T')
    expect(bindings.cycleViewMode).toBe('Mod+Shift+M')
    expect(bindings.findInFile).toBe('Mod+F')
    expect(bindings.goToLine).toBe('Ctrl+G')
  })

  it('keeps viewer navigation out of terminal and web-pane input', () => {
    expect(keybindingAvailableInContext('goToLine', 'workbench')).toBe(true)
    expect(keybindingAvailableInContext('findInFile', 'workbench')).toBe(true)
    expect(keybindingAvailableInContext('findInFile', 'terminal')).toBe(false)
    expect(keybindingAvailableInContext('findInFile', 'web-pane')).toBe(false)
    expect(keybindingAvailableInContext('goToLine', 'terminal')).toBe(false)
    expect(keybindingAvailableInContext('goToLine', 'web-pane')).toBe(false)
    expect(keybindingAvailableInContext('cycleViewMode', 'web-pane')).toBe(true)
  })

  it('uses Ctrl+G rather than Command+G on macOS', () => {
    const stroke = {
      key: 'g',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }
    expect(matchesKeybinding(stroke, 'Ctrl+G', true)).toBe(true)
    expect(
      matchesKeybinding({ ...stroke, ctrlKey: false, metaKey: true }, 'Ctrl+G', true),
    ).toBe(false)
  })

  it('rejects unknown actions and malformed chords', () => {
    expect(() => parseKeybindingOverrides({ launchMissiles: 'Mod+M' })).toThrow(
      'Unknown keybinding action',
    )
    expect(() => parseKeybindingOverrides({ focusTree: 'Hyper+T' })).toThrow(
      'Invalid keybinding',
    )
  })

  it('maps Mod to the platform primary modifier and requires exact modifiers', () => {
    const event = {
      key: 'm',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: true,
    }
    expect(matchesKeybinding(event, 'Mod+Shift+M', true)).toBe(true)
    expect(matchesKeybinding({ ...event, altKey: true }, 'Mod+Shift+M', true)).toBe(false)
    expect(
      matchesKeybinding(
        { ...event, ctrlKey: true, metaKey: false },
        'Mod+Shift+M',
        false,
      ),
    ).toBe(true)
  })

  it('matches bracket chords by physical key when macOS Option changes event.key', () => {
    const event = {
      key: '’',
      code: 'BracketRight',
      ctrlKey: false,
      metaKey: true,
      altKey: true,
      shiftKey: false,
    }
    expect(matchesKeybinding(event, 'Mod+Alt+]', true)).toBe(true)
    expect(matchesKeybinding({ ...event, code: 'BracketLeft' }, 'Mod+Alt+]', true)).toBe(
      false,
    )
  })
})
