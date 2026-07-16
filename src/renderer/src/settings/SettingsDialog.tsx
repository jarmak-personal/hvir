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
  const [idleSeconds, setIdleSeconds] = useState(String(settings.idleThresholdMs / 1000))
  const [gitAutoFetchIntervalMs, setGitAutoFetchIntervalMs] = useState(
    String(settings.gitAutoFetchIntervalMs),
  )
  const [recoveryMode, setRecoveryMode] = useState(settings.terminalRecoveryMode)
  const [terminalTheme, setTerminalTheme] = useState(settings.terminalTheme)
  const [keybindings, setKeybindings] = useState(
    keybindingOverridesJson(settings.keybindings),
  )
  const [error, setError] = useState<string>()

  useEffect(() => {
    const frame = requestAnimationFrame(() => dialog.current?.focus())
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !(event.target instanceof HTMLTextAreaElement)) {
        onClose()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown)
    }
  }, [onClose])

  const save = (): void => {
    try {
      const parsedIdleSeconds = Number(idleSeconds)
      if (
        idleSeconds.trim().length === 0 ||
        !Number.isFinite(parsedIdleSeconds) ||
        parsedIdleSeconds < 0.5 ||
        parsedIdleSeconds > 60
      ) {
        throw new Error('Idle threshold must be between 0.5 and 60 seconds')
      }
      const parsed: unknown = JSON.parse(keybindings)
      onSave(nextTheme, {
        idleThresholdMs: parsedIdleSeconds * 1000,
        gitAutoFetchIntervalMs: Number(gitAutoFetchIntervalMs),
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
                aria-invalid={Boolean(error && /idle threshold/i.test(error))}
                onChange={(event) => {
                  setIdleSeconds(event.currentTarget.value)
                  setError(undefined)
                }}
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
          <label>
            <span>Git auto-fetch</span>
            <select
              value={gitAutoFetchIntervalMs}
              onChange={(event) => setGitAutoFetchIntervalMs(event.currentTarget.value)}
            >
              <option value="0">Off</option>
              <option value={String(60_000)}>Every minute</option>
              <option value={String(5 * 60_000)}>Every 5 minutes</option>
              <option value={String(15 * 60_000)}>Every 15 minutes</option>
              <option value={String(30 * 60_000)}>Every 30 minutes</option>
            </select>
          </label>
          <label className="settings-keybindings">
            <span>Keybindings (JSON)</span>
            <textarea
              spellCheck={false}
              value={keybindings}
              onChange={(event) => {
                setKeybindings(event.currentTarget.value)
                setError(undefined)
              }}
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
