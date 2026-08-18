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
  terminalLightThemeId: 'hvir-default-light',
  terminalDarkThemeId: 'hvir-default-dark',
  terminalCursorShape: 'block' as const,
  terminalCursorBlink: 'terminal' as const,
  terminalLigatures: true,
  highlightSubmittedInput: true,
  interfaceFont: { mode: 'system' as const, family: '' },
  monospaceFont: { mode: 'system' as const, family: '' },
  interfaceScale: 1,
  terminalTextSize: 13,
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

  it('routes invalid text presentation bounds to their Appearance controls', () => {
    expect(
      validateSettingsDraft({
        ...createSettingsDraft('dark', settings),
        interfaceScale: '2',
      }),
    ).toMatchObject({
      valid: false,
      section: 'appearance',
      fieldId: 'settings-interface-scale',
    })
    expect(
      validateSettingsDraft({
        ...createSettingsDraft('dark', settings),
        terminalTextSize: '9',
      }),
    ).toMatchObject({
      valid: false,
      section: 'appearance',
      fieldId: 'settings-terminal-text-size',
    })
  })

  it('falls back from blank or invalid custom font families when saving', () => {
    const result = validateSettingsDraft({
      ...createSettingsDraft('dark', settings),
      interfaceFontMode: 'custom',
      interfaceFontFamily: '   ',
      monospaceFontMode: 'custom',
      monospaceFontFamily: 'One, Two',
    })

    expect(result).toMatchObject({
      valid: true,
      settings: {
        interfaceFont: { mode: 'system', family: '' },
        monospaceFont: { mode: 'system', family: '' },
      },
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
