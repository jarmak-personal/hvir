import { describe, expect, it } from 'vitest'

import {
  createSettingsDraft,
  validateSettingsDraft,
} from '../src/renderer/src/settings/settings-draft'
import { DEFAULT_KEYBINDINGS } from '../src/shared'

const settings = {
  idleThresholdMs: 4_000,
  gitAutoFetchIntervalMs: 5 * 60_000,
  terminalRecoveryMode: 'prompt' as const,
  terminalTheme: 'app' as const,
  composerSubmitMode: 'enter' as const,
  keybindings: DEFAULT_KEYBINDINGS,
}

describe('settings draft validation', () => {
  it('builds the complete app settings value from one cross-section draft', () => {
    const result = validateSettingsDraft(createSettingsDraft('dark', settings))
    expect(result).toEqual({ valid: true, theme: 'dark', settings })
  })

  it('routes an invalid idle threshold to its Terminal control', () => {
    const draft = { ...createSettingsDraft('dark', settings), idleSeconds: '' }
    expect(validateSettingsDraft(draft)).toMatchObject({
      valid: false,
      section: 'terminal',
      fieldId: 'settings-idle-threshold',
    })
  })

  it('routes invalid JSON to its Keybindings control', () => {
    const draft = { ...createSettingsDraft('dark', settings), keybindingsJson: '{' }
    expect(validateSettingsDraft(draft)).toMatchObject({
      valid: false,
      section: 'keybindings',
      fieldId: 'settings-keybindings-json',
    })
  })
})
