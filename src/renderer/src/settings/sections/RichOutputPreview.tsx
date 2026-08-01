import type { ReactElement } from 'react'

import { RichOutputRow } from '../../terminal/RichOutputLane'
import {
  StreamingMarkdownPresentation,
  type RichMarkdownLink,
  type RichMarkdownRow,
} from '../../terminal/rich-markdown-policy'

const PREVIEW_MARKDOWN = [
  '## A clearer agent response',
  '',
  'A **structured response** keeps emphasis and `inline code` readable.',
  '',
  '- Headings become scan landmarks.',
  '- Lists keep their indentation.',
  '- Links remain [explicit](https://example.com/).',
  '',
  '> This preview uses the live rich renderer without requiring a Codex connection.',
  '',
  '```ts',
  "const presentation = 'rich'",
  '```',
].join('\n')

const PREVIEW_ROWS = previewRows(PREVIEW_MARKDOWN)

export function RichOutputPreview({
  fontFamily,
  fontSize,
}: {
  readonly fontFamily: string
  readonly fontSize: number
}): ReactElement {
  const activateLink = (link: RichMarkdownLink): void => {
    if (link.kind === 'https') window.open(link.target, '_blank', 'noopener,noreferrer')
  }

  return (
    <section className="settings-rich-output-preview" aria-label="Rich output preview">
      <header>
        <strong>Rendered response</strong>
        <small>Visual preview only · provider availability is evaluated separately</small>
      </header>
      <div className="terminal-rich-lane" style={{ fontFamily, fontSize }}>
        <article className="terminal-rich-message" data-rich-message-state="ended">
          {PREVIEW_ROWS.map((row, index) => (
            <RichOutputRow
              key={index}
              row={row}
              onActivateLink={activateLink}
              disclosureTarget={(link) => link.target}
            />
          ))}
        </article>
      </div>
    </section>
  )
}

function previewRows(markdown: string): readonly RichMarkdownRow[] {
  const presentation = new StreamingMarkdownPresentation({ width: 68 })
  return [
    ...presentation.append(markdown).rows,
    ...presentation.end().rows,
  ]
}
