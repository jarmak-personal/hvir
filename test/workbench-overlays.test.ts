import { describe, expect, it } from 'vitest'

import {
  initialWorkbenchOverlayModel,
  workbenchOverlayReducer,
} from '../src/renderer/src/workbench/workbench-overlay-model'
import { addHarnessSettingsDestination } from '../src/renderer/src/settings/settings-navigation'

describe('workbench overlay model', () => {
  it('owns project and settings dialog visibility independently', () => {
    const project = workbenchOverlayReducer(initialWorkbenchOverlayModel, {
      type: 'open-project-picker',
    })
    const settings = workbenchOverlayReducer(project, {
      type: 'open-settings',
      destination: addHarnessSettingsDestination(),
    })
    expect(settings).toMatchObject({
      projectPickerOpen: true,
      settingsOpen: true,
      settingsDestination: {
        section: 'harnesses',
        intent: 'add-harness',
      },
    })
    expect(
      workbenchOverlayReducer(settings, { type: 'close-project-picker' }),
    ).toMatchObject({ projectPickerOpen: false, settingsOpen: true })
  })
})
