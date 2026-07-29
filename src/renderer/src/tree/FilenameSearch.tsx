import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react'

import {
  unwrapOperation,
  type FilenameSearchResponse,
  type FilenameSearchResult,
  type HostPath,
} from '../../../shared'
import { FileTreeName } from './DirectoryTree'

const EMPTY_RESPONSE: FilenameSearchResponse = {
  results: [],
  traversalTruncated: false,
  resultsTruncated: false,
}

let nextFilenameSearchRequestId = 0

interface FilenameSearchProps {
  readonly root: HostPath
  readonly connected: boolean
  readonly gitIgnoreAvailable: boolean
  readonly refreshVersion: number
  readonly onActiveChange: (active: boolean) => void
  readonly onOpen: (path: HostPath, pinned: boolean) => void
}

export function FilenameSearch({
  root,
  connected,
  gitIgnoreAvailable,
  refreshVersion,
  onActiveChange,
  onOpen,
}: FilenameSearchProps): ReactElement {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const latestRequestId = useRef(0)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [includeIgnored, setIncludeIgnored] = useState(false)
  const [response, setResponse] = useState(EMPTY_RESPONSE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const active = query.length > 0

  useEffect(() => onActiveChange(open), [onActiveChange, open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(
    () => () => {
      if (latestRequestId.current > 0) {
        window.hvir.send('fs:filename-search-cancel', {
          requestId: latestRequestId.current,
        })
      }
    },
    [],
  )

  useEffect(() => {
    if (!active) {
      setResponse(EMPTY_RESPONSE)
      setError(undefined)
      setLoading(false)
      return
    }
    if (!connected) {
      setResponse(EMPTY_RESPONSE)
      setError('Reconnect to search this host.')
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(undefined)
    const timer = setTimeout(() => {
      const requestId = ++nextFilenameSearchRequestId
      latestRequestId.current = requestId
      void window.hvir
        .invoke('fs:filename-search', {
          root,
          query,
          includeIgnored,
          refreshVersion,
          requestId,
        })
        .then(unwrapOperation)
        .then(
          (next) => {
            if (!cancelled) setResponse(next)
          },
          (reason: unknown) => {
            if (!cancelled) {
              setResponse(EMPTY_RESPONSE)
              setError(reason instanceof Error ? reason.message : String(reason))
            }
          },
        )
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 100)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [active, connected, gitIgnoreAvailable, includeIgnored, query, refreshVersion, root])

  const focusResult = (current: HTMLButtonElement | null, offset: number): void => {
    const results = resultButtons(resultsRef.current)
    if (results.length === 0) return
    const currentIndex = current ? results.indexOf(current) : -1
    const next = Math.max(0, Math.min(results.length - 1, currentIndex + offset))
    results[next]?.focus()
  }

  const closeSearch = (): void => {
    if (latestRequestId.current > 0) {
      window.hvir.send('fs:filename-search-cancel', {
        requestId: latestRequestId.current,
      })
      latestRequestId.current = 0
    }
    setQuery('')
    setOpen(false)
  }

  const openResult = (path: HostPath, pinned: boolean): void => {
    closeSearch()
    onOpen(path, pinned)
  }

  if (!open) {
    return (
      <button
        type="button"
        className="filename-search-trigger"
        data-filename-search-trigger
        aria-label="Find file"
        title="Find file"
        onClick={() => setOpen(true)}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16">
          <circle cx="6.75" cy="6.75" r="4.25" />
          <path d="m10 10 3.5 3.5" />
        </svg>
      </button>
    )
  }

  return (
    <div className="filename-search">
      <div className="filename-search-field">
        <label htmlFor={inputId}>Find file</label>
        <input
          ref={inputRef}
          id={inputId}
          data-filename-search
          type="search"
          value={query}
          maxLength={1024}
          autoComplete="off"
          spellCheck={false}
          placeholder="Filename"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              focusResult(null, 1)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              closeSearch()
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="filename-search-clear"
            aria-label="Clear filename search"
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
          >
            ×
          </button>
        ) : null}
        <button
          type="button"
          className="filename-search-close"
          aria-label="Close filename search"
          title="Close filename search"
          onClick={closeSearch}
        >
          ×
        </button>
      </div>
      {gitIgnoreAvailable ? (
        <label className="filename-search-ignored">
          <input
            type="checkbox"
            checked={includeIgnored}
            onChange={(event) => setIncludeIgnored(event.currentTarget.checked)}
          />
          Include ignored files
        </label>
      ) : null}
      {active ? (
        <div className="filename-search-output">
          <div className="filename-search-status" role="status">
            {searchStatus(response, loading, error)}
          </div>
          {error ? (
            <div className="tree-error filename-search-error">{error}</div>
          ) : (
            <div ref={resultsRef} className="filename-search-results">
              {response.results.map((result) => (
                <FilenameResult
                  key={`${result.path.hostId}:${result.path.path}`}
                  result={result}
                  onOpen={openResult}
                  onMove={focusResult}
                  onEscape={closeSearch}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function FilenameResult({
  result,
  onOpen,
  onMove,
  onEscape,
}: {
  readonly result: FilenameSearchResult
  readonly onOpen: (path: HostPath, pinned: boolean) => void
  readonly onMove: (current: HTMLButtonElement | null, offset: number) => void
  readonly onEscape: () => void
}): ReactElement {
  return (
    <button
      type="button"
      className="filename-search-result"
      title={result.path.path}
      onClick={() => onOpen(result.path, false)}
      onKeyDown={(event) => handleResultKey(event, onMove, onEscape)}
    >
      <FileTreeName name={result.name} />
      <span className="filename-search-parent">{result.parentPath}</span>
    </button>
  )
}

function handleResultKey(
  event: KeyboardEvent<HTMLButtonElement>,
  onMove: (current: HTMLButtonElement | null, offset: number) => void,
  onEscape: () => void,
): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    onMove(event.currentTarget, 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    onMove(event.currentTarget, -1)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    onEscape()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    event.currentTarget.click()
  }
}

function resultButtons(root: HTMLElement | null): HTMLButtonElement[] {
  return root ? [...root.querySelectorAll<HTMLButtonElement>('button')] : []
}

function searchStatus(
  response: FilenameSearchResponse,
  loading: boolean,
  error: string | undefined,
): string {
  if (error) return 'Filename search unavailable'
  if (loading) return 'Searching workspace…'
  const count = response.results.length
  const notices = [
    response.resultsTruncated ? 'results limited' : undefined,
    response.traversalTruncated ? 'workspace scan limited' : undefined,
  ].filter(Boolean)
  return `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}${
    notices.length > 0 ? ` · ${notices.join(' · ')}` : ''
  }`
}
