import { useState, type ReactElement } from 'react'
import type { ExtensionInstallation } from '../../../../shared/extensions/workbench'
import { extensionActionRoutes } from '../../extensions/extension-action-routes'

/** Manual view choice is independent of the explicit-only automatic installation landing. */
export function ExtensionViewLauncher({
  installation,
  disabled,
  onRun,
}: {
  readonly installation: ExtensionInstallation
  readonly disabled: boolean
  readonly onRun: (operation: () => Promise<unknown>) => Promise<void>
}): ReactElement | null {
  const [selected, setSelected] = useState<string>()
  const manifest = installation.manifest
  if (!manifest || !installation.installationId) return null
  const { taskViews } = extensionActionRoutes(manifest)
  const views = manifest.views.filter(
    (view) =>
      (manifest.landing
        ? view.id === manifest.landing
        : view.placement === 'application' && !view.navigation) &&
      !taskViews.includes(view),
  )
  const view =
    views.find((entry) => entry.id === selected) ??
    views.find((entry) => entry.id === manifest.landing) ??
    views[0]
  if (!view) return null
  return (
    <div className="settings-actions">
      {views.length > 1 ? (
        <label>
          View{' '}
          <select
            className="hvir-input"
            aria-label="Extension view"
            disabled={disabled}
            value={view.id}
            onChange={(event) => setSelected(event.target.value)}
          >
            {views.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button
        className="hvir-button"
        type="button"
        disabled={disabled}
        onClick={() =>
          void onRun(() =>
            window.hvir.invoke('extensions:open-view', {
              installationId: installation.installationId!,
              contributionId: view.id,
            }),
          )
        }
      >
        Open {view.title}
      </button>
    </div>
  )
}
