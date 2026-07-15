import { describe, expect, it } from 'vitest'

import {
  matchesKeybinding,
  parseKeybindingOverrides,
} from '../src/renderer/src/settings/keybindings'

describe('configurable keybindings', () => {
  it('merges validated overrides with the documented defaults', () => {
    const bindings = parseKeybindingOverrides({ focusTerminal: 'Mod+Alt+T' })
    expect(bindings.focusTerminal).toBe('Mod+Alt+T')
    expect(bindings.cycleViewMode).toBe('Mod+Shift+M')
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
})
