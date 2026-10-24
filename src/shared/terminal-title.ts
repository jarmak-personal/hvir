/** Provider-neutral presentation only; automatic titles remain independently owned. */
export function terminalTitle(title: string, customName?: string): string {
  return customName || title
}

export function terminalTitleTooltip(
  title: string,
  customName?: string,
): string | undefined {
  return customName ? title : undefined
}

/** Same bounds and control-character policy as terminal title IPC. Empty clears a name. */
export function isTerminalTitleText(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= 512 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  )
}

export interface TerminalName {
  readonly customName?: string
  readonly nameRevision?: number
}
