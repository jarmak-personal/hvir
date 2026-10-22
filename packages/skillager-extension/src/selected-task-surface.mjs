import { bindSelectedSkill } from './selected-skill-view.mjs'
import { bindExposureView } from './exposure-view.mjs'

/** Compose the existing task owners for a reader or its originating browser sheet. */
export function bindSelectedTaskSurface(document, client, ports) {
  let selection, exposure, listener, completion
  const activity = { copy: false, exposure: false }
  const notify = (key, value) => {
    activity[key] = value
    listener?.(activity.copy || activity.exposure)
  }
  const changed = (result, origin, error) => {
    completion?.(result, origin, error)
    ports.changed?.(result, origin)
    if (JSON.stringify(origin) === JSON.stringify(ports.context().workspace))
      void exposure?.refresh()
  }
  const task = bindSelectedSkill(document, client, {
    context: ports.context,
    changed,
    activity: (value) => notify('copy', value),
  })
  exposure = bindExposureView(document, client, {
    context: ports.context,
    choose: ports.choose,
    preservation: (value) => task.preserved(value),
    saveAndUse: (mode) => task.saveAndUse(mode),
    changed,
    activity: (value) => notify('exposure', value),
    expanded: (active) =>
      task.select(
        active || selection?.row.kind === 'Installed Router' ? undefined : selection,
        { prepare: false },
      ),
  })
  return {
    task,
    exposure,
    get submitted() {
      return activity.copy || activity.exposure
    },
    onActivity(callback) {
      listener = callback
    },
    onChanged(callback) {
      completion = callback
    },
    select(input, options) {
      selection = input
      task.select(input?.row.kind === 'Installed Router' ? undefined : input, options)
      void exposure.select(input)
    },
    async prepare(input, action) {
      selection = input
      if (input.row.kind === 'Project original' && ['native', 'stub'].includes(action)) {
        task.select(input, { prepare: false })
        await exposure.select(input, { mode: action })
      } else {
        void exposure.select(undefined)
        await task.select(input, { task: action })
      }
    },
    contextChanged() {
      task.contextChanged()
      exposure.contextChanged()
    },
    visibilityChanged(options) {
      task.visibilityChanged(options)
      if (!options?.completed) exposure.visibilityChanged()
    },
    dispose() {
      exposure.dispose()
      task.dispose()
    },
  }
}
