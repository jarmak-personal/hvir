import { workspaceSkillLabel } from './skillager-exposure-model'
import { SkillagerActions, SkillagerActionsMenu } from './SkillagerActions'
import { SkillagerExposureDialog } from './SkillagerExposureDialog'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { HostPath } from '../../../shared/host-path'
import {
  SKILLAGER_AGENTS,
  type SkillagerAgent,
  type SkillagerMetadata,
  type SkillagerWorkspaceExposure,
} from '../../../shared/skillager'
import {
  pendingSkillagerReview,
  trustLabel,
  skillagerWorkspaceMetadata,
} from './skillager-model'
import { SkillagerConnection } from './SkillagerConnection'
import type { SkillagerController } from './use-skillager-workspace'

export function SkillagerSidebar({
  controller,
  root,
  hidden,
}: {
  readonly controller: SkillagerController
  readonly root: HostPath
  readonly hidden: boolean
}): ReactElement {
  const searchField = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!hidden && controller.connection) searchField.current?.focus()
  }, [hidden, controller.connection])
  const [perspective, setPerspective] = useState<'library' | 'workspace'>('library')
  const [pending, setPending] = useState(false)
  const [offset, setOffset] = useState(0)
  const searched = Boolean(controller.submitted)
  const read = searched ? controller.search : controller.inventory
  const data = read.result?.ok ? read.result.value : undefined
  const rows = useMemo(() => {
    if (!data) return []
    const metadata = skillagerWorkspaceMetadata(data).map((row) =>
      read.loading ? { ...row, workspaceFreshness: 'checking' as const } : row,
    )
    if (searched) return metadata
    if (perspective === 'library')
      return pending ? metadata.filter(pendingSkillagerReview) : metadata
    const byId = new Map(metadata.map((row) => [row.id, row]))
    return (data.exposures ?? []).map((exposure) => ({
      ...(byId.get(exposure.skillId ?? '') ?? unavailableSource(exposure)),
      workspace: exposure,
      workspaceFreshness: read.loading ? ('checking' as const) : ('fresh' as const),
      workspaceCheckedAt: data.checkedAt,
    }))
  }, [data, searched, perspective, pending, read.loading])
  const pageOffset = Math.min(
    offset,
    Math.max(0, Math.floor((rows.length - 1) / 50) * 50),
  )
  return (
    <section className="skillager-sidebar" aria-label="Skills" hidden={hidden}>
      <SkillagerExposureDialog controller={controller.exposures} />
      <SkillagerActionsMenu controller={controller.exposures.menu} />
      <div className="skillager-perspectives" aria-label="Skill perspective">
        <button
          type="button"
          className={perspective === 'library' ? 'active' : ''}
          onClick={() => {
            setPerspective('library')
            setOffset(0)
            controller.clearSearch()
          }}
        >
          Personal library
        </button>
        <button
          type="button"
          className={perspective === 'workspace' ? 'active' : ''}
          onClick={() => {
            setPerspective('workspace')
            setOffset(0)
            controller.clearSearch()
          }}
        >
          This workspace
        </button>
      </div>
      {!controller.connection ? (
        <SkillagerConnection controller={controller} />
      ) : (
        <>
          <form
            className="skillager-search"
            onSubmit={(event) => {
              event.preventDefault()
              setOffset(0)
              void controller.submit()
            }}
          >
            <label htmlFor="skillager-search-query">Search skills</label>
            <div className="skillager-query">
              <input
                id="skillager-search-query"
                ref={searchField}
                type="search"
                value={controller.query}
                placeholder="Title, description, tags, body…"
                onChange={(event) => controller.setQuery(event.currentTarget.value)}
              />
              <button type="submit" disabled={!controller.query.trim()}>
                Search
              </button>
            </div>
            <label htmlFor="skillager-search-scope">Search scope</label>
            <select
              id="skillager-search-scope"
              value={controller.scope}
              onChange={(event) =>
                controller.setScope(event.currentTarget.value as 'library' | 'workspace')
              }
            >
              <option value="library">Personal library</option>
              <option value="workspace" disabled={root.hostId !== 'local'}>
                All available to this workspace
              </option>
            </select>
            <label htmlFor="skillager-agent">Agent</label>
            <select
              id="skillager-agent"
              value={controller.agent}
              onChange={(event) =>
                controller.setAgent(event.currentTarget.value as SkillagerAgent)
              }
            >
              {SKILLAGER_AGENTS.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label}
                </option>
              ))}
            </select>
            <p className="skillager-hint">
              Search covers metadata and the first 50,000 characters of accepted bodies.
              Pending bodies are excluded.
            </p>
          </form>
          <div className="skillager-list-controls">
            {searched ? (
              <button type="button" onClick={controller.clearSearch}>
                Back to browsing
              </button>
            ) : perspective === 'library' ? (
              <label>
                <input
                  type="checkbox"
                  checked={pending}
                  onChange={(event) => {
                    setPending(event.currentTarget.checked)
                    setOffset(0)
                  }}
                />{' '}
                Pending review
              </label>
            ) : (
              <span>Workspace copies</span>
            )}
            <button
              type="button"
              disabled={controller.inventory.loading}
              onClick={() => void controller.refresh()}
            >
              Refresh
            </button>
          </div>
          {perspective === 'workspace' && root.hostId !== 'local' && !searched ? (
            <p className="skillager-empty">
              Workspace skill status is unavailable for this SSH destination. Browse your
              Personal library.
            </p>
          ) : (
            <>
              {read.loading ? (
                <p role="status">
                  {searched
                    ? 'Searching Skillager… The first search can take longer.'
                    : 'Reading library and workspace metadata…'}
                </p>
              ) : null}
              {read.result && !read.result.ok ? (
                <p role="alert">{read.result.message}</p>
              ) : null}
              {data ? (
                <>
                  <p className="skillager-freshness">
                    Checked {new Date(data.checkedAt).toLocaleTimeString()} ·{' '}
                    {(data.durationMs / 1000).toFixed(1)}s
                    {searched && rows.length === 50
                      ? ' · First 50 results; refine your search for more.'
                      : ''}
                  </p>
                  {rows.length === 0 ? (
                    <p className="skillager-empty">
                      {searched
                        ? 'No matching skills.'
                        : pending
                          ? 'No skills pending review.'
                          : perspective === 'workspace'
                            ? 'No workspace skills found.'
                            : 'Your personal library is empty.'}
                    </p>
                  ) : (
                    <div className="skillager-rows">
                      {rows.slice(pageOffset, pageOffset + 50).map((row) => (
                        <SkillagerActions
                          key={row.workspace?.id ?? row.id}
                          metadata={row}
                          controller={controller.exposures.menu}
                          surface="sidebar"
                        >
                          <button
                            type="button"
                            className={`skillager-row${controller.active?.metadata.id === row.id ? ' selected' : ''}`}
                            key={row.workspace?.id ?? row.id}
                            onClick={() => controller.select(row)}
                          >
                            <strong>{row.name}</strong>
                            <span>{row.description}</span>
                            <small>
                              {row.source.ownership === 'library'
                                ? 'Personal library'
                                : (row.source.collection ??
                                  row.source.package ??
                                  row.source.type)}{' '}
                              ·{' '}
                              {perspective === 'workspace' && !searched
                                ? `${row.workspace?.mode} · ${workspaceSkillLabel(row)}`
                                : trustLabel(row)}
                            </small>
                            {row.matchReasons.length > 0 ? (
                              <small>{row.matchReasons.join(' · ')}</small>
                            ) : null}
                          </button>
                        </SkillagerActions>
                      ))}
                    </div>
                  )}
                  {!searched && rows.length > 50 ? (
                    <div className="skillager-list-controls" aria-label="Library page">
                      <button
                        type="button"
                        disabled={pageOffset === 0}
                        onClick={() => setOffset(Math.max(0, pageOffset - 50))}
                      >
                        Previous 50
                      </button>
                      <span>
                        {pageOffset + 1}–{Math.min(pageOffset + 50, rows.length)} of{' '}
                        {rows.length}
                      </span>
                      <button
                        type="button"
                        disabled={pageOffset + 50 >= rows.length}
                        onClick={() => setOffset(pageOffset + 50)}
                      >
                        Next 50
                      </button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  )
}

function unavailableSource(exposure: SkillagerWorkspaceExposure): SkillagerMetadata {
  return {
    id: exposure.skillId ?? exposure.id,
    name: exposure.skillId ?? exposure.id,
    description: 'Source metadata is unavailable.',
    trust: 'unknown',
    source: { type: 'workspace', ownership: 'unknown' },
    tags: [],
    matchReasons: [],
    exposure: exposure.mode,
    workspace: exposure,
  }
}
