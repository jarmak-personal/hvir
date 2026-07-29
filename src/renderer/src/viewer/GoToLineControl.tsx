import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react'

import {
  parseSourceCoordinate,
  resolveSourceCoordinate,
  type SourceCoordinate,
} from './source-coordinate'

export function GoToLineControl({
  requestSerial,
  content,
  boundedPreview,
  onRequestHandled,
  onNavigate,
}: {
  readonly requestSerial?: number
  readonly content?: string
  readonly boundedPreview: boolean
  readonly onRequestHandled: (serial: number) => void
  readonly onNavigate: (coordinate: SourceCoordinate) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const coordinateId = useId()
  const errorId = useId()
  const root = useRef<HTMLDivElement>(null)
  const openRef = useRef(false)

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
    setError('')
    openRef.current = true
    setOpen(true)
  }, [])

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

  const close = useCallback((restoreFocus: boolean): void => {
    openRef.current = false
    setOpen(false)
    setError('')
    if (restoreFocus) requestAnimationFrame(() => previousFocus.current?.focus())
  }, [])

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

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const parsed = parseSourceCoordinate(value)
    if (!parsed.valid) {
      setError(parsed.message)
      return
    }
    if (content === undefined) {
      setError('Source content is not available')
      return
    }
    const resolved = resolveSourceCoordinate(content, parsed.coordinate)
    if (!resolved.valid) {
      setError(
        boundedPreview && resolved.reason === 'line-out-of-range'
          ? `Line ${parsed.coordinate.line} is outside the loaded preview`
          : resolved.message,
      )
      return
    }
    onNavigate(resolved.coordinate)
    close(false)
  }

  return (
    <div ref={root} className="go-to-line">
      <button
        type="button"
        className="go-to-line-toggle"
        title="Go to line · Ctrl+G"
        aria-expanded={open}
        onClick={() => (open ? close(true) : show())}
      >
        Line
      </button>
      {open ? (
        <form className="go-to-line-popover" aria-label="Go to line" onSubmit={submit}>
          <label htmlFor={coordinateId}>Line or line:column</label>
          <input
            ref={input}
            id={coordinateId}
            value={value}
            inputMode="numeric"
            autoComplete="off"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => {
              setValue(event.currentTarget.value)
              setError('')
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              close(true)
            }}
          />
          {boundedPreview ? <small>Loaded preview only</small> : null}
          {error ? (
            <small id={errorId} className="go-to-line-error" role="status">
              {error}
            </small>
          ) : null}
        </form>
      ) : null}
    </div>
  )
}
