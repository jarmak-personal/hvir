import { describe, expect, it } from 'vitest'

import {
  initialWorkbenchOverlayModel,
  workbenchOverlayReducer,
} from '../src/renderer/src/workbench/workbench-overlay-model'

describe('workbench overlay model', () => {
  it('owns project and settings dialog visibility independently', () => {
    const project = workbenchOverlayReducer(initialWorkbenchOverlayModel, {
      type: 'open-project-picker',
    })
    const settings = workbenchOverlayReducer(project, {
      type: 'open-settings',
      section: 'harnesses-add',
    })
    expect(settings).toMatchObject({
      projectPickerOpen: true,
      settingsOpen: true,
      settingsSection: 'harnesses-add',
    })
    expect(
      workbenchOverlayReducer(settings, { type: 'close-project-picker' }),
    ).toMatchObject({ projectPickerOpen: false, settingsOpen: true })
  })
})
