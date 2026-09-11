import {
  basenameHostPath,
  containsHostPath,
  hostPathEquals,
} from '../../shared/host-path'
import type { SkillagerExposureRequest } from '../../shared/skillager-exposure'
import { SkillagerError } from './skillager-port'

/** A selected copy is an exact confined identity, never an option or arbitrary CLI selector. */
export function validateExposureSelection(request: SkillagerExposureRequest): void {
  if (request.action === 'add' && !request.exposure) return
  const selected = request.exposure
  if (
    !selected ||
    !safeExposureId(selected.id) ||
    selected.id !== basenameHostPath(selected.target) ||
    !containsHostPath(request.destination.root, selected.target) ||
    hostPathEquals(request.destination.root, selected.target)
  )
    throw new SkillagerError(
      'invalid-request',
      'Select one managed skill copy inside the exact destination workspace.',
    )
}
export function safeExposureId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('-') &&
    value !== '.' &&
    value !== '..' &&
    !/[\s/\\\p{Cc}\p{Cf}]/u.test(value)
  )
}
