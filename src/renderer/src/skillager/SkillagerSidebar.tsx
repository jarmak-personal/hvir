import { SKILLAGER_SEARCH_LIMIT } from '../../../shared/skillager'
import {
  SkillagerLibraryMenu,
  SkillagerSyncAction,
  SkillagerSyncProgress,
} from './SkillagerLibrarySync'
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
  canonicalSkillagerMetadata,
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
  const library = controller.inventory.observed
  const projectRead = local ? controller.project : controller.inventory
  const project = projectRead.observed
  const search = controller.search.result?.ok ? controller.search.result.value : undefined
  const libraryRows = controller.libraryRows
  const projectRows = controller.projectRows
  const searchRows = useMemo(
    () => metadataRows(search, controller.observing, controller.search.loading),
    [search, controller.observing, controller.search.loading],
  )
  const searchCanonical = useMemo(
    () => ({
      rows: canonicalSkillagerMetadata(searchRows),
      checkedAt: search?.checkedAt,
      freshness: !controller.observing
        ? ('stale' as const)
        : controller.search.loading
          ? ('checking' as const)
          : ('fresh' as const),
    }),
    [searchRows, search, controller.observing, controller.search.loading],
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
                    {search.rows.length === SKILLAGER_SEARCH_LIMIT
                      ? `First ${SKILLAGER_SEARCH_LIMIT} ranked results; refine your search for more.`
                      : `${search.rows.length} ranked results.`}
                  </p>
                  {searchRows.length ? (
                    <SkillagerTree
                      rows={searchRows}
                      known={searchCanonical}
                      activeId={controller.activeId}
                      onSelect={controller.select}
                      actions={controller.exposures.menu}
                      label="Search results"
                    />
                  ) : (
                    <div className="skillager-empty">
                      <p>
                        {controller.submittedContext?.includeInstalled
                          ? 'No matching skills.'
                          : local
                            ? 'No matching skills to add. Installed skills are hidden.'
                            : 'No matching skills to add. Skills added through hvir are hidden.'}
                      </p>
                      {!controller.submittedContext?.includeInstalled &&
                      controller.submittedContext ? (
                        <button
                          type="button"
                          onClick={() =>
                            void controller.submit(controller.submitted, {
                              ...controller.submittedContext!,
                              includeInstalled: true,
                            })
                          }
                        >
                          Include installed and search
                        </button>
                      ) : null}
                    </div>
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
              freshness={controller.projectFreshness}
              error={
                projectRead.result && !projectRead.result.ok
                  ? projectRead.result.message
                  : undefined
              }
              warning={
                projectRead.result?.ok && projectRead.result.value.exposures === undefined
                  ? `Project copy status is unavailable.${projectRead.observedExposures ? ' Last observed copies are retained.' : ''}`
                  : projectRead.observedExposures &&
                      local &&
                      controller.project.observedExposures?.requiresLibraryMetadata &&
                      controller.inventory.result &&
                      !controller.inventory.result.ok
                    ? `Library source metadata is unavailable. ${controller.inventory.result.message}`
                    : undefined
              }
              rows={projectRows}
              known={controller.canonical}
              checkedAt={
                project
                  ? Math.min(
                      project.checkedAt,
                      projectRead.observedExposures?.checkedAt ?? project.checkedAt,
                    )
                  : undefined
              }
              controller={controller}
              onRefresh={() =>
                void (local ? controller.refreshProjectMetadata() : controller.refresh())
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
              actions={
                library?.rows.length ? (
                  <SkillagerLibraryMenu controller={controller.librarySync} />
                ) : undefined
              }
              expanded={controller.libraryExpanded}
              onExpanded={controller.setLibraryExpanded}
              loading={controller.inventory.loading}
              freshness={controller.canonical.freshness}
              error={
                controller.inventory.result && !controller.inventory.result.ok
                  ? controller.inventory.result.message
                  : undefined
              }
              rows={shownLibrary}
              known={controller.canonical}
              checkedAt={library?.checkedAt}
              controller={controller}
              onRefresh={() => void controller.refresh()}
              empty={
                library && !pending && library.rows.length === 0 ? (
                  <>
                    <div className="skillager-sync-empty">
                      <SkillagerSyncAction controller={controller.librarySync} />
                      <p>
                        {local
                          ? 'Bring approved sources from this project into your reusable library.'
                          : 'Bring approved skills available on this computer into your library.'}
                      </p>
                    </div>
                    <SkillagerFirstSkill root={controller.connection.library.root} />
                  </>
                ) : (
                  <p className="skillager-empty">
                    {pending
                      ? 'No skills pending review.'
                      : 'Library metadata has not been checked.'}
                  </p>
                )
              }
            >
              <SkillagerSyncProgress controller={controller.librarySync} local={local} />
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
