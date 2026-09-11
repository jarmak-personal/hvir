import { SkillagerActions } from './SkillagerActions'
import type { SkillagerExposureController } from './use-skillager-exposure'
import { SkillagerReview } from './SkillagerReview'
import type { SkillagerDetailTab } from './skillager-model'
import type { SkillagerReviewController } from './use-skillager-review'
import type { ReactElement } from 'react'
import type { SkillagerMetadata } from '../../../shared/skillager'
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
  return (
    <article className="skillager-details" aria-label={`Skill details: ${metadata.name}`}>
      <header>
        <p className="skillager-eyebrow">Skill metadata</p>
        <h1>{metadata.name}</h1>
        <p>{metadata.description}</p>
      </header>
      {exposures ? (
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
        <dd>{trustLabel(metadata)}</dd>
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
              {metadata.workspace.mode} · {metadata.workspace.status}
            </dd>
            <dt>Destination</dt>
            <dd>
              {metadata.workspace.target.hostId}:{metadata.workspace.target.path}
            </dd>
          </>
        ) : (
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
      <p className="skillager-hint">Content loads only after explicit review.</p>
      {tab && reviews ? <SkillagerReview tab={tab} controller={reviews} /> : null}
    </article>
  )
}
