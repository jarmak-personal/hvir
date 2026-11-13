export type ComposerSubmitMode = 'enter' | 'ctrl-enter'

export interface ProviderComposerKeyboardPolicy {
  readonly composerSubmitMode: ComposerSubmitMode
  readonly modifiedKeyProtocol: 'none' | 'modify-other-keys' | 'csi-u'
  readonly metaEnterAliasesControl: boolean
}
export interface ComposerKeyboardEvent {
  readonly code: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}
/** Defaults for ambiguous composer chords; actual negotiated native modes win. */
export function providerComposerEncoding(
  event: ComposerKeyboardEvent,
  policy: ProviderComposerKeyboardPolicy,
): {
  controlAlias: boolean
  fallback?: 'csi-u' | 'modify-other-keys'
} {
  const controlSubmit =
    policy.composerSubmitMode === 'ctrl-enter' &&
    event.code === 'Enter' &&
    !event.altKey &&
    !event.shiftKey &&
    ((event.ctrlKey && !event.metaKey) ||
      (policy.metaEnterAliasesControl && event.metaKey && !event.ctrlKey))
  const controlAlias = controlSubmit && event.metaKey
  if (event.code !== 'Enter' && event.code !== 'Escape') return { controlAlias }
  if (
    policy.modifiedKeyProtocol === 'csi-u' &&
    (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey)
  )
    return { controlAlias, fallback: 'csi-u' }
  if (
    policy.modifiedKeyProtocol === 'modify-other-keys' &&
    (controlSubmit ||
      (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey))
  )
    return { controlAlias, fallback: 'modify-other-keys' }
  return { controlAlias }
}
/** Provider-owned ambiguous composer chords, independent of terminal engine repairs. */
export function providerComposerKeySequence(
  event: ComposerKeyboardEvent,
  policy: ProviderComposerKeyboardPolicy,
): string | undefined {
  const key = event.code === 'Enter' ? 13 : event.code === 'Escape' ? 27 : undefined
  const selected = providerComposerEncoding(event, policy)
  if (key === undefined || selected.fallback === undefined) return
  const modifier =
    1 +
    Number(event.shiftKey) +
    2 * Number(event.altKey) +
    4 * Number(selected.controlAlias || event.ctrlKey) +
    8 * Number(!selected.controlAlias && event.metaKey)
  return selected.fallback === 'csi-u'
    ? `\x1b[${key};${modifier}u`
    : `\x1b[27;${modifier};${key}~`
}
