import type MarkdownIt from 'markdown-it'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import type Token from 'markdown-it/lib/token.mjs'
import taskLists from 'markdown-it-task-lists'

/** GFM task lists are display-only in hvir; source mode owns all mutation. */
export function enableTaskLists(markdown: MarkdownIt): MarkdownIt {
  markdown.use(taskLists, { enabled: false, label: false })
  markdown.core.ruler.before(
    'github-task-lists',
    'gitlab-inapplicable-task-input',
    prepareGitLabTasks,
  )
  markdown.core.ruler.after(
    'github-task-lists',
    'gitlab-inapplicable-task-output',
    renderGitLabTasks,
  )
  return markdown
}

const SOURCE_LINE_ATTRIBUTE = 'data-source-line'

/** Mark rendered block starts so rendered/source/diff transitions share a document line. */
export function enableSourceLineAnchors(markdown: MarkdownIt): MarkdownIt {
  markdown.core.ruler.after('block', 'hvir-source-line-anchors', (state) => {
    for (const token of state.tokens) {
      const sourceLine = tokenSourceLine(token)
      if (sourceLine !== undefined)
        token.attrSet(SOURCE_LINE_ATTRIBUTE, String(sourceLine))
    }
  })
  return markdown
}

/** Custom renderers must retain the source anchor that MarkdownIt attrs normally carry. */
export function wrapSourceLine(token: Token, html: string): string {
  const sourceLine = tokenSourceLine(token)
  return sourceLine === undefined
    ? html
    : `<div ${SOURCE_LINE_ATTRIBUTE}="${sourceLine}">${html}</div>`
}

function tokenSourceLine(token: Token): number | undefined {
  if (!token.map || token.type === 'inline' || token.nesting === -1) return undefined
  return token.map[0] + 1
}

const TASK_STATE_ATTRIBUTE = 'data-hvir-task-state'

function prepareGitLabTasks(state: StateCore): void {
  for (let index = 2; index < state.tokens.length; index += 1) {
    const token = state.tokens[index]
    if (
      token?.type !== 'inline' ||
      state.tokens[index - 1]?.type !== 'paragraph_open' ||
      state.tokens[index - 2]?.type !== 'list_item_open' ||
      !/^\[~\]\s/.test(token.content)
    ) {
      continue
    }
    token.attrSet(TASK_STATE_ATTRIBUTE, 'inapplicable')
    token.content = `[ ]${token.content.slice(3)}`
    const text = token.children?.[0]
    if (text?.type === 'text' && /^\[~\]\s/.test(text.content)) {
      text.content = `[ ]${text.content.slice(3)}`
    }
  }
}

function renderGitLabTasks(state: StateCore): void {
  for (const token of state.tokens) {
    if (
      token.type !== 'inline' ||
      token.attrGet(TASK_STATE_ATTRIBUTE) !== 'inapplicable'
    ) {
      continue
    }
    const checkbox = token.children?.find(
      (child) =>
        child.type === 'html_inline' && child.content.includes('task-list-item-checkbox'),
    )
    if (!checkbox) continue
    checkbox.content = checkbox.content.replace(
      'class="task-list-item-checkbox"',
      'class="task-list-item-checkbox inapplicable" aria-checked="mixed"',
    )
  }
}
