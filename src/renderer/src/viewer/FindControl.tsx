import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'

import type { ViewerFindResult, ViewerFindTarget } from './viewer-find'

export function FindControl({
  requestSerial,
  target,
  unavailable,
  boundedPreview,
  onRequestHandled,
}: {
  readonly requestSerial?: number
  readonly target?: ViewerFindTarget
  readonly unavailable?: string
  readonly boundedPreview: boolean
  readonly onRequestHandled: (serial: number) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [requestedIndex, setRequestedIndex] = useState(0)
  const [result, setResult] = useState<ViewerFindResult>({ current: 0, total: 0 })
  const [revision, setRevision] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const openRef = useRef(false)
  const inputId = useId()
  const statusId = useId()

  const show = useCallback((): void => {
    if (openRef.current) {
      requestAnimationFrame(() => {
        input.current?.focus()
        input.current?.select()
      })
      return
    }
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    openRef.current = true
    setOpen(true)
  }, [])

  const close = useCallback(
    (restoreFocus: boolean): void => {
      openRef.current = false
      target?.clear()
      setOpen(false)
      if (restoreFocus) requestAnimationFrame(() => previousFocus.current?.focus())
    },
    [target],
  )

  useEffect(() => {
    if (requestSerial === undefined) return
    show()
    onRequestHandled(requestSerial)
  }, [onRequestHandled, requestSerial, show])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        close(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside, true)
    return () => document.removeEventListener('pointerdown', closeOutside, true)
  }, [close, open])

  useEffect(() => {
    if (!open || !target) return
    return target.subscribe(() => setRevision((current) => current + 1))
  }, [open, target])

  useEffect(() => {
    if (!open || !target || unavailable || !value) {
      target?.clear()
      setResult({ current: 0, total: 0 })
      return
    }
    setResult(target.update({ text: value, caseSensitive }, requestedIndex))
  }, [caseSensitive, open, requestedIndex, revision, target, unavailable, value])

  useEffect(() => () => target?.clear(), [target])

  const navigate = (delta: -1 | 1): void => {
    if (!value || result.total === 0) return
    setRequestedIndex(result.current - 1 + delta)
  }

  const status = unavailable
    ? unavailable
    : !target
      ? 'Preparing searchable view…'
      : !value
        ? 'Enter text to find'
        : result.total === 0
          ? 'No matches'
          : `${result.current} of ${result.total}${result.side ? ` · ${result.side}` : ''}`

  return (
    <div ref={root} className="find-control">
      <button
        type="button"
        className="find-toggle"
        title="Find in file · Ctrl/Cmd+F"
        aria-expanded={open}
        onClick={() => (open ? close(true) : show())}
      >
        Find
      </button>
      {open ? (
        <div className="find-popover" role="search" aria-label="Find in file">
          <label htmlFor={inputId}>Find</label>
          <input
            ref={input}
            id={inputId}
            value={value}
            autoComplete="off"
            aria-describedby={statusId}
            readOnly={Boolean(unavailable)}
            onChange={(event) => {
              setValue(event.currentTarget.value)
              setRequestedIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                close(true)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                navigate(event.shiftKey ? -1 : 1)
              }
            }}
          />
          <div className="find-actions">
            <label>
              <input
                type="checkbox"
                checked={caseSensitive}
                disabled={Boolean(unavailable)}
                onChange={(event) => {
                  setCaseSensitive(event.currentTarget.checked)
                  setRequestedIndex(0)
                }}
              />
              Match case
            </label>
            <button
              type="button"
              disabled={result.total === 0}
              onClick={() => navigate(-1)}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={result.total === 0}
              onClick={() => navigate(1)}
            >
              Next
            </button>
          </div>
          <small id={statusId} role="status">
            {status}
          </small>
          {boundedPreview ? <small>Loaded preview only</small> : null}
        </div>
      ) : null}
    </div>
  )
}
