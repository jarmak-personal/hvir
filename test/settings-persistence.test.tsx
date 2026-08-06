// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_KEYBINDINGS } from '../src/renderer/src/settings/keybindings'

describe('app settings typography persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('style')
    vi.resetModules()
  })

  it('normalizes existing records and invalid typography to safe system defaults', async () => {
    localStorage.setItem(
      'hvir:settings:v1',
      JSON.stringify({
        idleThresholdMs: 7_000,
        interfaceFont: { mode: 'custom', family: '' },
        monospaceFont: { mode: 'custom', family: 'One, Two' },
        interfaceScale: 'large',
        terminalTextSize: -20,
      }),
    )

    const settings = await import('../src/renderer/src/settings/settings')
    expect(settings.getAppSettings()).toMatchObject({
      idleThresholdMs: 7_000,
      terminalLightThemeId: 'hvir-default-light',
      terminalDarkThemeId: 'hvir-default-dark',
      terminalCursorShape: 'block',
      terminalCursorBlink: 'terminal',
      terminalLigatures: true,
      interfaceFont: { mode: 'system', family: '' },
      monospaceFont: { mode: 'system', family: '' },
      interfaceScale: 1,
      terminalTextSize: 10,
    })
  })

  it('persists saved typography across a module restart and applies its CSS tokens', async () => {
    const first = await import('../src/renderer/src/settings/settings')
    first.initializeAppSettings(document.documentElement.style)
    first.setAppSettings({
      idleThresholdMs: 4_000,
      gitAutoFetchIntervalMs: 5 * 60_000,
      terminalRecoveryMode: 'prompt',
      terminalTheme: 'app',
      terminalLightThemeId: 'hvir-default-light',
      terminalDarkThemeId: 'hvir-default-dark',
      terminalCursorShape: 'bar',
      terminalCursorBlink: 'steady',
      terminalLigatures: false,
      interfaceFont: { mode: 'custom', family: 'Example Sans' },
      monospaceFont: { mode: 'custom', family: 'Example Mono' },
      interfaceScale: 1.25,
      terminalTextSize: 18,
      composerSubmitMode: 'enter',
      keybindings: DEFAULT_KEYBINDINGS,
    })

    expect(
      document.documentElement.style.getPropertyValue('--hvir-interface-font'),
    ).toMatch(/^"Example Sans".*sans-serif$/)
    expect(
      document.documentElement.style.getPropertyValue('--hvir-monospace-font'),
    ).toMatch(/^"Example Mono".*monospace$/)
    expect(
      document.documentElement.style.getPropertyValue('--hvir-interface-scale'),
    ).toBe('1.25')

    vi.resetModules()
    const restarted = await import('../src/renderer/src/settings/settings')
    restarted.initializeAppSettings(document.documentElement.style)
    expect(restarted.getAppSettings()).toMatchObject({
      terminalLightThemeId: 'hvir-default-light',
      terminalDarkThemeId: 'hvir-default-dark',
      terminalCursorShape: 'bar',
      terminalCursorBlink: 'steady',
      terminalLigatures: false,
      interfaceFont: { mode: 'custom', family: 'Example Sans' },
      monospaceFont: { mode: 'custom', family: 'Example Mono' },
      interfaceScale: 1.25,
      terminalTextSize: 18,
    })
    const preferences = restarted.terminalPreferences(restarted.getAppSettings())
    expect(preferences.terminalTypography.fontFamily).toMatch(
      /^"Example Mono".*monospace$/,
    )
    expect(preferences.terminalTypography.fontSize).toBe(18)
    expect(preferences.terminalCursorDefaults).toEqual({
      shape: 'bar',
      blink: 'steady',
    })
    expect(preferences.terminalLigatures).toBe(false)
  })

  it.each(['app', 'dark', 'light'] as const)(
    'migrates legacy terminalTheme=%s to separate visually identical defaults',
    async (terminalTheme) => {
      localStorage.setItem(
        'hvir:settings:v1',
        JSON.stringify({
          terminalTheme,
          idleThresholdMs: 4_000,
        }),
      )

      const settings = await import('../src/renderer/src/settings/settings')
      expect(settings.getAppSettings()).toMatchObject({
        terminalTheme,
        terminalLightThemeId: 'hvir-default-light',
        terminalDarkThemeId: 'hvir-default-dark',
      })
      expect(settings.terminalPreferences(settings.getAppSettings())).toMatchObject({
        terminalTheme,
        terminalLightThemeId: 'hvir-default-light',
        terminalDarkThemeId: 'hvir-default-dark',
      })
    },
  )

  it('persists paired selections across a module restart and normalizes removed IDs', async () => {
    const catalog = await import('../src/renderer/src/terminal/terminal-theme-catalog')
    const dark = catalog.searchTerminalThemes('Catppuccin Mocha').entries[0]!
    const light = catalog.searchTerminalThemes('Alabaster').entries[0]!
    const first = await import('../src/renderer/src/settings/settings')
    first.setAppSettings({
      ...first.getAppSettings(),
      terminalTheme: 'app',
      terminalLightThemeId: light.id,
      terminalDarkThemeId: dark.id,
    })

    vi.resetModules()
    const restarted = await import('../src/renderer/src/settings/settings')
    expect(restarted.getAppSettings()).toMatchObject({
      terminalLightThemeId: light.id,
      terminalDarkThemeId: dark.id,
    })

    localStorage.setItem(
      'hvir:settings:v1',
      JSON.stringify({
        ...restarted.getAppSettings(),
        terminalLightThemeId: 'removed-light',
        terminalDarkThemeId: 'removed-dark',
      }),
    )
    vi.resetModules()
    const normalized = await import('../src/renderer/src/settings/settings')
    expect(normalized.getAppSettings()).toMatchObject({
      terminalLightThemeId: 'hvir-default-light',
      terminalDarkThemeId: 'hvir-default-dark',
    })
  })

  it('normalizes invalid stored presentation values without preserving engine values', async () => {
    localStorage.setItem(
      'hvir:settings:v1',
      JSON.stringify({
        terminalCursorShape: 'block_hollow',
        terminalCursorBlink: true,
        terminalLigatures: 'off',
      }),
    )

    const settings = await import('../src/renderer/src/settings/settings')
    expect(settings.getAppSettings()).toMatchObject({
      terminalCursorShape: 'block',
      terminalCursorBlink: 'terminal',
      terminalLigatures: true,
    })
    expect(settings.terminalPreferences(settings.getAppSettings())).toMatchObject({
      terminalCursorDefaults: { shape: 'block', blink: 'terminal' },
      terminalLigatures: true,
    })
  })
})
