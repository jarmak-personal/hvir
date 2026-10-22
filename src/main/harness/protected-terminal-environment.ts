/** Reserved by main-owned agent admission and cleared before PTY environment setup. */
export const AGENT_TERMINAL_ENVIRONMENT = [
  'HVIR_AGENT_ENDPOINT',
  'HVIR_AGENT_WORKSPACE',
  'HVIR_AGENT_SESSION',
  'HVIR_AGENT_CLIENT',
  'HVIR_AGENT_UNAVAILABLE',
] as const

/** Reserved by terminal presentation and main-owned agent admission. */
export const PROTECTED_TERMINAL_ENVIRONMENT = new Set([
  'TERM',
  'COLORTERM',
  'TERM_PROGRAM',
  ...AGENT_TERMINAL_ENVIRONMENT,
])
