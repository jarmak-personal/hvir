import type { ReactElement } from 'react'
import type { SkillagerController } from './use-skillager-workspace'

export function SkillagerLibrarySetup({
  controller,
}: {
  readonly controller: SkillagerController
}): ReactElement {
  const setup = controller.probe?.ok ? controller.probe.value.setup : undefined
  if (setup?.needsReconciliation)
    return (
      <div className="skillager-library-setup">
        <p>
          Library setup may already have changed files or registration. Check its status
          before continuing.
        </p>
        <button
          type="button"
          disabled={Boolean(controller.setupBusy)}
          onClick={() => void controller.setupLibrary('reconcile')}
        >
          {controller.setupBusy === 'reconcile'
            ? 'Checking library status…'
            : 'Check library status'}
        </button>
      </div>
    )
  return (
    <div className="skillager-library-setup">
      <h3>Set up your personal library</h3>
      <p>Your skills live in a local folder you choose.</p>
      {setup?.target ? (
        <>
          <span className="skillager-path skillager-library-location">
            {setup.target.root.path}
          </span>
          <button
            type="button"
            disabled={Boolean(controller.setupBusy)}
            onClick={() => void controller.setupLibrary('choose')}
          >
            Choose folder
          </button>
          <label className="skillager-git-choice">
            <input
              type="checkbox"
              checked={controller.gitHistory}
              disabled={Boolean(controller.setupBusy)}
              onChange={(event) => controller.setGitHistory(event.currentTarget.checked)}
            />{' '}
            Keep Git history
          </label>
          <p className="skillager-hint">
            Track changes to this personal library. This does not change Git or ignore
            rules for copies in your projects.
          </p>
          <button
            type="button"
            disabled={Boolean(controller.setupBusy)}
            onClick={() => void controller.setupLibrary('initialize')}
          >
            {controller.setupBusy === 'initialize'
              ? 'Creating and connecting…'
              : 'Create and connect'}
          </button>
        </>
      ) : (
        <p>The local library location is unavailable. Check Skillager again.</p>
      )}
    </div>
  )
}
