import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react'

import { writeApplicationClipboard } from './terminal-clipboard'
import type { TerminalSearchController } from './terminal-search-controller'

interface TerminalSearchProps {
  readonly controller: TerminalSearchController
  readonly canCopyRegion: boolean
  readonly writeText?: (value: string) => Promise<void>
}

export function TerminalSearch({
  controller,
  canCopyRegion,
  writeText = writeApplicationClipboard,
}: TerminalSearchProps): ReactElement | null {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const operation = useRef(0)
  const [pendingCopy, setPendingCopy] = useState<'match' | 'region'>()
  const [feedback, setFeedback] = useState<string>()

  useEffect(() => {
    if (!snapshot.open) return
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => {
      operation.current += 1
      setPendingCopy(undefined)
      setFeedback(undefined)
    }
  }, [snapshot.open])

  const copy = (kind: 'match' | 'region'): void => {
    if (pendingCopy) return
    const id = (operation.current += 1)
    setPendingCopy(kind)
    setFeedback(undefined)
    const text =
      kind === 'match'
        ? Promise.resolve().then(() => controller.currentMatchText())
        : controller.extractCurrentRegion()
    void text
      .then((value) => writeText(value))
      .then(
        () => {
          if (operation.current !== id || !controller.snapshot().open) return
          setPendingCopy(undefined)
          setFeedback(kind === 'match' ? 'Copied match.' : 'Copied terminal region.')
        },
        () => {
          if (operation.current !== id || !controller.snapshot().open) return
          setPendingCopy(undefined)
          setFeedback(
            kind === 'match'
              ? 'Could not copy the current match to the clipboard.'
              : 'Could not copy the current terminal region to the clipboard.',
          )
        },
      )
  }

  if (!snapshot.open) return null
  const status =
    snapshot.query.length === 0
      ? 'Type to search this terminal'
      : snapshot.matchCount > 0
        ? snapshot.matchIndex === undefined
          ? `${snapshot.matchCount} ${snapshot.matchCount === 1 ? 'match' : 'matches'}`
          : `${snapshot.matchIndex + 1} of ${snapshot.matchCount}`
        : snapshot.pending
          ? 'Searching…'
          : 'No matches'

  return (
    <div
      className="terminal-search"
      role="search"
      aria-label="Search terminal output"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          controller.close(true)
        } else if (event.key === 'Enter' && event.target === inputRef.current) {
          event.preventDefault()
          controller.navigate(event.shiftKey ? 'previous' : 'next')
        }
      }}
    >
      <div className="terminal-search-query-row">
        <input
          ref={inputRef}
          type="search"
          aria-label="Find in terminal"
          placeholder="Find in terminal"
          spellCheck={false}
          value={snapshot.query}
          onChange={(event) => controller.setQuery(event.currentTarget.value)}
          className="hvir-input"
        />
        <span className="terminal-search-status" role="status" aria-live="polite">
          {status}
        </span>
        <button
          type="button"
          aria-label="Previous terminal match"
          title="Previous match (Shift+Enter)"
          disabled={snapshot.matchCount === 0}
          onClick={() => controller.navigate('previous')}
          className="hvir-button"
        >
          ↑
        </button>
        <button
          type="button"
          aria-label="Next terminal match"
          title="Next match (Enter)"
          disabled={snapshot.matchCount === 0}
          onClick={() => controller.navigate('next')}
          className="hvir-button"
        >
          ↓
        </button>
        <button
          type="button"
          aria-label="Close terminal search"
          title="Close search (Escape)"
          onClick={() => controller.close(true)}
          className="hvir-button"
        >
          ×
        </button>
      </div>
      <div className="terminal-search-actions">
        <label>
          <input
            type="checkbox"
            checked={snapshot.caseSensitive}
            onChange={(event) => controller.setCaseSensitive(event.currentTarget.checked)}
            className="hvir-input"
          />
          Match case
        </label>
        <button
          type="button"
          disabled={snapshot.matchIndex === undefined || pendingCopy !== undefined}
          onClick={() => copy('match')}
          className="hvir-button"
        >
          Copy Match
        </button>
        {canCopyRegion ? (
          <button
            type="button"
            title="Copy the current semantic prompt, command, or output block"
            disabled={pendingCopy !== undefined}
            onClick={() => copy('region')}
            className="hvir-button"
          >
            Copy Semantic Region
          </button>
        ) : null}
        {snapshot.unavailable ? (
          <span
            className="terminal-search-feedback terminal-search-unavailable"
            role="status"
          >
            Selected match is no longer available
          </span>
        ) : null}
        {feedback ? (
          <span
            className="terminal-search-feedback"
            role={feedback.startsWith('Could not') ? 'alert' : 'status'}
          >
            {feedback}
          </span>
        ) : null}
      </div>
    </div>
  )
}
