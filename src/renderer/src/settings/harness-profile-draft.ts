import type { HarnessProfile, HarnessProfileInput } from '../../../shared'

import { parseHarnessArguments } from './harness-argument-editor'

/**
 * Compare the launch-profile meaning rather than the editor's formatting. This keeps
 * equivalent one-line and one-value-per-line argv text from producing a false dirty state.
 */
export function isHarnessProfileDraftDirty(
  profile: HarnessProfile | undefined,
  input: HarnessProfileInput,
  argvText: string,
): boolean {
  if (!profile) return true

  let args: HarnessProfileInput['args']
  try {
    args = parseHarnessArguments(argvText)
  } catch {
    return true
  }

  return (
    input.displayName !== profile.displayName ||
    input.description !== profile.description ||
    input.providerId !== profile.providerId ||
    !same(input.scope, profile.scope) ||
    !same(input.executable, profile.executable) ||
    !same(args, profile.args) ||
    !same(input.environment, profile.environment) ||
    !same(input.pathBindings, profile.pathBindings) ||
    input.order !== profile.order
  )
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
