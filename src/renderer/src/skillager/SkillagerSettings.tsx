import type { AppSettings } from '../settings/settings'
import { useState, type ReactElement } from 'react'
import { SkillagerConnection } from './SkillagerConnection'
import type { SkillagerController } from './use-skillager-workspace'

export function SkillagerSettings({
  controller,
  settings,
  onSettings,
}: {
  readonly controller: SkillagerController
  readonly settings: AppSettings
  readonly onSettings: (settings: AppSettings) => void
}): ReactElement {
  const [executable, setExecutable] = useState('')
  return (
    <div className="skillager-settings">
      <label>
        <input
          type="checkbox"
          checked={controller.enabled}
          onChange={(event) =>
            onSettings({ ...settings, skillagerEnabled: event.currentTarget.checked })
          }
        />{' '}
        Enable Skillager
      </label>
      {controller.enabled ? (
        <>
          <p>
            Uses your local Skillager installation. You manage installation and updates in
            your terminal.
          </p>
          <SkillagerConnection controller={controller} />
          <details>
            <summary>Local executable</summary>
            <label htmlFor="skillager-executable">
              Local executable <span>(optional)</span>
            </label>
            <div className="skillager-executable">
              <input
                id="skillager-executable"
                value={executable}
                placeholder="Find skillager in your shell"
                onChange={(event) => setExecutable(event.currentTarget.value)}
              />
              <button
                type="button"
                disabled={controller.probing}
                onClick={() => void controller.check(executable)}
              >
                Check path
              </button>
            </div>
          </details>
        </>
      ) : null}
    </div>
  )
}
