import type { ReactElement } from 'react'

import { SettingsSection } from '../SettingsSection'
import type { SettingsDraft, SettingsDraftValidation } from '../settings-draft'

export function TerminalSettings({
  draft,
  validation,
  onChange,
  onComposerSubmitMode,
}: {
  readonly draft: SettingsDraft
  readonly validation?: Exclude<SettingsDraftValidation, { readonly valid: true }>
  readonly onChange: <K extends keyof SettingsDraft>(
    field: K,
    value: SettingsDraft[K],
  ) => void
  readonly onComposerSubmitMode: (enabled: boolean) => void
}): ReactElement {
  const idleError = validation?.fieldId === 'settings-idle-threshold'
  return (
    <SettingsSection
      section="terminal"
      title="Terminal"
      description="Control message submission, attention timing, and startup recovery."
    >
      <div className="settings-section-scroll settings-fields">
        <fieldset className="settings-fieldset">
          <legend>Presentation</legend>
          <label htmlFor="settings-terminal-cursor-shape">
            <span>Cursor shape</span>
            <select
              id="settings-terminal-cursor-shape"
              value={draft.terminalCursorShape}
              onChange={(event) =>
                onChange(
                  'terminalCursorShape',
                  event.currentTarget.value as SettingsDraft['terminalCursorShape'],
                )
              }
            >
              <option value="block">Block</option>
              <option value="hollow-block">Hollow block</option>
              <option value="bar">Bar</option>
              <option value="underline">Underline</option>
            </select>
          </label>
          <label htmlFor="settings-terminal-cursor-blink">
            <span>Cursor blinking</span>
            <span className="settings-checkbox-copy">
              <select
                id="settings-terminal-cursor-blink"
                value={draft.terminalCursorBlink}
                onChange={(event) =>
                  onChange(
                    'terminalCursorBlink',
                    event.currentTarget.value as SettingsDraft['terminalCursorBlink'],
                  )
                }
              >
                <option value="terminal">Terminal-controlled</option>
                <option value="blinking">Blinking default</option>
                <option value="steady">Steady default</option>
              </select>
              <small>
                Applications can still request their own cursor. Terminal-controlled also
                follows the terminal's DEC blinking mode; explicit defaults do not.
              </small>
            </span>
          </label>
          <label htmlFor="settings-terminal-ligatures">
            <span>Font ligatures</span>
            <span className="settings-checkbox-copy">
              <span className="settings-checkbox-control">
                <input
                  id="settings-terminal-ligatures"
                  type="checkbox"
                  checked={draft.terminalLigatures}
                  onChange={(event) =>
                    onChange('terminalLigatures', event.currentTarget.checked)
                  }
                />
                Enable compatible terminal line shaping
              </span>
              <small>
                Shape compatible terminal cells as line runs. Cell positions, selection,
                and copying remain unchanged.
              </small>
            </span>
          </label>
        </fieldset>
        <label className="settings-checkbox">
          <span>Message submission</span>
          <span className="settings-checkbox-copy">
            <span className="settings-checkbox-control">
              <input
                id="settings-composer-submit"
                type="checkbox"
                checked={draft.composerSubmitMode === 'ctrl-enter'}
                onChange={(event) => onComposerSubmitMode(event.currentTarget.checked)}
              />
              Send messages with Ctrl+Enter or Command+Enter; Enter inserts a new line
            </span>
            <small>
              Claude updates live; Shift+Enter also submits in supported external
              terminals. Restart open Codex sessions after changing this setting.
            </small>
          </span>
        </label>
        <label htmlFor="settings-idle-threshold">
          <span>Idle-after-output threshold</span>
          <span className="settings-number">
            <input
              id="settings-idle-threshold"
              type="number"
              min="0.5"
              max="60"
              step="0.5"
              value={draft.idleSeconds}
              aria-invalid={idleError}
              aria-describedby={idleError ? 'settings-idle-threshold-error' : undefined}
              onChange={(event) => onChange('idleSeconds', event.currentTarget.value)}
            />
            seconds
          </span>
          {idleError ? (
            <small id="settings-idle-threshold-error" className="dialog-error">
              {validation.message}
            </small>
          ) : null}
        </label>
        <label htmlFor="settings-recovery-mode">
          <span>On app start</span>
          <select
            id="settings-recovery-mode"
            value={draft.recoveryMode}
            onChange={(event) =>
              onChange(
                'recoveryMode',
                event.currentTarget.value as SettingsDraft['recoveryMode'],
              )
            }
          >
            <option value="prompt">Ask which terminals to restore</option>
            <option value="auto">Restore all terminals automatically</option>
          </select>
        </label>
      </div>
    </SettingsSection>
  )
}
