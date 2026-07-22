import type { ReactElement } from 'react'

import type { AppTheme } from '../../theme'
import { SettingsSection } from '../SettingsSection'
import type { SettingsDraft } from '../settings-draft'

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
      </div>
    </SettingsSection>
  )
}
