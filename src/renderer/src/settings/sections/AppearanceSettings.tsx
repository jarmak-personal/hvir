import type { ReactElement } from 'react'

import type { AppTheme } from '../../theme'
import { SettingsSection } from '../SettingsSection'
import type { SettingsDraft } from '../settings-draft'
import {
  fontFamilyStack,
  MAX_INTERFACE_SCALE,
  MAX_TERMINAL_TEXT_SIZE,
  MIN_INTERFACE_SCALE,
  MIN_TERMINAL_TEXT_SIZE,
  normalizeFontPreference,
} from '../typography-settings'
import { RichOutputPreview } from './RichOutputPreview'
import { TypographyFontField } from './TypographyFontField'

export function AppearanceSettings({
  draft,
  onChange,
}: {
  readonly draft: SettingsDraft
  readonly onChange: <K extends keyof SettingsDraft>(
    field: K,
    value: SettingsDraft[K],
  ) => void
}): ReactElement {
  const previewScale = Number(draft.interfaceScale)
  const interfacePreviewScale = Number.isFinite(previewScale) ? previewScale : 1
  const previewTerminalTextSize = Number(draft.terminalTextSize)
  const terminalPreviewFontFamily = fontFamilyStack(
    normalizeFontPreference({
      mode: draft.monospaceFontMode,
      family: draft.monospaceFontFamily,
    }),
    'monospace',
  )
  const terminalPreviewFontSize = Number.isFinite(previewTerminalTextSize)
    ? previewTerminalTextSize
    : 13
  return (
    <SettingsSection
      section="appearance"
      title="Appearance"
      description="Choose how the workbench and its terminals present your workspace."
    >
      <div className="settings-section-scroll settings-fields">
        <label htmlFor="settings-app-theme">
          <span>App theme</span>
          <select
            id="settings-app-theme"
            value={draft.theme}
            onChange={(event) => onChange('theme', event.currentTarget.value as AppTheme)}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label htmlFor="settings-terminal-theme">
          <span>Terminal colors</span>
          <select
            id="settings-terminal-theme"
            value={draft.terminalTheme}
            onChange={(event) =>
              onChange(
                'terminalTheme',
                event.currentTarget.value as SettingsDraft['terminalTheme'],
              )
            }
          >
            <option value="app">Follow app theme</option>
            <option value="dark">Always dark</option>
            <option value="light">Always light</option>
          </select>
        </label>
        <label className="settings-checkbox">
          <span>Agent responses</span>
          <span className="settings-checkbox-copy">
            <span className="settings-checkbox-control">
              <input
                id="settings-rich-output"
                type="checkbox"
                checked={draft.richOutput}
                onChange={(event) =>
                  onChange('richOutput', event.currentTarget.checked)
                }
              />
              Rich output
            </span>
            <small>
              Present supported agent responses as formatted Markdown while keeping the
              native terminal interactive.
            </small>
          </span>
        </label>
        {draft.richOutput ? (
          <div className="settings-rich-output-preview-field">
            <span>Preview</span>
            <RichOutputPreview
              fontFamily={terminalPreviewFontFamily}
              fontSize={terminalPreviewFontSize}
            />
          </div>
        ) : null}
        <TypographyFontField
          id="settings-interface-font"
          label="Interface font"
          kind="interface"
          mode={draft.interfaceFontMode}
          family={draft.interfaceFontFamily}
          previewText="Harness · View · Interact · Respond"
          previewSize={`calc(14px * ${interfacePreviewScale})`}
          onMode={(mode) => onChange('interfaceFontMode', mode)}
          onFamily={(family) => onChange('interfaceFontFamily', family)}
        />
        <TypographyFontField
          id="settings-monospace-font"
          label="Monospace font"
          kind="monospace"
          mode={draft.monospaceFontMode}
          family={draft.monospaceFontFamily}
          previewText="const hvir = ['view', 'terminal', 'git']"
          previewSize={`${Number.isFinite(previewTerminalTextSize) ? previewTerminalTextSize : 13}px`}
          onMode={(mode) => onChange('monospaceFontMode', mode)}
          onFamily={(family) => onChange('monospaceFontFamily', family)}
        />
        <label htmlFor="settings-interface-scale">
          <span>Interface scale</span>
          <span className="settings-slider">
            <input
              id="settings-interface-scale"
              type="range"
              min={MIN_INTERFACE_SCALE}
              max={MAX_INTERFACE_SCALE}
              step="0.05"
              value={draft.interfaceScale}
              onChange={(event) => onChange('interfaceScale', event.currentTarget.value)}
            />
            <output htmlFor="settings-interface-scale">
              {Math.round(interfacePreviewScale * 100)}%
            </output>
          </span>
        </label>
        <label htmlFor="settings-terminal-text-size">
          <span>Terminal text size</span>
          <span className="settings-slider">
            <input
              id="settings-terminal-text-size"
              type="range"
              min={MIN_TERMINAL_TEXT_SIZE}
              max={MAX_TERMINAL_TEXT_SIZE}
              step="1"
              value={draft.terminalTextSize}
              onChange={(event) =>
                onChange('terminalTextSize', event.currentTarget.value)
              }
            />
            <output htmlFor="settings-terminal-text-size">
              {Number.isFinite(previewTerminalTextSize)
                ? Math.round(previewTerminalTextSize)
                : 13}
              px
            </output>
          </span>
        </label>
      </div>
    </SettingsSection>
  )
}
