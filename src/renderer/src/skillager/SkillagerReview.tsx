import { joinHostPath } from '../../../shared/host-path'
import {
  eligibleSkillagerUpdate,
  observedSkillagerUpdate,
} from './skillager-exposure-model'
import type { SkillagerExposureController } from './use-skillager-exposure'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { SkillagerDetailTab } from './skillager-model'
import type { SkillagerReviewController } from './use-skillager-review'
import { SkillagerReviewContent } from './SkillagerReviewContent'

export function SkillagerReview({
  tab,
  controller,
  exposures,
}: {
  readonly tab: SkillagerDetailTab
  readonly controller: SkillagerReviewController
  readonly exposures?: SkillagerExposureController
}): ReactElement | null {
  const state = controller.states[tab.id]
  const detail = state?.detail
  const checkingUpdate =
    tab.metadata.workspaceFreshness === 'checking' &&
    observedSkillagerUpdate(tab.metadata)
  const loadContent = controller.content
  const opened = useRef<string | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => setConfirming(false), [tab.id, detail?.reviewId])
  useEffect(() => {
    if (detail && !detail.update && opened.current !== detail.reviewId) {
      opened.current = detail.reviewId
      void loadContent(tab.id, 'SKILL.md')
    }
  }, [detail, state?.content, state?.loading, loadContent, tab.id])
  if (tab.metadata.source.ownership !== 'library')
    return (
      <p className="skillager-hint">
        Content review here is confined to your connected personal library.
      </p>
    )
  return (
    <section className="skillager-review" aria-label="Library content review">
      <div className="skillager-review-actions">
        <button
          onClick={() => void controller.review(tab)}
          disabled={state?.loading || state?.accepting}
        >
          Review content
        </button>
        {eligibleSkillagerUpdate(tab.metadata) || checkingUpdate ? (
          <button
            onClick={() => void controller.review(tab, true)}
            disabled={state?.loading || state?.accepting || checkingUpdate}
          >
            Review workspace update
          </button>
        ) : null}
        <button
          onClick={() => void controller.history(tab)}
          disabled={state?.loading || state?.accepting}
        >
          Version history
        </button>
      </div>
      {checkingUpdate ? (
        <p role="status">Checking workspace copy before another review or preview…</p>
      ) : null}
      {state?.loading ? <p role="status">Preparing review…</p> : null}
      {state?.message ? (
        <p role={state.failed ? 'alert' : 'status'}>{state.message}</p>
      ) : null}
      {state?.history ? (
        <details className="skillager-review-history" open={!detail}>
          <summary>Library version history</summary>
          {!state.history.available ? (
            <p>
              History is unavailable
              {state.history.reason === 'no-git'
                ? ' because this library has Git history disabled'
                : ` (${state.history.reason ?? 'unavailable'})`}
              . Full-tree review remains available.
            </p>
          ) : !state.history.versions.length ? (
            <p>This draft has no previous version. Review its full tree.</p>
          ) : (
            <ul>
              {state.history.versions.map((version) => (
                <li key={version.hash}>
                  <code>{version.hash.slice(0, 12)}</code> · {version.committedAt}{' '}
                  {version.accepted ? '· accepted' : ''}{' '}
                  {detail ? (
                    <button
                      onClick={() => void controller.diff(tab.id, version.hash)}
                      disabled={state.loading || state.accepting}
                    >
                      Compare with reviewed tree
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </details>
      ) : null}
      {detail ? (
        <>
          <p className="skillager-review-version">
            Verified full tree · <code>{detail.hash}</code>
          </p>
          <p>
            Scan: {detail.scanRisk} · Lint: {detail.lintStatus}
          </p>
          {detail.findings.length ? (
            <ul>
              {detail.findings.map((finding, index) => (
                <li key={`${index}:${finding}`}>{finding}</li>
              ))}
            </ul>
          ) : null}
          {detail.refusal ? <p role="alert">{detail.refusal}</p> : null}
          <div className="skillager-review-files" aria-label="Reviewed skill files">
            {detail.files.map((file) => (
              <button
                key={file.entry}
                aria-pressed={state.content?.entry === file.entry}
                onClick={() => void controller.content(tab.id, file.entry)}
                disabled={state.accepting}
              >
                {file.entry}
                {file.executable ? ' · executable' : ''}{' '}
                <small>{file.size.toLocaleString()} bytes</small>
              </button>
            ))}
          </div>
          <div className="skillager-review-actions">
            <button
              aria-pressed={state.mode === 'rendered'}
              onClick={() => controller.mode(tab.id, 'rendered')}
            >
              Rendered
            </button>
            <button
              aria-pressed={state.mode === 'source'}
              onClick={() => controller.mode(tab.id, 'source')}
              disabled={state.content?.text === undefined}
            >
              Source
            </button>
            <button
              onClick={() => void controller.diff(tab.id)}
              disabled={
                !detail.history.available ||
                !detail.history.versions.length ||
                state.loading ||
                state.accepting
              }
            >
              Changes since previous version
            </button>
          </div>
          <div className="skillager-review-content">
            <SkillagerReviewContent
              id={tab.id}
              content={state.content}
              source={state.mode === 'source'}
              diff={state.mode === 'diff' ? state.diff?.text : undefined}
              diffPath={joinHostPath(detail.root, 'SKILL.md')}
              controller={controller}
            />
          </div>
          {detail.update && exposures ? (
            <div>
              <p>
                Reviewed workspace version <code>{detail.update.diff.fromHash}</code> →
                accepted version <code>{detail.update.diff.toHash}</code>.
              </p>
              <button
                disabled={state.loading || !eligibleSkillagerUpdate(tab.metadata)}
                onClick={() => exposures.start(tab.metadata, 'update', detail.reviewId)}
              >
                Preview workspace update…
              </button>
            </div>
          ) : null}
          {detail.canAccept && !state.used ? (
            <button onClick={() => setConfirming(true)} disabled={state.loading}>
              Accept library changes…
            </button>
          ) : null}
          {state.accepting ? (
            <p role="status">Accepting reviewed library version…</p>
          ) : null}
          {confirming ? (
            <div
              className="skillager-review-confirm"
              role="dialog"
              aria-label="Accept reviewed library version"
            >
              <p>
                Accept <strong>{detail.skillId}</strong> at this exact reviewed version?
              </p>
              <code>{detail.hash}</code>
              <p>This accepts library changes only. Workspace copies stay unchanged.</p>
              <button
                onClick={() => {
                  setConfirming(false)
                  void controller.accept(tab.id)
                }}
              >
                Accept reviewed version
              </button>
              <button onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
