/** Content-only contract for finite diagram computation; no project authority. */
export const MERMAID_LIMITS = {
  sourceCharacters: 64 * 1024,
  outputCharacters: 256 * 1024,
  elements: 3000,
  depth: 64,
  activeJobs: 2,
  deadlineMs: 15_000,
} as const

export interface MermaidRenderRequest {
  readonly id: string
  readonly source: string
  readonly theme: 'light' | 'dark'
}

export function assertMermaidRequest(value: MermaidRenderRequest): void {
  if (
    !value ||
    typeof value.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(value.id) ||
    typeof value.source !== 'string' ||
    value.source.length > MERMAID_LIMITS.sourceCharacters ||
    (value.theme !== 'light' && value.theme !== 'dark')
  )
    throw new Error(
      'Diagram preview unavailable: source limit or invalid request. Use Source to inspect the document.',
    )
}

export function assertMermaidOutput(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > MERMAID_LIMITS.outputCharacters)
    throw new Error(
      'Diagram preview unavailable: output exceeds the rendering limit. Use Source to inspect the document.',
    )
}
