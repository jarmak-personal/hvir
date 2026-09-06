import { GutterMarker, gutter } from '@codemirror/view'
import type { GitBlameRun } from '../../../shared'

class BlameMarker extends GutterMarker {
  constructor(private readonly run: GitBlameRun) {
    super()
  }
  override toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = 'cm-blame-marker'
    element.textContent = `${this.run.hash.slice(0, 7)} ${this.run.author}`
    element.title = `${this.run.author} · ${this.run.summary}`
    return element
  }
}

export function blameGutter(runs: readonly GitBlameRun[]) {
  if (runs.length === 0) return []
  return gutter({
    class: 'cm-blame-gutter',
    lineMarker(view, block) {
      const run = findBlameRun(runs, view.state.doc.lineAt(block.from).number)
      return run ? new BlameMarker(run) : null
    },
  })
}

function findBlameRun(
  runs: readonly GitBlameRun[],
  line: number,
): GitBlameRun | undefined {
  let low = 0
  let high = runs.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const run = runs[middle]
    if (!run) return undefined
    if (line < run.startLine) high = middle - 1
    else if (line >= run.startLine + run.lineCount) low = middle + 1
    else return run
  }
  return undefined
}
