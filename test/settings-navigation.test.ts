import { describe, expect, it } from 'vitest'

import {
  addHarnessSettingsDestination,
  SETTINGS_SECTIONS,
  settingsDestination,
} from '../src/renderer/src/settings/settings-navigation'

describe('settings navigation policy', () => {
  it('exposes the fixed visible information architecture', () => {
    expect(SETTINGS_SECTIONS.map(({ id }) => id)).toEqual([
      'appearance',
      'terminal',
      'git',
      'keybindings',
      'harnesses',
    ])
  })

  it('keeps add-harness as an intent rather than another section', () => {
    expect(settingsDestination('harnesses')).toEqual({ section: 'harnesses' })
    expect(addHarnessSettingsDestination()).toEqual({
      section: 'harnesses',
      intent: 'add-harness',
    })
  })
})
