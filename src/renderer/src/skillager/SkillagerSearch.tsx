import { useEffect, useRef, useState } from 'react'
import { SkillagerIcon } from './SkillagerIcon'
import {
  SKILLAGER_AGENTS,
  skillagerAgentLabel,
  type SkillagerBrowseAgent,
  type SkillagerSearchScope,
} from '../../../shared/skillager'
import type { SkillagerController } from './use-skillager-workspace'

export function SkillagerSearch({
  controller,
  local,
}: {
  readonly controller: SkillagerController
  readonly local: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])
  const submitted = controller.submittedContext
  const retry = (legacy: boolean): void => {
    if (!submitted) return
    void controller.submit(controller.submitted, {
      ...submitted,
      view: legacy ? 'legacy' : submitted.view,
      includeInstalled: true,
    })
  }
  const failure =
    controller.search.result && !controller.search.result.ok
      ? controller.search.result.reason
      : undefined
  return (
    <div className="skillager-search-controls">
      <details
        className="skillager-search-disclosure"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <span className="skillager-chevron" aria-hidden="true">
            {open ? '⌄' : '›'}
          </span>
          <span>Search</span>
          <SkillagerIcon name="search" />
        </summary>
        <form
          className="skillager-search"
          onSubmit={(event) => {
            event.preventDefault()
            void controller.submit()
          }}
        >
          <div className="skillager-query">
            <input
              id="skillager-search-query"
              aria-label="Search skills"
              ref={input}
              type="search"
              value={controller.query}
              placeholder="Title, description, tags, body…"
              onChange={(event) => controller.setQuery(event.currentTarget.value)}
            />
            <button type="submit" disabled={!controller.query.trim()}>
              Search
            </button>
          </div>
          <details className="skillager-search-advanced">
            <summary>Advanced</summary>
            <label htmlFor="skillager-search-scope">Search in</label>
            <select
              id="skillager-search-scope"
              value={controller.scope}
              onChange={(event) =>
                controller.setScope(event.currentTarget.value as SkillagerSearchScope)
              }
            >
              <option value="workspace" disabled={!local}>
                Available to this project
              </option>
              <option value="library">Your library</option>
            </select>
            <label htmlFor="skillager-agent">Preferred agent</label>
            <select
              id="skillager-agent"
              value={controller.browseAgent}
              onChange={(event) =>
                controller.setBrowseAgent(
                  event.currentTarget.value as SkillagerBrowseAgent,
                )
              }
            >
              <option value="all">All agents</option>
              {SKILLAGER_AGENTS.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label}
                </option>
              ))}
            </select>
            <p className="skillager-hint">
              Agent preference sets native variant and compatibility context; it is not a
              strict compatibility filter. Browsing keeps every reported project copy and
              reusable library skill visible.
            </p>
            <label className="skillager-search-option">
              <input
                type="checkbox"
                checked={controller.includeInstalled}
                onChange={(event) =>
                  controller.setIncludeInstalled(event.currentTarget.checked)
                }
              />
              Include installed
            </label>
            <label className="skillager-search-option">
              <input
                type="checkbox"
                checked={controller.separateCopies}
                onChange={(event) =>
                  controller.setSeparateCopies(event.currentTarget.checked)
                }
              />
              Show separate copies
            </label>
            <p className="skillager-hint">
              Search covers metadata and the first 50,000 characters of accepted bodies.
              Pending bodies are excluded. Results keep Skillager’s ranking, up to 50
              matches. Grouping and installed filtering happen before that limit.
            </p>
          </details>
        </form>
      </details>
      {controller.submitted && submitted ? (
        <p className="skillager-query-summary">
          Results for “{controller.submitted}” ·{' '}
          {submitted.scope === 'library' ? 'Your library' : 'Available to this project'} ·{' '}
          {submitted.view === 'legacy'
            ? 'Legacy results'
            : submitted.view === 'copies'
              ? 'Separate copies'
              : 'One row per known skill'}{' '}
          ·{' '}
          {submitted.includeInstalled
            ? 'Installed included'
            : local
              ? 'Installed hidden'
              : 'Hidden: skills added through hvir'}{' '}
          ·{' '}
          {submitted.browseAgent === 'all'
            ? 'All agents'
            : `Prefers ${skillagerAgentLabel(submitted.browseAgent)}`}
        </p>
      ) : null}
      {submitted?.view === 'legacy' ? (
        <p className="skillager-section-notice">
          Older Skillager may group agent variants. These legacy results include installed
          skills.
        </p>
      ) : null}
      {failure === 'search-unsupported' ? (
        <button type="button" onClick={() => retry(true)}>
          Search with installed Skillager…
        </button>
      ) : null}
      {failure === 'installed-unknown' ? (
        <button type="button" onClick={() => retry(false)}>
          Include installed and search
        </button>
      ) : null}
    </div>
  )
}
