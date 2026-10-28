/** A complete JavaScript value expression; interpolate without surrounding quotes. */
export function smokeScriptValue(value: unknown): string {
  const json = JSON.stringify(value)
  if (json === undefined)
    throw new TypeError('Smoke script value is not JSON serializable')
  return json.replace(
    /[<>&'\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}
