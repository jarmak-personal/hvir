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
  return value?.outcome === 'refused'
    ? scoped.reply(undefined, managementActionError(value.message))
    : scoped.reply(value)
}
