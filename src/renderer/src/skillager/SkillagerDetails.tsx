import { workspaceSkillLabel } from './skillager-exposure-model'
import { SkillagerActions } from './SkillagerActions'
import type { SkillagerExposureController } from './use-skillager-exposure'
import { SkillagerReview } from './SkillagerReview'
import type { SkillagerDetailTab } from './skillager-model'
import type { SkillagerReviewController } from './use-skillager-review'
import type { ReactElement } from 'react'
import { skillagerAgentLabel, type SkillagerMetadata } from '../../../shared/skillager'
import { trustLabel } from './skillager-model'

export function SkillagerDetails({
  metadata,
  tab,
  reviews,
  exposures,
}: {
  readonly metadata: SkillagerMetadata
  readonly tab?: SkillagerDetailTab
  readonly exposures?: SkillagerExposureController
  readonly reviews?: SkillagerReviewController
}): ReactElement {
  const projectOnly = metadata.projectSkill && metadata.source.ownership !== 'library'
  return (
    <article className="skillager-details" aria-label={`Skill details: ${metadata.name}`}>
      <header>
        <p className="skillager-eyebrow">Skill metadata</p>
        <h1>{metadata.name}</h1>
        <p>{metadata.description}</p>
      </header>
      {exposures && !projectOnly ? (
        <SkillagerActions
          metadata={metadata}
          controller={exposures.menu}
          surface="details"
        />
      ) : null}
      <dl>
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
        <dt>Review state</dt>
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
            <dt>Content version</dt>
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
              {metadata.workspace.mode} · {workspaceSkillLabel(metadata)}
            </dd>
            <dt>Destination</dt>
            <dd>
              {metadata.workspace.target.hostId}:{metadata.workspace.target.path}
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
          ? 'Project review stays in Skillager. Use Set up in terminal from This workspace.'
          : 'Content loads only after explicit review.'}
      </p>
      {tab && reviews && !projectOnly ? (
        <SkillagerReview tab={tab} controller={reviews} exposures={exposures} />
      ) : null}
    </article>
  )
}
