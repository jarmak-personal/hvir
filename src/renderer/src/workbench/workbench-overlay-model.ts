export type SettingsSection = 'general' | 'harnesses' | 'harnesses-add'

export interface WorkbenchOverlayModel {
  readonly projectPickerOpen: boolean
  readonly settingsOpen: boolean
  readonly settingsSection: SettingsSection
}

export type WorkbenchOverlayAction =
  | { readonly type: 'open-project-picker' }
  | { readonly type: 'close-project-picker' }
  | { readonly type: 'open-settings'; readonly section: SettingsSection }
  | { readonly type: 'close-settings' }

export const initialWorkbenchOverlayModel: WorkbenchOverlayModel = {
  projectPickerOpen: false,
  settingsOpen: false,
  settingsSection: 'general',
}

export function workbenchOverlayReducer(
  model: WorkbenchOverlayModel,
  action: WorkbenchOverlayAction,
): WorkbenchOverlayModel {
  switch (action.type) {
    case 'open-project-picker':
      return { ...model, projectPickerOpen: true }
    case 'close-project-picker':
      return { ...model, projectPickerOpen: false }
    case 'open-settings':
      return { ...model, settingsOpen: true, settingsSection: action.section }
    case 'close-settings':
      return { ...model, settingsOpen: false }
  }
}
