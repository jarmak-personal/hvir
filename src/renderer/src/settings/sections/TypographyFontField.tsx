import type { CSSProperties, ReactElement } from 'react'

import type { FontPreferenceMode } from '../settings-model'
import { fontFamilyStack, normalizeFontPreference } from '../typography-settings'

export function TypographyFontField({
  id,
  label,
  kind,
  mode,
  family,
  previewText,
  previewSize,
  onMode,
  onFamily,
}: {
  readonly id: string
  readonly label: string
  readonly kind: 'interface' | 'monospace'
  readonly mode: FontPreferenceMode
  readonly family: string
  readonly previewText: string
  readonly previewSize: string
  readonly onMode: (mode: FontPreferenceMode) => void
  readonly onFamily: (family: string) => void
}): ReactElement {
  const custom = mode === 'custom'
  const previewStyle: CSSProperties = {
    fontFamily: fontFamilyStack(normalizeFontPreference({ mode, family }), kind),
    fontSize: previewSize,
  }
  return (
    <div
      className="settings-typography-field"
      role="group"
      aria-labelledby={`${id}-label`}
    >
      <span id={`${id}-label`}>{label}</span>
      <div className="settings-typography-control">
        <select
          id={`${id}-mode`}
          aria-label={`${label} source`}
          value={mode}
          onChange={(event) => onMode(event.currentTarget.value as FontPreferenceMode)}
        >
          <option value="system">System default</option>
          <option value="custom">Custom installed font</option>
        </select>
        {custom ? (
          <>
            <input
              id={id}
              type="text"
              aria-label={`${label} family`}
              autoComplete="off"
              spellCheck={false}
              value={family}
              placeholder={
                kind === 'interface' ? 'Example: Inter' : 'Example: JetBrains Mono'
              }
              onChange={(event) => onFamily(event.currentTarget.value)}
            />
            <div className="settings-font-preview" style={previewStyle}>
              {previewText}
            </div>
            <small>
              Preview uses the system default when this family is blank, invalid, or not
              installed on this computer.
            </small>
          </>
        ) : null}
      </div>
    </div>
  )
}
