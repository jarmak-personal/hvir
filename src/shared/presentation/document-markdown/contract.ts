/** Pure document policy ports, shared by browser and utility-process workers. */
export interface DocumentLoadedGrammar {
  readonly id: string
  readonly highlighter: {
    codeToHtml(code: string, options: { lang: string; theme: string }): string
  }
}
export interface DocumentGrammarPort {
  load(name: string): Promise<DocumentLoadedGrammar | undefined>
}
export const MARKDOWN_OPTIONS = {
  html: false,
  linkify: false,
  typographer: true,
} as const
export const SELECTED_MARKDOWN_LIMITS = {
  textBytes: 2 * 1024 * 1024,
  htmlBytes: 512 * 1024,
} as const
export interface DocumentMarkdownProtocol {
  readonly render: {
    readonly request: string
    readonly response: { readonly html: string | null; readonly workerPid: number }
  }
}
