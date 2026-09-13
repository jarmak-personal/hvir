import { useEffect, useRef, useState } from 'react'
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
  return (
    <div className="skillager-search-controls">
      <details
        className="skillager-search-disclosure"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          Search{' '}
          <small>
            ·{' '}
            {controller.browseAgent === 'all'
              ? 'All agents'
              : skillagerAgentLabel(controller.browseAgent)}
          </small>
        </summary>
        <form
          className="skillager-search"
          onSubmit={(event) => {
            event.preventDefault()
            void controller.submit()
          }}
        >
          <label htmlFor="skillager-search-query">Search skills</label>
          <div className="skillager-query">
            <input
              id="skillager-search-query"
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
              Agent preference selects native variants and compatibility context; it is
              not a strict compatibility filter. Browsing shows matching project agents
              and reusable library skills.
            </p>
            <p className="skillager-hint">
              Search covers metadata and the first 50,000 characters of accepted bodies.
              Pending bodies are excluded. Results keep Skillager’s ranking, up to 50
              matches.
            </p>
          </details>
        </form>
      </details>
      {controller.submitted && submitted ? (
        <p className="skillager-query-summary">
          Results for “{controller.submitted}” ·{' '}
          {submitted.scope === 'library' ? 'Your library' : 'Available to this project'} ·{' '}
          {submitted.browseAgent === 'all'
            ? 'All agents'
            : `Prefers ${skillagerAgentLabel(submitted.browseAgent)}`}
        </p>
      ) : null}
    </div>
  )
}
