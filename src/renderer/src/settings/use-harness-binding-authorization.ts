import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

import type { HarnessProfileInput, HostPath } from '../../../shared'
import {
  applyPathBindingGrant,
  editorErrorMessage,
} from './harness-profile-editor-policy'
import type { HarnessProfileRequestPolicy } from './harness-profile-request-policy'

type HarnessPickerTarget = { readonly kind: 'binding'; readonly index: number }

export function useHarnessBindingAuthorization(
  policy: HarnessProfileRequestPolicy,
  stateRef: { readonly current: { readonly workspaceRoot?: HostPath } },
  updateInput: (update: (input: HarnessProfileInput) => HarnessProfileInput) => void,
  setError: Dispatch<SetStateAction<string | undefined>>,
) {
  const [picker, setPicker] = useState<HarnessPickerTarget>()

  const authorizeBinding = useCallback(
    async (path: HostPath): Promise<void> => {
      const root = stateRef.current.workspaceRoot
      const target = picker
      if (!root || !target) return
      const token = policy.start('grant:binding')
      try {
        const grant = await window.hvir.invoke('harness:authorize-path', { root, path })
        if (!policy.isCurrent(token, true)) return
        updateInput((input) => applyPathBindingGrant(input, target.index, grant))
        setPicker(undefined)
      } catch (reason) {
        if (policy.isCurrent(token, true)) setError(editorErrorMessage(reason))
      }
    },
    [picker, policy, setError, stateRef, updateInput],
  )

  const openPicker = useCallback(
    (index: number): void => {
      policy.invalidate('grant:binding')
      setPicker({ kind: 'binding', index })
    },
    [policy],
  )

  const closePicker = useCallback((): void => {
    policy.invalidate('grant:binding')
    setPicker(undefined)
  }, [policy])

  return { picker, authorizeBinding, openPicker, closePicker }
}
