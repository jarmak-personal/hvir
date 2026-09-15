import type { SkillagerCanonicalObservation } from './skillager-model'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { skillagerAgentLabel, type SkillagerMetadata } from '../../../shared/skillager'
import { virtualRange } from '../layout/virtual-range'
import { SkillagerActions } from './SkillagerActions'
import type { SkillagerExposureController } from './use-skillager-exposure'
import {
  skillagerExplorerRows,
  type SkillagerExplorerRow,
} from './skillager-explorer-model'
import { trustLabel, skillagerOccurrenceLabel } from './skillager-model'
import { observedWorkspaceSkillLabel } from './skillager-exposure-model'

const ROW_HEIGHT = 25
const SEARCH_ROW_HEIGHT = 56

/** One bounded metadata viewport; it never owns filesystem or instruction-content reads. */
export function SkillagerTree({
  rows: sources,
  known,
  activeId,
  onSelect,
  actions,
  label,
}: {
  readonly rows: readonly SkillagerMetadata[]
  readonly known: SkillagerCanonicalObservation
  readonly activeId?: string
  readonly onSelect: (row: SkillagerMetadata) => void
  readonly actions: SkillagerExposureController['menu']
  readonly label: string
}) {
  const rowHeight = sources[0]?.search ? SEARCH_ROW_HEIGHT : ROW_HEIGHT
  const viewport = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const rows = useMemo(
    () => skillagerExplorerRows(sources, known, expanded),
    [sources, known, expanded],
  )
  const [position, setPosition] = useState({ top: 0, height: 200 })
  const [focusKey, setFocusKey] = useState<string>()
  const focusedRow = useRef<SkillagerExplorerRow>(undefined)
  const [pendingFocus, setPendingFocus] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const focused = useRef(false)
  // Clamp before rendering so a row-height change cannot briefly unmount the focused key.
  const scrollTop = Math.min(
    position.top,
    Math.max(0, rows.length * rowHeight - position.height),
  )
  const range = virtualRange(rows.length, rowHeight, scrollTop, position.height, 3)
  const mountedRows = rows.slice(range.start, range.end)
  const entryKey = mountedRows.some((row) => row.key === focusKey)
    ? focusKey
    : mountedRows[0]?.key
  useLayoutEffect(() => {
    if (rows.refused.length) {
      const refused = new Set(rows.refused)
      setExpanded((current) => new Set([...current].filter((key) => !refused.has(key))))
      setNotice(
        'Updated metadata exceeded the expansion limit. Later groups were collapsed; open details stay selected.',
      )
    }
  }, [rows])
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const update = (): void =>
      setPosition({ top: element.scrollTop, height: element.clientHeight })
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const maximum = Math.max(0, rows.length * rowHeight - element.clientHeight)
    if (element.scrollTop > maximum) {
      element.scrollTop = maximum
      setPosition({ top: maximum, height: element.clientHeight })
    }
    if (focusKey && rows.indexOf(focusKey, focusedRow.current) < 0) {
      const replacement = rows.at(Math.min(range.start, rows.length - 1))?.key
      setFocusKey(replacement)
      if (focused.current) setPendingFocus(replacement)
    }
  }, [rows, focusKey, range.start, rowHeight])
  useLayoutEffect(() => {
    if (!pendingFocus) return
    const row = [
      ...(viewport.current?.querySelectorAll<HTMLElement>('[data-skill-key]') ?? []),
    ].find((element) => element.dataset.skillKey === pendingFocus)
    if (row) {
      row.focus()
      setPendingFocus(undefined)
    }
  }, [pendingFocus, range.start, range.end, rows])
  useEffect(() => {
    if (actions.request && !actions.current(actions.request)) actions.dismiss()
  }, [range.start, range.end, rows, actions])

  const focus = (index: number): void => {
    const row = rows.at(index),
      element = viewport.current
    if (!row || !element) return
    const top = index * rowHeight
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + rowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = top + rowHeight - element.clientHeight
    setPosition({ top: element.scrollTop, height: element.clientHeight })
    setFocusKey(row.key)
    setPendingFocus(row.key)
  }
  const toggle = (row: SkillagerExplorerRow): void => {
    const next = new Set(expanded)
    if (next.has(row.key)) next.delete(row.key)
    else {
      next.add(row.key)
      if (skillagerExplorerRows(sources, known, next).refused.length) {
        setNotice(
          'Collapse another skill before expanding this one. Up to 40,000 rows can be expanded at once.',
        )
        return
      }
    }
    setNotice(undefined)
    setExpanded(next)
    setFocusKey(row.key)
    setPendingFocus(row.key)
  }
  const keyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    row: SkillagerExplorerRow,
    index: number,
  ): void => {
    if (
      !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
        event.key,
      )
    )
      return
    event.preventDefault()
    if (event.key === 'Home') focus(0)
    else if (event.key === 'End') focus(rows.length - 1)
    else if (event.key === 'ArrowDown') focus(Math.min(rows.length - 1, index + 1))
    else if (event.key === 'ArrowUp') focus(Math.max(0, index - 1))
    else if (event.key === 'ArrowRight') {
      if (row.expandable && !expanded.has(row.key)) toggle(row)
      else if (rows.at(index + 1)?.parent === row.key) focus(index + 1)
    } else if (row.expandable && expanded.has(row.key)) toggle(row)
    else if (row.parent) focus(rows.indexOf(row.parent))
  }
  return (
    <>
      {notice ? (
        <p className="skillager-section-notice" role="status">
          {notice}
        </p>
      ) : null}
      <div
        className="skillager-tree"
        ref={viewport}
        role="tree"
        aria-label={label}
        onFocusCapture={() => {
          focused.current = true
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) focused.current = false
        }}
        onScroll={(event) =>
          setPosition({
            top: event.currentTarget.scrollTop,
            height: event.currentTarget.clientHeight,
          })
        }
      >
        <div
          className="skillager-tree-space"
          style={{ height: rows.length * rowHeight }}
          role="none"
        >
          {mountedRows.map((row, at) => (
            <div
              key={row.key}
              className="skillager-tree-line"
              role="none"
              style={{
                top: (range.start + at) * rowHeight,
                height: rowHeight,
                paddingLeft: row.depth * 14,
              }}
            >
              {row.expandable ? (
                <button
                  className="skillager-disclosure"
                  type="button"
                  aria-label={`Related entries for ${row.metadata.name}`}
                  aria-expanded={expanded.has(row.key)}
                  tabIndex={-1}
                  onClick={() => toggle(row)}
                >
                  {expanded.has(row.key) ? '⌄' : '›'}
                </button>
              ) : (
                <span className="skillager-disclosure" aria-hidden="true">
                  ◇
                </span>
              )}
              <SkillagerActions
                metadata={row.metadata}
                controller={actions}
                surface="sidebar"
              >
                <button
                  type="button"
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-expanded={row.expandable ? expanded.has(row.key) : undefined}
                  aria-selected={activeId === row.key}
                  data-skill-key={row.key}
                  tabIndex={row.key === entryKey ? 0 : -1}
                  className={`skillager-row tree-row${row.metadata.search ? ' skillager-search-row' : ''}${activeId === row.key ? ' selected' : ''}`}
                  title={`${row.metadata.name} · ${row.metadata.description}`}
                  onFocus={() => {
                    focusedRow.current = row
                    setFocusKey(row.key)
                  }}
                  onKeyDown={(event) => keyboard(event, row, range.start + at)}
                  onClick={() => onSelect(row.metadata)}
                >
                  {row.metadata.search ? (
                    <SkillagerSearchRow metadata={row.metadata} />
                  ) : (
                    <>
                      <span className="skillager-name">{row.metadata.name}</span>
                      <SkillagerRowBadges metadata={row.metadata} />
                    </>
                  )}
                </button>
              </SkillagerActions>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function SkillagerSearchRow({ metadata }: { readonly metadata: SkillagerMetadata }) {
  const search = metadata.search!
  return (
    <>
      <span className="skillager-search-title">
        <span className="skillager-name">{metadata.name}</span>
        <SkillagerRowBadges metadata={metadata} />
      </span>
      <small
        className="skillager-search-context"
        title={`${search.occurrence.path.hostId}:${search.occurrence.path.path}`}
      >
        {skillagerOccurrenceLabel(search.occurrence)}
      </small>
      {search.match.occurrence.id !== search.occurrence.id ? (
        <small
          className="skillager-search-match"
          title={`${skillagerOccurrenceLabel(search.match.occurrence)} · ${search.match.occurrence.path.hostId}:${search.match.occurrence.path.path}`}
        >
          Matched in {skillagerOccurrenceLabel(search.match.occurrence, 'match')}
        </small>
      ) : null}
    </>
  )
}

function SkillagerRowBadges({ metadata }: { readonly metadata: SkillagerMetadata }) {
  const copy = metadata.workspace ?? metadata.routerMembership
  const agent = copy?.agent ?? metadata.projectSkill?.agent
  const mode = metadata.routerMembership
    ? 'Member'
    : copy?.mode === 'native'
      ? 'Full'
      : copy?.mode === 'stub'
        ? 'Stub'
        : copy?.mode === 'router'
          ? 'Router'
          : metadata.projectSkill
            ? 'Original'
            : undefined
  const status = metadata.workspace
    ? observedWorkspaceSkillLabel(metadata)
    : trustLabel(metadata)
  return (
    <span className="skillager-badges">
      {!metadata.search ? (
        <>
          {agent ? <small>{skillagerAgentLabel(agent)}</small> : null}
          {mode ? <small>{mode}</small> : null}
        </>
      ) : null}
      {status !== 'Accepted' ? (
        <small className="skillager-status-badge">{status}</small>
      ) : null}
      {metadata.matchReasons[0] ? (
        <small title={metadata.matchReasons.join(' · ')}>
          {metadata.matchReasons[0]}
        </small>
      ) : null}
      {metadata.workspaceCopies?.length ? (
        <small>
          {metadata.workspaceCopies.length}{' '}
          {metadata.workspaceCopies.length === 1 ? 'copy' : 'copies'}
        </small>
      ) : null}
      {!copy && metadata.workspaceRouterCount ? (
        <small>
          {metadata.workspaceRouterCount}{' '}
          {metadata.workspaceRouterCount === 1 ? 'router' : 'routers'}
        </small>
      ) : null}
    </span>
  )
}
