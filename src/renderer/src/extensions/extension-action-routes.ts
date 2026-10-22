import { validateActionInput } from '../../../shared/extensions/action-input'
import type { ExtensionManifest } from '../../../shared/extensions/contract'

/** Settings offers direct invocation only when null is a valid declared input. */
export function extensionActionRoutes(manifest: ExtensionManifest) {
  const runnable = (manifest.actions ?? []).filter((action) => {
    try {
      if (action.inputSchema) validateActionInput(null, action.inputSchema)
      return true
    } catch {
      return false
    }
  })
  const taskViews = manifest.views.filter((view) =>
    manifest.actions?.some(
      (action) => action.view === view.id && !runnable.includes(action),
    ),
  )
  return { runnable, taskViews }
}
