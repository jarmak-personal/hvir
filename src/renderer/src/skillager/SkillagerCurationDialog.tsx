import { useState } from 'react'
import { createPortal } from 'react-dom'
import { SKILLAGER_AGENTS } from '../../../shared/skillager'
import { ConfirmationDialog } from '../workbench/ConfirmationDialog'
import type { SkillagerExposureController } from './use-skillager-exposure'
import { curationMembers, replacementChoices } from './skillager-curation-model'
import { SkillagerExposureEntry } from './SkillagerExposureEntry'
import { exposurePermission } from './skillager-exposure-model'

export function SkillagerCurationDialog({
  controller,
}: {
  readonly controller: SkillagerExposureController
}) {
  const state = controller.state!
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(0)
  const choice = state.curation,
    preview = state.preview,
    busy = Boolean(state.loading || state.applying)
  const grouping = state.action === 'group' || state.action === 'edit-members'
  const title =
    state.action === 'files'
      ? 'Remove in Files'
      : state.action === 'remove'
        ? 'Remove from this project'
        : state.action === 'ungroup'
          ? 'Ungroup router'
          : grouping
            ? 'Curate project router'
            : state.action === 'stub'
              ? 'Use Stub'
              : 'Use Full skill'
  const selectedAgent =
    state.metadata.workspace?.agent ??
    state.metadata.routerMembership?.agent ??
    state.metadata.projectSkill?.agent
  const rows = controller.rows.filter(
    (row) =>
      row.source.ownership === 'library' &&
      row.source.libraryId === controller.libraryId &&
      (!query ||
        `${row.name} ${row.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
  )
  const names = new Map(controller.rows.map((row) => [row.id, row.name]))
  const replacements =
    choice && state.destination && controller.libraryId
      ? replacementChoices(
          controller.projectRows,
          choice,
          state.destination,
          state.agent,
          controller.libraryId,
        )
      : []
  const routers = controller.projectRows.flatMap((row) =>
    row.workspace?.router?.kind === 'tag' && row.workspace.agent === state.agent
      ? [row.workspace]
      : [],
  )
  const updateChoice = (patch: Partial<NonNullable<typeof choice>>) => {
    if (choice) controller.choose({ curation: { ...choice, ...patch } })
  }
  const updateMembers = (members: readonly string[]) => {
    if (choice)
      controller.choose({ curation: curationMembers(choice, members, replacements) })
  }
  const missingMembers = [
    ...new Set([...(choice?.router?.router?.skillIds ?? []), ...(choice?.members ?? [])]),
  ].filter(
    (id) =>
      !controller.rows.some(
        (row) =>
          row.id === id &&
          row.source.ownership === 'library' &&
          row.source.libraryId === controller.libraryId,
      ),
  )
  return createPortal(
    <ConfirmationDialog
      key={`${preview?.previewId ?? 'choose'}:${state.loading ? 'preparing' : 'ready'}:${state.used ?? false}`}
      labelledBy="skillager-curation-title"
      className="skillager-exposure-dialog"
      busy={Boolean(state.applying)}
      actions={[
        {
          label: state.used || state.action === 'files' ? 'Close' : 'Cancel',
          kind: 'cancel',
          onSelect: controller.close,
        },
        ...(!state.used && state.action !== 'files'
          ? [
              {
                label: preview ? 'Confirm exact changes' : 'Preview changes',
                kind:
                  state.action === 'remove'
                    ? ('destructive' as const)
                    : ('primary' as const),
                disabled: busy || !state.destination,
                onSelect: () =>
                  void (preview ? controller.apply() : controller.preview()),
              },
            ]
          : []),
      ]}
    >
      <h2 id="skillager-curation-title">{title}</h2>
      <p>
        <strong>{state.metadata.name}</strong> ·{' '}
        {SKILLAGER_AGENTS.find((agent) => agent.id === state.agent)?.label}
      </p>
      <p>
        Current project:{' '}
        <code>
          {state.destination?.root.hostId}:{state.destination?.root.path}
        </code>
      </p>
      {state.action === 'files' ? (
        <p>
          This opens the exact folder in Files. Choose its separate Move to Trash/Delete
          action there; this handoff neither deletes nor approves the skill.
        </p>
      ) : (
        <p>Canonical library content, other projects and unselected copies remain.</p>
      )}
      {state.loading ? (
        <p role="status">Preparing complete preview and current preservation metadata…</p>
      ) : null}
      {!preview && state.action !== 'files' ? (
        <>
          {!selectedAgent ? (
            <label>
              Agent
              <select
                aria-label="Curation agent"
                value={state.agent}
                disabled={busy}
                onChange={(event) =>
                  controller.choose({
                    agent: event.currentTarget.value as typeof state.agent,
                  })
                }
              >
                {SKILLAGER_AGENTS.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {state.action === 'ungroup' ? (
            <label>
              Restore members as
              <select
                aria-label="Ungroup mode"
                value={state.mode}
                disabled={busy}
                onChange={(event) =>
                  controller.choose({
                    mode: event.currentTarget.value as typeof state.mode,
                  })
                }
              >
                <option value="native">Full skill</option>
                <option value="stub">Stub</option>
              </select>
            </label>
          ) : null}
          {grouping && choice ? (
            <>
              {state.action === 'group' ? (
                <label>
                  Router
                  <select
                    aria-label="Router group"
                    value={choice.router?.id ?? ''}
                    disabled={busy}
                    onChange={(event) => {
                      const router = routers.find(
                        (item) => item.id === event.currentTarget.value,
                      )
                      updateChoice({
                        router,
                        members: [
                          ...new Set([
                            ...(router?.router?.skillIds ?? []),
                            ...choice.members,
                          ]),
                        ],
                        departures: {},
                      })
                    }}
                  >
                    <option value="">New router</option>
                    {routers.map((router) => (
                      <option key={router.id} value={router.id}>
                        {router.router!.tag ?? router.id}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {!choice.router ? (
                <label>
                  New router name
                  <input
                    aria-label="New router name"
                    value={choice.name}
                    maxLength={128}
                    disabled={busy}
                    onChange={(event) =>
                      updateChoice({ name: event.currentTarget.value })
                    }
                  />
                </label>
              ) : (
                <p>
                  Selected router:{' '}
                  <strong>{choice.router.router?.tag ?? choice.router.id}</strong> ·{' '}
                  <code>{choice.router.target.path}</code>
                </p>
              )}
              <h3>Desired members · {choice.members.length}/64</h3>
              <p>
                {choice.members.map((id) => names.get(id) ?? id).join(', ') ||
                  'Select at least one member for a new router.'}
              </p>
              {missingMembers.map((id) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked={choice.members.includes(id)}
                    disabled={busy}
                    onChange={(event) =>
                      updateMembers(
                        event.currentTarget.checked
                          ? [...choice.members, id]
                          : choice.members.filter((member) => member !== id),
                      )
                    }
                  />
                  {id} · Not in the observed library. Uncheck and choose Remove to leave
                  the project.
                </label>
              ))}
              <label>
                Find library member
                <input
                  type="search"
                  aria-label="Find library member"
                  value={query}
                  disabled={busy}
                  onChange={(event) => {
                    setQuery(event.currentTarget.value)
                    setPage(0)
                  }}
                />
              </label>
              <ul className="skillager-curation-members">
                {rows.slice(page * 30, (page + 1) * 30).map((row) => (
                  <li key={row.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={choice.members.includes(row.id)}
                        disabled={
                          busy ||
                          (!choice.members.includes(row.id) &&
                            choice.members.length >= 64)
                        }
                        onChange={(event) =>
                          updateMembers(
                            event.currentTarget.checked
                              ? [...choice.members, row.id]
                              : choice.members.filter((id) => id !== row.id),
                          )
                        }
                      />
                      {row.name} · <code>{row.id}</code>
                    </label>
                  </li>
                ))}
              </ul>
              {rows.length > 30 ? (
                <nav aria-label="Library member pages">
                  <button disabled={!page} onClick={() => setPage(page - 1)}>
                    Previous
                  </button>
                  <span>
                    {page + 1}/{Math.ceil(rows.length / 30)}
                  </span>
                  <button
                    disabled={(page + 1) * 30 >= rows.length}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </button>
                </nav>
              ) : null}
              {choice.router?.router?.skillIds
                .filter((id) => !choice.members.includes(id))
                .map((id) => (
                  <label key={id}>
                    Departing: {names.get(id) ?? id}
                    <select
                      aria-label={`Departure for ${id}`}
                      value={choice.departures[id] ?? ''}
                      disabled={busy}
                      onChange={(event) =>
                        updateChoice({
                          departures: {
                            ...choice.departures,
                            [id]: event.currentTarget.value as
                              'native' | 'stub' | 'remove',
                          },
                        })
                      }
                    >
                      <option value="" disabled>
                        Choose outcome
                      </option>
                      <option value="native">Full skill</option>
                      <option value="stub">Stub</option>
                      <option value="remove">Remove from project</option>
                    </select>
                  </label>
                ))}
              <h3>Standalone copies to replace</h3>
              <p>Only checked copies are removed. Unchecked copies stay in place.</p>
              {replacements.map((item) => (
                <label key={item.key}>
                  <input
                    type="checkbox"
                    checked={choice.replacements.includes(item.key)}
                    disabled={busy}
                    onChange={(event) =>
                      updateChoice({
                        replacements: event.currentTarget.checked
                          ? [...choice.replacements, item.key]
                          : choice.replacements.filter((key) => key !== item.key),
                      })
                    }
                  />
                  {item.label}
                </label>
              ))}
            </>
          ) : null}
        </>
      ) : null}
      {preview && 'kind' in preview && preview.kind === 'plan' ? (
        <>
          {preview.group ? <GroupSummary value={preview.group} /> : null}
          <h3>Selected source versions</h3>
          {preview.sources.map((value) => {
            const source = JSON.parse(value) as {
              id: string
              content_hash: string
              trust: string
            }
            return (
              <p key={source.id}>
                {names.get(source.id) ?? source.id} · {source.trust} ·{' '}
                <code>{source.content_hash}</code>
              </p>
            )
          })}
          <h3>Complete project effects · {preview.targets.length} targets</h3>
          {preview.targets.map((target) => (
            <details key={target.id}>
              <summary>
                {target.action} · {target.kind} · {target.path.path}
              </summary>
              <p>
                Target permissions: {exposurePermission(target.before?.mode ?? null)} →{' '}
                {exposurePermission(target.after?.mode ?? null)}
              </p>
              <p>{target.effects.length} entry effects</p>
              {target.effects.map((effect) => (
                <details key={effect.path}>
                  <summary>
                    {effect.action} · {effect.path}
                  </summary>
                  <div className="skillager-effect-sides">
                    <div>
                      <h4>Before</h4>
                      <SkillagerExposureEntry value={effect.before} />
                    </div>
                    <div>
                      <h4>After</h4>
                      <SkillagerExposureEntry value={effect.after} />
                    </div>
                  </div>
                </details>
              ))}
            </details>
          ))}
          <details>
            <summary>Inspect source versions, approval and preservation evidence</summary>
            {preview.sources.map((source, index) => (
              <pre key={index}>{source}</pre>
            ))}
          </details>
          <details>
            <summary>Inspect tag and staging policy</summary>
            {preview.group ? <pre>{preview.group}</pre> : null}
            <pre>{preview.staging}</pre>
          </details>
        </>
      ) : null}
      {preview && 'kind' in preview && preview.kind === 'remove-router' ? (
        <>
          <p>
            Remove router <code>{preview.target.path}</code>. Its curated tag is retained.
          </p>
          <p>Folder permissions: {exposurePermission(preview.beforeMode)} → absent</p>
          {preview.effects.map((effect) => (
            <details key={effect.path}>
              <summary>remove · {effect.path}</summary>
              <SkillagerExposureEntry value={effect.before} />
            </details>
          ))}
        </>
      ) : null}
      {state.completion &&
      'kind' in state.completion &&
      state.completion.kind === 'plan' ? (
        <section aria-label="Actual project outcomes">
          <h3>Actual outcomes</h3>
          {state.completion.targets.map((target) => (
            <div key={target.id}>
              <p>
                <strong>{target.status.replaceAll('_', ' ')}</strong> · {target.path.path}
              </p>
              {target.reason ? <p>{target.reason.replaceAll('-', ' ')}</p> : null}
              <p>
                Observed state:{' '}
                <code>{target.observedHash ?? 'absent or unavailable'}</code>
              </p>
              {target.recoveryPath ? (
                <p>
                  Retained recovery location:{' '}
                  <code>
                    {target.recoveryPath.hostId}:{target.recoveryPath.path}
                  </code>
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {state.message ? (
        <p role={state.failed ? 'alert' : 'status'}>{state.message}</p>
      ) : null}
      {state.failed && state.metadata.projectSkill && state.action !== 'files' ? (
        <button
          type="button"
          onClick={() => void controller.start(state.metadata, 'files')}
        >
          Remove in Files…
        </button>
      ) : null}
    </ConfirmationDialog>,
    document.body,
  )
}
function GroupSummary({ value }: { readonly value: string }) {
  const group = JSON.parse(value) as {
    tag: string
    before_members: string[]
    after_members: string[]
    tag_policy: string
  }
  return (
    <section aria-label="Confirmed router membership">
      <h3>Router: {group.tag || 'Explicit member set'}</h3>
      <p>Before: {group.before_members.join(', ') || 'No router'}</p>
      <p>After: {group.after_members.join(', ') || 'No router'}</p>
      <p>Tag curation: {group.tag_policy}</p>
    </section>
  )
}
