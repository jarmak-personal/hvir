/** Reserved by terminal presentation and main-owned agent admission. */
export const PROTECTED_TERMINAL_ENVIRONMENT = new Set([
  'TERM',
  'COLORTERM',
  'TERM_PROGRAM',
  'HVIR_AGENT_ENDPOINT',
  'HVIR_AGENT_WORKSPACE',
  'HVIR_AGENT_SESSION',
  'HVIR_AGENT_CLIENT',
  'HVIR_AGENT_UNAVAILABLE',
])
