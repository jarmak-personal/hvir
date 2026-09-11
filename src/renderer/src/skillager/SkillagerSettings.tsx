import { useState, type ReactElement } from 'react'
import { SkillagerConnection } from './SkillagerConnection'
import type { SkillagerController } from './use-skillager-workspace'

export function SkillagerSettings({
  controller,
  onEnabled,
}: {
  readonly controller: SkillagerController
  readonly onEnabled: (enabled: boolean) => void
}): ReactElement {
  const [executable, setExecutable] = useState('')
  return (
    <div className="skillager-settings">
      <label>
        <input
          type="checkbox"
          checked={controller.enabled}
          onChange={(event) => onEnabled(event.currentTarget.checked)}
        />{' '}
        Enable Skillager
      </label>
      {controller.enabled ? (
        <>
          <p>
            Uses your local Skillager installation. You manage installation and updates in
            your terminal.
          </p>
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
          <SkillagerConnection controller={controller} />
        </>
      ) : null}
    </div>
  )
}
