import { useMemo, useState, type ReactElement } from 'react'
import type { HostPath } from '../../../shared/host-path'
import type {
  SkillagerMetadata,
  SkillagerMetadataResult,
} from '../../../shared/skillager'
import { SkillagerProjectSetup } from './SkillagerProjectSetup'
import { SkillagerFirstSkill } from './SkillagerFirstSkill'
import { SkillagerActionsMenu } from './SkillagerActions'
import { SkillagerExposureDialog } from './SkillagerExposureDialog'
import {
  pendingSkillagerReview,
  skillagerWorkspaceMetadata,
  skillagerProjectRows,
} from './skillager-model'
import { SkillagerConnection } from './SkillagerConnection'
import { SkillagerExplorer } from './SkillagerExplorer'
import { SkillagerSearch } from './SkillagerSearch'
import { SkillagerTree } from './SkillagerTree'
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
  const [pending, setPending] = useState(false)
  const local = root.hostId === 'local'
  const library = controller.inventory.result?.ok
    ? controller.inventory.result.value
    : undefined
  const projectRead = local ? controller.project : controller.inventory
  const project = projectRead.result?.ok ? projectRead.result.value : undefined
  const search = controller.search.result?.ok ? controller.search.result.value : undefined
  const libraryRows = useMemo(
    () => metadataRows(library, controller.observing, controller.inventory.loading),
    [library, controller.observing, controller.inventory.loading],
  )
  const projectRows = useMemo(
    () =>
      project
        ? withFreshness(
            skillagerProjectRows(project),
            controller.observing,
            projectRead.loading,
          )
        : [],
    [project, controller.observing, projectRead.loading],
  )
  const searchRows = useMemo(
    () => metadataRows(search, controller.observing, controller.search.loading),
    [search, controller.observing, controller.search.loading],
  )
  const shownLibrary = useMemo(
    () => (pending ? libraryRows.filter(pendingSkillagerReview) : libraryRows),
    [libraryRows, pending],
  )
  return (
    <section className="skillager-sidebar" aria-label="Skills" hidden={hidden}>
      <SkillagerExposureDialog controller={controller.exposures} />
      <SkillagerActionsMenu controller={controller.exposures.menu} />
      {!controller.connection ? (
        <div className="skillager-connection-scroll">
          <SkillagerConnection controller={controller} />
        </div>
      ) : (
        <>
          <SkillagerSearch controller={controller} local={local} />
          {controller.submitted ? (
            <section className="skillager-search-results" aria-label="Search results">
              <div className="skillager-section-header">
                <strong>Search results{search ? ` · ${search.rows.length}` : ''}</strong>
                <button type="button" onClick={controller.clearSearch}>
                  Clear search
                </button>
              </div>
              {controller.search.loading ? (
                <p className="skillager-section-notice" role="status">
                  Searching Skillager… The first search can take longer.
                </p>
              ) : null}
              {controller.search.result && !controller.search.result.ok ? (
                <p className="skillager-section-notice" role="alert">
                  {controller.search.result.message}
                </p>
              ) : null}
              {search ? (
                <>
                  <p className="skillager-section-notice">
                    {search.rows.length === 50
                      ? 'First 50 ranked results; refine your search for more.'
                      : `${search.rows.length} ranked results.`}
                  </p>
                  {searchRows.length ? (
                    <SkillagerTree
                      rows={searchRows}
                      known={searchRows}
                      activeId={controller.activeId}
                      onSelect={controller.select}
                      actions={controller.exposures.menu}
                      label="Search results"
                    />
                  ) : (
                    <p className="skillager-empty">No matching skills.</p>
                  )}
                </>
              ) : null}
            </section>
          ) : null}
          <div className="skillager-explorer-sections">
            <SkillagerExplorer
              title="In this project"
              expanded={controller.projectExpanded}
              onExpanded={controller.setProjectExpanded}
              loading={projectRead.loading}
              error={
                projectRead.result && !projectRead.result.ok
                  ? projectRead.result.message
                  : undefined
              }
              rows={projectRows}
              known={project?.rows ?? []}
              checkedAt={project?.checkedAt}
              controller={controller}
              onRefresh={() =>
                void (local ? controller.project.refresh() : controller.refresh())
              }
              empty={
                <p className="skillager-empty">
                  {!project
                    ? 'Project metadata has not been checked.'
                    : !project.exposures
                      ? 'Project skill status is unavailable for this destination.'
                      : local
                        ? 'No project skills reported by Skillager.'
                        : 'No managed project copies reported.'}
                </p>
              }
            >
              <SkillagerProjectSetup controller={controller} root={root} />
            </SkillagerExplorer>
            <SkillagerExplorer
              title="Your library"
              expanded={controller.libraryExpanded}
              onExpanded={controller.setLibraryExpanded}
              loading={controller.inventory.loading}
              error={
                controller.inventory.result && !controller.inventory.result.ok
                  ? controller.inventory.result.message
                  : undefined
              }
              rows={shownLibrary}
              known={libraryRows}
              checkedAt={library?.checkedAt}
              controller={controller}
              onRefresh={() => void controller.refresh()}
              empty={
                library && !pending && library.rows.length === 0 ? (
                  <SkillagerFirstSkill root={controller.connection.library.root} />
                ) : (
                  <p className="skillager-empty">
                    {pending
                      ? 'No skills pending review.'
                      : 'Library metadata has not been checked.'}
                  </p>
                )
              }
            >
              <label className="skillager-pending-filter">
                <input
                  type="checkbox"
                  checked={pending}
                  onChange={(event) => setPending(event.currentTarget.checked)}
                />{' '}
                Pending review
              </label>
            </SkillagerExplorer>
          </div>
        </>
      )}
    </section>
  )
}

function metadataRows(
  data: SkillagerMetadataResult | undefined,
  observing: boolean,
  loading: boolean,
): readonly SkillagerMetadata[] {
  return data ? withFreshness(skillagerWorkspaceMetadata(data), observing, loading) : []
}
function withFreshness(
  rows: readonly SkillagerMetadata[],
  observing: boolean,
  loading: boolean,
): readonly SkillagerMetadata[] {
  const freshness = !observing ? 'stale' : loading ? 'checking' : undefined
  return freshness ? rows.map((row) => ({ ...row, workspaceFreshness: freshness })) : rows
}
