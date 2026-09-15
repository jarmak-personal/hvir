import { SkillagerBody } from './SkillagerBody'
import type { SkillagerContentController } from './use-skillager-content'
import { SkillagerLineage } from './SkillagerLineage'
import type { SkillagerLibrarySyncController } from './use-skillager-library-sync'
import { observedWorkspaceSkillLabel } from './skillager-exposure-model'
import { SkillagerActions } from './SkillagerActions'
import type { SkillagerExposureController } from './use-skillager-exposure'
import { SkillagerReview } from './SkillagerReview'
import type { SkillagerDetailTab } from './skillager-model'
import type { SkillagerReviewController } from './use-skillager-review'
import { useEffect, useRef, type ReactElement } from 'react'
import { skillagerAgentLabel, type SkillagerMetadata } from '../../../shared/skillager'
import {
  isNativeProjectSkill,
  trustLabel,
  skillagerOccurrenceLabel,
} from './skillager-model'

export function SkillagerDetails({
  metadata,
  tab,
  reviews,
  exposures,
  librarySync,
  content,
  openCanonical,
  reviewRequested,
}: {
  readonly reviewRequested?: boolean
  readonly content?: SkillagerContentController
  readonly openCanonical?: () => void
  readonly librarySync?: SkillagerLibrarySyncController
  readonly metadata: SkillagerMetadata
  readonly tab?: SkillagerDetailTab
  readonly exposures?: SkillagerExposureController
  readonly reviews?: SkillagerReviewController
}): ReactElement {
  const projectOnly = isNativeProjectSkill(metadata)
  const secondary = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (!reviewRequested || !secondary.current) return
    secondary.current.open = true
    secondary.current.querySelector<HTMLElement>('.skillager-review')?.focus()
  }, [reviewRequested, tab?.id])
  return (
    <article className="skillager-details" aria-label={`Skill details: ${metadata.name}`}>
      <header>
        <p className="skillager-eyebrow">Skill</p>
        <div className="skillager-detail-heading">
          <h1>{metadata.name}</h1>
          {exposures ? (
            <SkillagerActions
              metadata={metadata}
              controller={exposures.menu}
              surface="details"
            />
          ) : null}
        </div>
        <p>{metadata.description}</p>
      </header>
      {tab && content ? (
        <SkillagerBody id={tab.id} controller={content} openCanonical={openCanonical} />
      ) : null}
      <details
        key={tab?.id ?? metadata.id}
        ref={secondary}
        className="skillager-secondary"
      >
        <summary>Metadata and content review</summary>
        <dl>
          {metadata.search ? (
            <>
              <dt>Selected occurrence</dt>
              <dd>
                {skillagerOccurrenceLabel(metadata.search.occurrence)} ·{' '}
                {metadata.search.occurrence.path.hostId}:
                {metadata.search.occurrence.path.path}
              </dd>
              <dt>Search matched</dt>
              <dd>
                {skillagerOccurrenceLabel(metadata.search.match.occurrence)} ·{' '}
                {metadata.search.match.occurrence.path.hostId}:
                {metadata.search.match.occurrence.path.path}
              </dd>
              <dt>Installed observation</dt>
              <dd>
                {metadata.search.installed === null
                  ? 'Unknown'
                  : metadata.search.installed
                    ? 'Present in the submitted observation'
                    : 'Absent from the submitted observation'}
              </dd>
            </>
          ) : null}
          <dt>Identity</dt>
          <dd>{metadata.id}</dd>
          <dt>Source</dt>
          <dd>
            {metadata.source.ownership === 'library'
              ? 'Owned · Personal library'
              : (metadata.source.collection ??
                metadata.source.package ??
                metadata.source.type)}
          </dd>
          <dt>
            {metadata.search
              ? 'Search review state (submitted observation)'
              : 'Observed review state'}
          </dt>
          <dd>
            {metadata.projectSkill && metadata.trust === 'lint_blocked'
              ? 'Lint blocked'
              : trustLabel(metadata)}
          </dd>
          {metadata.projectSkill ? (
            <>
              <dt>Project location</dt>
              <dd>
                {metadata.projectSkill.path.hostId}:{metadata.projectSkill.path.path}
              </dd>
              <dt>Agent</dt>
              <dd>{skillagerAgentLabel(metadata.projectSkill.agent)}</dd>
              <dt>Management</dt>
              <dd>
                {metadata.projectSkill.managed
                  ? 'Managed project entry'
                  : 'Unmanaged project entry'}
              </dd>
            </>
          ) : null}
          {metadata.contentHash ? (
            <>
              <dt>
                {metadata.search?.occurrence.exposure
                  ? 'Search definition version (not installed bytes)'
                  : metadata.search
                    ? 'Selected search version (submitted observation)'
                    : 'Observed content version'}
              </dt>
              <dd>
                <code>{metadata.contentHash}</code>
              </dd>
            </>
          ) : null}
          {metadata.tags.length > 0 ? (
            <>
              <dt>Tags</dt>
              <dd>{metadata.tags.join(', ')}</dd>
            </>
          ) : null}
          {metadata.scanRisk ? (
            <>
              <dt>Scan</dt>
              <dd>{metadata.scanRisk}</dd>
            </>
          ) : null}
          {metadata.workspace ? (
            <>
              <dt>Workspace copy</dt>
              <dd>
                {skillagerAgentLabel(metadata.workspace.agent)} ·{' '}
                {metadata.workspace.mode === 'native' ? 'Full' : metadata.workspace.mode}{' '}
                · {observedWorkspaceSkillLabel(metadata)}
              </dd>
              <dt>Destination</dt>
              <dd>
                {metadata.workspace.target.hostId}:{metadata.workspace.target.path}
              </dd>
            </>
          ) : metadata.routerMembership ? (
            <>
              <dt>Router member</dt>
              <dd>
                {metadata.routerMembership.router?.tag ?? metadata.routerMembership.id} ·{' '}
                {skillagerAgentLabel(metadata.routerMembership.agent)}
              </dd>
              <dt>Router location</dt>
              <dd>
                {metadata.routerMembership.target.hostId}:
                {metadata.routerMembership.target.path}
              </dd>
            </>
          ) : metadata.workspaceCopies?.length ? (
            <>
              <dt>In this project</dt>
              <dd>
                {metadata.workspaceCopies.length} managed{' '}
                {metadata.workspaceCopies.length === 1 ? 'copy' : 'copies'}.
                {metadata.workspaceRouterCount
                  ? ` Also a member of ${metadata.workspaceRouterCount} project routers.`
                  : ''}{' '}
                Expand this skill in Your library to inspect each destination.
              </dd>
            </>
          ) : metadata.workspaceRouterCount ? (
            <>
              <dt>In this project</dt>
              <dd>
                Member of {metadata.workspaceRouterCount}{' '}
                {metadata.workspaceRouterCount === 1 ? 'router' : 'routers'}. Expand the
                concrete router under In this project to inspect its members.
              </dd>
            </>
          ) : metadata.projectSkill ? null : (
            <>
              <dt>Workspace status</dt>
              <dd>
                {metadata.exposure === 'hidden'
                  ? 'Not added to this workspace.'
                  : 'Not checked for this detail.'}
              </dd>
            </>
          )}
        </dl>
        {librarySync ? (
          <SkillagerLineage metadata={metadata} controller={librarySync} />
        ) : null}
        {metadata.workspaceCheckedAt ? (
          <p className="skillager-freshness">
            Workspace last checked{' '}
            {new Date(metadata.workspaceCheckedAt).toLocaleTimeString()}
            {metadata.workspaceFreshness === 'checking'
              ? ' · checking…'
              : metadata.workspaceFreshness !== 'fresh'
                ? ' · stale / unavailable'
                : ''}
          </p>
        ) : null}
        <p className="skillager-hint">
          {projectOnly
            ? 'Project review stays in Skillager. Use Set up in terminal under In this project.'
            : 'Review the complete current tree separately before accepting a version.'}
        </p>
        {tab && reviews && !projectOnly ? (
          <SkillagerReview tab={tab} controller={reviews} exposures={exposures} />
        ) : null}
      </details>
    </article>
  )
}
