/** The package translates definite domain refusals; core keeps opaque structured results. */
export function managementActionError(message) {
  let text = ''
  for (const character of String(
    message || 'Skillager refused this action. Review its prerequisites.',
  )) {
    if (text.length + character.length > 240) break
    text += character
  }
  return text
}
export function replyManagement(scoped, value) {
  if (!scoped.alive) return
  // Per-target, tracking and operation facts must survive the public reply boundary.
  const messageOnly =
    value?.outcome === 'refused' &&
    Object.keys(value).every((key) => ['outcome', 'action', 'message'].includes(key))
  return messageOnly
    ? scoped.reply(undefined, managementActionError(value.message))
    : scoped.reply(value)
}
