import { useCallback, useReducer } from 'react'
import {
  initialWorkbenchOverlayModel,
  workbenchOverlayReducer,
} from './workbench-overlay-model'
import {
  addHarnessSettingsDestination,
  settingsDestination,
  type SettingsSection,
} from '../settings/settings-navigation'

export function useWorkbenchOverlays() {
  const [model, dispatch] = useReducer(
    workbenchOverlayReducer,
    initialWorkbenchOverlayModel,
  )
  const openProjectPicker = useCallback(
    () => dispatch({ type: 'open-project-picker' }),
    [],
  )
  const closeProjectPicker = useCallback(
    () => dispatch({ type: 'close-project-picker' }),
    [],
  )
  const openSettings = useCallback(
    (section: SettingsSection = 'appearance') =>
      dispatch({ type: 'open-settings', destination: settingsDestination(section) }),
    [],
  )
  const openAddHarnessSettings = useCallback(
    () =>
      dispatch({
        type: 'open-settings',
        destination: addHarnessSettingsDestination(),
      }),
    [],
  )
  const closeSettings = useCallback(() => dispatch({ type: 'close-settings' }), [])
  return {
    ...model,
    openProjectPicker,
    closeProjectPicker,
    openSettings,
    openAddHarnessSettings,
    closeSettings,
  }
}
