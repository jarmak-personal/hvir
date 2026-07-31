import { useEffect, useRef, type ReactElement } from 'react'

import type { RichMarkdownLink, RichMarkdownRow } from './rich-markdown-policy'
import type { RichOutputSnapshot } from './rich-output-coordinator'

export interface RichOutputLaneProps {
  readonly snapshot: RichOutputSnapshot
  readonly visible: boolean
  readonly onToggle: (enabled: boolean) => Promise<boolean>
  readonly onActivateLink: (link: RichMarkdownLink) => void
  readonly disclosureTarget: (link: RichMarkdownLink) => string
  readonly fontFamily: string
  readonly fontSize: number
}

export function RichOutputLane({
  snapshot,
  visible,
  onToggle,
  onActivateLink,
  disclosureTarget,
  fontFamily,
  fontSize,
}: RichOutputLaneProps): ReactElement | null {
  const logRef = useRef<HTMLDivElement>(null)
  const rowCount = snapshot.messages.reduce(
    (total, message) => total + message.rows.length,
    0,
  )
  useEffect(() => {
    if (!visible || !logRef.current) return
    logRef.current.scrollTop = logRef.current.scrollHeight
  }, [rowCount, visible])

  if (snapshot.control === 'hidden') return null
  const available = snapshot.control === 'available'
  const stateLabel =
    snapshot.control === 'waiting'
      ? 'Waiting for exact session'
      : snapshot.control === 'unavailable'
        ? 'Unavailable for this session'
        : snapshot.enabled
          ? 'On'
          : 'Off'

  return (
    <>
      <div
        className="terminal-rich-control"
        role="group"
        aria-label="Rich output controls"
        hidden={!visible}
      >
        <label>
          <input
            type="checkbox"
            checked={snapshot.enabled}
            disabled={!available || snapshot.changing}
            onChange={(event) => void onToggle(event.currentTarget.checked)}
          />
          <span>Rich output</span>
        </label>
        <small>This session only · {snapshot.changing ? 'Applying…' : stateLabel}</small>
      </div>
      {snapshot.messages.length ? (
        <div
          ref={logRef}
          className="terminal-rich-lane"
          style={{ fontFamily, fontSize }}
          role="log"
          aria-label="Rich assistant output"
          aria-live="polite"
          aria-relevant="additions"
          hidden={!visible}
        >
          {snapshot.messages.map((message) => (
            <article
              key={`${message.turnId}:${message.id}`}
              className="terminal-rich-message"
              data-rich-message-state={message.state}
            >
              {message.rows.map((row, index) => (
                <RichOutputRow
                  key={`${message.id}:${index}`}
                  row={row}
                  onActivateLink={onActivateLink}
                  disclosureTarget={disclosureTarget}
                />
              ))}
            </article>
          ))}
        </div>
      ) : null}
    </>
  )
}

function RichOutputRow({
  row,
  onActivateLink,
  disclosureTarget,
}: {
  readonly row: RichMarkdownRow
  readonly onActivateLink: (link: RichMarkdownLink) => void
  readonly disclosureTarget: (link: RichMarkdownLink) => string
}): ReactElement {
  return (
    <div className={`terminal-rich-row ${row.kind}`}>
      <span>{row.prefix}</span>
      {row.spans.map((span, index) => {
        const className = span.styles.length
          ? `terminal-rich-span ${span.styles.join(' ')}`
          : 'terminal-rich-span'
        if (!span.link) {
          return (
            <span key={index} className={className}>
              {span.text}
            </span>
          )
        }
        const link = span.link
        const target = disclosureTarget(link)
        return (
          <span key={index} className="terminal-rich-link-group">
            <button
              type="button"
              className={`${className} terminal-rich-link`}
              title={target}
              onClick={() => onActivateLink(link)}
            >
              {span.text}
            </button>
            <button
              type="button"
              className="terminal-rich-copy-target"
              aria-label={`Copy target ${target}`}
              title={`Copy target: ${target}`}
              onClick={() => void navigator.clipboard?.writeText(target)}
            />
          </span>
        )
      })}
    </div>
  )
}
