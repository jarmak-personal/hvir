/** Process-neutral bounds shared by Settings typography and extension presentation. */
export const MAX_FONT_FAMILY_LENGTH = 100
export const SYSTEM_INTERFACE_FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
export const MAX_INTERFACE_FONT_STACK_LENGTH =
  MAX_FONT_FAMILY_LENGTH * 2 + 4 + SYSTEM_INTERFACE_FONT_STACK.length
export const SYSTEM_MONOSPACE_FONT_STACK =
  'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace'
export const MAX_MONOSPACE_FONT_STACK_LENGTH =
  MAX_FONT_FAMILY_LENGTH * 2 + 4 + SYSTEM_MONOSPACE_FONT_STACK.length
