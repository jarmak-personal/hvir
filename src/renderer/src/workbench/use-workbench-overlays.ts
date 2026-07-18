import { useCallback, useReducer } from 'react'
import {
  initialWorkbenchOverlayModel,
  workbenchOverlayReducer,
  type SettingsSection,
} from './workbench-overlay-model'

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
    (section: SettingsSection = 'general') =>
      dispatch({ type: 'open-settings', section }),
    [],
  )
  const closeSettings = useCallback(() => dispatch({ type: 'close-settings' }), [])
  return {
    ...model,
    openProjectPicker,
    closeProjectPicker,
    openSettings,
    closeSettings,
  }
}
