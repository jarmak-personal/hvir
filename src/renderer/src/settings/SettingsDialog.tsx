import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import type { AppTheme } from '../theme'
import type { HostPath } from '../../../shared'
import {
  HarnessProfilesSettings,
  type HarnessProfilesSettingsHandle,
} from './HarnessProfilesSettings'
import { keybindingOverridesJson, parseKeybindingOverrides } from './keybindings'
import type { AppSettings } from './settings'

interface SettingsDialogProps {
  readonly theme: AppTheme
  readonly settings: AppSettings
  readonly onSave: (theme: AppTheme, settings: AppSettings) => void
  readonly onClose: () => void
  readonly workspaceRoot?: HostPath
  readonly projectRoot?: HostPath
  readonly initialSection?: 'general' | 'harnesses' | 'harnesses-add'
}

export function SettingsDialog({
  theme,
  settings,
  onSave,
  onClose,
  workspaceRoot,
  projectRoot,
  initialSection = 'general',
}: SettingsDialogProps): ReactElement {
  const dialog = useRef<HTMLElement>(null)
  const harnessProfiles = useRef<HarnessProfilesSettingsHandle>(null)
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

  const requestClose = useCallback((): void => {
    void (harnessProfiles.current?.confirmSafeToLeave() ?? Promise.resolve(true)).then(
      (confirmed) => {
        if (confirmed) onClose()
      },
    )
  }, [onClose])

  useEffect(() => {
    let frame = 0
    let sectionObserver: ResizeObserver | undefined
    const alignHarnesses = (): boolean => {
      const heading = document.getElementById('settings-harnesses-title')
      const container = dialog.current
      if (!heading || !container) return false
      const containerBox = container.getBoundingClientRect()
      const headingBox = heading.getBoundingClientRect()
      const paddingTop = Number.parseFloat(getComputedStyle(container).paddingTop) || 0
      container.scrollTop = Math.max(
        0,
        container.scrollTop + headingBox.top - containerBox.top - paddingTop,
      )
      heading.focus({ preventScroll: true })
      return (
        Math.abs(heading.getBoundingClientRect().top - containerBox.top - paddingTop) <= 2
      )
    }
    const scheduleAlignment = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (alignHarnesses()) sectionObserver?.disconnect()
      })
    }
    frame = requestAnimationFrame(() => {
      if (initialSection !== 'general') {
        const heading = document.getElementById('settings-harnesses-title')
        const section = heading?.closest('.settings-harnesses')
        if (section && !alignHarnesses()) {
          sectionObserver = new ResizeObserver(scheduleAlignment)
          sectionObserver.observe(section)
        }
      } else {
        dialog.current?.focus()
      }
    })
    const keydown = (event: KeyboardEvent): void => {
      if (dialog.current?.querySelector('.modal-backdrop.nested')) return
      if (event.key === 'Escape' && !(event.target instanceof HTMLTextAreaElement)) {
        requestClose()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      cancelAnimationFrame(frame)
      sectionObserver?.disconnect()
      window.removeEventListener('keydown', keydown)
    }
  }, [initialSection, requestClose])

  const save = async (): Promise<void> => {
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
      const confirmed = await (harnessProfiles.current?.confirmSafeToLeave() ??
        Promise.resolve(true))
      if (!confirmed) return
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
        className={`project-dialog settings-dialog${
          initialSection === 'general' ? '' : ' harnesses-focused'
        }`}
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
        <HarnessProfilesSettings
          ref={harnessProfiles}
          workspaceRoot={workspaceRoot}
          projectRoot={projectRoot}
          initialAddOpen={initialSection === 'harnesses-add'}
        />
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={requestClose}>
            Close settings
          </button>
          <button type="button" onClick={() => void save()}>
            Save app settings
          </button>
        </div>
      </section>
    </div>
  )
}
