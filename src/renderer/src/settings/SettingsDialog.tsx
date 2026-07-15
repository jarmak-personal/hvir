import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { AppTheme } from '../theme'
import { keybindingOverridesJson, parseKeybindingOverrides } from './keybindings'
import type { AppSettings } from './settings'

interface SettingsDialogProps {
  readonly theme: AppTheme
  readonly settings: AppSettings
  readonly onSave: (theme: AppTheme, settings: AppSettings) => void
  readonly onClose: () => void
}

export function SettingsDialog({
  theme,
  settings,
  onSave,
  onClose,
}: SettingsDialogProps): ReactElement {
  const dialog = useRef<HTMLElement>(null)
  const [nextTheme, setNextTheme] = useState(theme)
  const [idleSeconds, setIdleSeconds] = useState(settings.idleThresholdMs / 1000)
  const [recoveryMode, setRecoveryMode] = useState(settings.terminalRecoveryMode)
  const [terminalTheme, setTerminalTheme] = useState(settings.terminalTheme)
  const [keybindings, setKeybindings] = useState(
    keybindingOverridesJson(settings.keybindings),
  )
  const [error, setError] = useState<string>()

  useEffect(() => {
    const frame = requestAnimationFrame(() => dialog.current?.focus())
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', keydown)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown)
    }
  }, [onClose])

  const save = (): void => {
    try {
      const parsed: unknown = JSON.parse(keybindings)
      onSave(nextTheme, {
        idleThresholdMs: idleSeconds * 1000,
        terminalRecoveryMode: recoveryMode,
        terminalTheme,
        keybindings: parseKeybindingOverrides(parsed),
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <div className="modal-backdrop">
      <section
        className="project-dialog settings-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
      >
        <h2 id="settings-title">Settings</h2>
        <div className="settings-fields">
          <label>
            <span>App theme</span>
            <select
              value={nextTheme}
              onChange={(event) => setNextTheme(event.currentTarget.value as AppTheme)}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label>
            <span>Terminal colors</span>
            <select
              value={terminalTheme}
              onChange={(event) =>
                setTerminalTheme(
                  event.currentTarget.value as AppSettings['terminalTheme'],
                )
              }
            >
              <option value="app">Follow app theme</option>
              <option value="dark">Always dark</option>
              <option value="light">Always light</option>
            </select>
          </label>
          <label>
            <span>Idle-after-output threshold</span>
            <span className="settings-number">
              <input
                type="number"
                min="0.5"
                max="60"
                step="0.5"
                value={idleSeconds}
                onChange={(event) => setIdleSeconds(event.currentTarget.valueAsNumber)}
              />
              seconds
            </span>
          </label>
          <label>
            <span>On app start</span>
            <select
              value={recoveryMode}
              onChange={(event) =>
                setRecoveryMode(
                  event.currentTarget.value as AppSettings['terminalRecoveryMode'],
                )
              }
            >
              <option value="prompt">Ask which terminals to restore</option>
              <option value="auto">Restore all terminals automatically</option>
            </select>
          </label>
          <label className="settings-keybindings">
            <span>Keybindings (JSON)</span>
            <textarea
              spellCheck={false}
              value={keybindings}
              onChange={(event) => setKeybindings(event.currentTarget.value)}
            />
            <small>
              Use Mod for Command on macOS and Ctrl on Linux. Changes apply after Save.
            </small>
          </label>
        </div>
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={save}>
            Save
          </button>
        </div>
      </section>
    </div>
  )
}
