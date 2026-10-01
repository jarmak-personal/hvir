/** Deliver Node probe source below canonical TTY limits without trusting command echoes. */
export function terminalProbeSourceDelivery(
  source: string,
  variable: string,
  prefix: string,
): readonly { readonly command: string; readonly marker: string }[] {
  const chunks =
    Buffer.from(source)
      .toString('base64')
      .match(/.{1,640}/g) ?? []
  const assignments = [
    `${variable}=''`,
    ...chunks.map((chunk) => `${variable}="$${variable}"'${chunk}'`),
  ]
  return assignments.map((assignment, index) => ({
    command: `${assignment}; printf '%s%s\\n' '${prefix}' '${index}__'\n`,
    marker: `${prefix}${index}__`,
  }))
}
