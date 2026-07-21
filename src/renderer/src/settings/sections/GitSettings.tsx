import type { ReactElement } from 'react'

import { SettingsSection } from '../SettingsSection'
import type { SettingsDraft } from '../settings-draft'

export function GitSettings({
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
      section="git"
      title="Git"
      description="Choose how often hvir refreshes remote repository information."
    >
      <div className="settings-section-scroll settings-fields">
        <label htmlFor="settings-git-auto-fetch">
          <span>Git auto-fetch</span>
          <select
            id="settings-git-auto-fetch"
            value={draft.gitAutoFetchIntervalMs}
            onChange={(event) =>
              onChange('gitAutoFetchIntervalMs', event.currentTarget.value)
            }
          >
            <option value="0">Off</option>
            <option value={String(60_000)}>Every minute</option>
            <option value={String(5 * 60_000)}>Every 5 minutes</option>
            <option value={String(15 * 60_000)}>Every 15 minutes</option>
            <option value={String(30 * 60_000)}>Every 30 minutes</option>
          </select>
        </label>
      </div>
    </SettingsSection>
  )
}
