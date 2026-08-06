// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_KEYBINDINGS } from '../src/renderer/src/settings/keybindings'
import { SettingsDialog } from '../src/renderer/src/settings/SettingsDialog'
import type { AppSettings } from '../src/renderer/src/settings/settings-model'
import { TerminalThemeGallery } from '../src/renderer/src/settings/TerminalThemeGallery'
import {
  DEFAULT_TERMINAL_THEME_IDS,
  TERMINAL_THEME_SEARCH_RESULT_LIMIT,
} from '../src/renderer/src/terminal/terminal-theme-catalog'

describe('terminal theme gallery', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  it('starts collapsed, then renders a bounded data-only preview set and searches by name', async () => {
    act(() => {
      root.render(
        <TerminalThemeGallery
          lightThemeId={DEFAULT_TERMINAL_THEME_IDS.light}
          darkThemeId={DEFAULT_TERMINAL_THEME_IDS.dark}
          onLightTheme={vi.fn()}
          onDarkTheme={vi.fn()}
        />,
      )
    })

    const gallery = host.querySelector<HTMLDetailsElement>('.terminal-theme-gallery')!
    expect(gallery.open).toBe(false)
    expect(gallery.querySelector('summary')?.textContent).toContain('Ghostty themes')
    expect(gallery.querySelector('summary')?.textContent).toContain('Hvir Dark')
    await openGallery()
    expect(gallery.open).toBe(true)
    expect(host.querySelectorAll('.terminal-theme-results > button')).toHaveLength(
      TERMINAL_THEME_SEARCH_RESULT_LIMIT,
    )
    expect(host.querySelector('canvas')).toBeNull()
    expect(host.textContent).toContain('previews use color data only')

    await searchFor('Catppuccin Mocha')
    expect(host.querySelectorAll('.terminal-theme-results > button')).toHaveLength(1)
    expect(host.textContent).toContain('Catppuccin Mocha')
    expect(host.querySelectorAll('.terminal-theme-swatches i')).toHaveLength(32)
  })

  it('keeps paired choices in the settings draft until Save and discards them on Close', async () => {
    const settings = defaultSettings()
    const onSave = vi.fn()
    const onClose = vi.fn()
    renderSettings(settings, onSave, onClose)

    const darkId = await chooseTheme('Catppuccin Mocha')
    await chooseAppearance('light')
    const lightId = await chooseTheme('Alabaster')
    await clickButton('Close settings')

    expect(onClose).toHaveBeenCalledOnce()
    expect(onSave).not.toHaveBeenCalled()
    expect(settings).toEqual(defaultSettings())

    act(() => root.render(null))
    renderSettings(settings, onSave, onClose)
    expect(host.textContent).toContain('Hvir Dark')
    await chooseTheme('Catppuccin Mocha')
    await chooseAppearance('light')
    await chooseTheme('Alabaster')
    await clickButton('Save app settings')

    expect(onSave).toHaveBeenCalledWith(
      'dark',
      expect.objectContaining({
        terminalDarkThemeId: darkId,
        terminalLightThemeId: lightId,
      }),
    )
  })

  function renderSettings(
    settings: AppSettings,
    onSave: (theme: 'dark' | 'light', settings: AppSettings) => void,
    onClose: () => void,
  ): void {
    act(() => {
      root.render(
        <SettingsDialog
          theme="dark"
          settings={settings}
          onSave={onSave}
          onClose={onClose}
        />,
      )
    })
  }

  async function searchFor(query: string): Promise<void> {
    const search = host.querySelector<HTMLInputElement>(
      '#settings-terminal-theme-search',
    )!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        search,
        query,
      )
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
  }

  async function chooseTheme(name: string): Promise<string> {
    await openGallery()
    await searchFor(name)
    const button = host.querySelector<HTMLButtonElement>(
      `.terminal-theme-results > button[aria-label^="Use ${name} for"]`,
    )!
    expect(button).not.toBeNull()
    const id = button.querySelector('strong')?.textContent
    expect(id).toBe(name)
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    const selected = host.querySelector<HTMLButtonElement>(
      '.terminal-theme-results > button[aria-pressed="true"]',
    )!
    expect(selected).toBe(button)
    return button.dataset.terminalThemeId!
  }

  async function chooseAppearance(appearance: 'dark' | 'light'): Promise<void> {
    const input = host.querySelector<HTMLInputElement>(
      `input[name="terminal-theme-target"][value="${appearance}"]`,
    )!
    await act(async () => {
      input.click()
      await Promise.resolve()
    })
  }

  async function clickButton(label: string): Promise<void> {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    )!
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
  }

  async function openGallery(): Promise<void> {
    const gallery = host.querySelector<HTMLDetailsElement>('.terminal-theme-gallery')!
    if (gallery.open) return
    const summary = gallery.querySelector<HTMLElement>('summary')!
    await act(async () => {
      summary.click()
      await Promise.resolve()
    })
  }
})

function defaultSettings(): AppSettings {
  return {
    idleThresholdMs: 4_000,
    gitAutoFetchIntervalMs: 5 * 60_000,
    terminalRecoveryMode: 'prompt',
    terminalTheme: 'app',
    terminalLightThemeId: DEFAULT_TERMINAL_THEME_IDS.light,
    terminalDarkThemeId: DEFAULT_TERMINAL_THEME_IDS.dark,
    terminalCursorShape: 'block',
    terminalCursorBlink: 'terminal',
    terminalLigatures: true,
    interfaceFont: { mode: 'system', family: '' },
    monospaceFont: { mode: 'system', family: '' },
    interfaceScale: 1,
    terminalTextSize: 13,
    composerSubmitMode: 'enter',
    keybindings: DEFAULT_KEYBINDINGS,
  }
}
