import { useMemo, useState, useEffect } from 'react'
import type { SkillagerMetadata } from '../../../shared/skillager'
import type { SkillagerLibrarySyncController } from './use-skillager-library-sync'
import { skillagerLineageIndex } from './skillager-lineage-model'

export function SkillagerLineage({
  metadata,
  controller,
}: {
  readonly metadata: SkillagerMetadata
  readonly controller: SkillagerLibrarySyncController
}) {
  const report = controller.state.report
  const lookup = useMemo(() => skillagerLineageIndex(report?.lineages ?? []), [report])
  const lineages = lookup(metadata)
  const [page, setPage] = useState(0)
  useEffect(() => setPage(0), [metadata, report])
  const origins = lineages.flatMap((lineage) =>
    lineage.origins.map((origin) => ({ lineage, origin })),
  )
  return (
    <section className="skillager-lineage" aria-label="Library lineage">
      <h2>Library lineage</h2>
      <button
        type="button"
        disabled={!controller.enabled || Boolean(controller.state.busy)}
        onClick={() => void controller.check()}
      >
        {controller.state.busy === 'checking'
          ? 'Checking lineage…'
          : 'Check library lineage'}
      </button>
      {report?.status === 'observed' ? (
        <>
          {!lineages.length ? (
            <p>No verified library relation reported for this source.</p>
          ) : null}
          {lineages.slice(page, page + 1).map((lineage) => (
            <dl key={lineage.id}>
              <dt>Reusable copy</dt>
              <dd>
                {lineage.canonical.skillId} · {lineage.canonical.acceptance} ·{' '}
                {lineage.canonical.trust}
              </dd>
              <dt>Original approval</dt>
              <dd>
                {lineage.sourceApproval.decisionSkillId} · {lineage.sourceApproval.state}{' '}
                ·{' '}
                {lineage.sourceApproval.scope === 'project'
                  ? 'Approved in its original project'
                  : 'Approved for reuse'}
              </dd>
              <dt>Preservation</dt>
              <dd>
                {lineage.preservation}
                {lineage.reason ? ` · ${lineage.reason.replaceAll('-', ' ')}` : ''}
              </dd>
            </dl>
          ))}
          {lineages.length > 1 ? (
            <nav aria-label="Library relation pages">
              <button type="button" disabled={!page} onClick={() => setPage(page - 1)}>
                Previous relation
              </button>
              <span>
                {page + 1} / {lineages.length}
              </span>
              <button
                type="button"
                disabled={page + 1 >= lineages.length}
                onClick={() => setPage(page + 1)}
              >
                Next relation
              </button>
            </nav>
          ) : null}
          {origins.length ? (
            <details>
              <summary>Original locations · {origins.length}</summary>
              <SkillagerOrigins rows={origins} />
            </details>
          ) : null}
          {lineages.length ? (
            <p>
              The reusable copy keeps its own accepted version when an original changes or
              becomes blocked.
            </p>
          ) : null}
          {!report.coverage.complete ? (
            <p>Observation incomplete; some source state is unavailable.</p>
          ) : null}
        </>
      ) : (
        <p>
          Check the public lineage to see original locations and the reusable library
          copy.
        </p>
      )}
      {controller.state.message ? <p role="status">{controller.state.message}</p> : null}
    </section>
  )
}
function SkillagerOrigins({
  rows,
}: {
  readonly rows: readonly {
    origin: import('../../../shared/skillager-library-sync').SkillagerSyncOrigin
  }[]
}) {
  const [page, setPage] = useState(0)
  useEffect(() => setPage(0), [rows.length])
  return (
    <>
      <ul>
        {rows.slice(page * 25, (page + 1) * 25).map(({ origin }) => (
          <li key={origin.id}>
            {origin.path.hostId}:{origin.path.path} · {origin.observation.status}
          </li>
        ))}
      </ul>
      {rows.length > 25 ? (
        <nav aria-label="Original location pages">
          <button type="button" disabled={!page} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>
            {page + 1} / {Math.ceil(rows.length / 25)}
          </span>
          <button
            type="button"
            disabled={(page + 1) * 25 >= rows.length}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </nav>
      ) : null}
    </>
  )
}
