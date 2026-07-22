import {
  DEFAULT_SETTINGS_DESTINATION,
  type SettingsDestination,
} from '../settings/settings-navigation'

export interface WorkbenchOverlayModel {
  readonly projectPickerOpen: boolean
  readonly settingsOpen: boolean
  readonly settingsDestination: SettingsDestination
}

export type WorkbenchOverlayAction =
  | { readonly type: 'open-project-picker' }
  | { readonly type: 'close-project-picker' }
  | { readonly type: 'open-settings'; readonly destination: SettingsDestination }
  | { readonly type: 'close-settings' }

export const initialWorkbenchOverlayModel: WorkbenchOverlayModel = {
  projectPickerOpen: false,
  settingsOpen: false,
  settingsDestination: DEFAULT_SETTINGS_DESTINATION,
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
      return { ...model, settingsOpen: true, settingsDestination: action.destination }
    case 'close-settings':
      return { ...model, settingsOpen: false }
  }
}
