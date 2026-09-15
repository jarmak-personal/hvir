import { useCallback } from 'react'
import type { SkillagerContentController } from './use-skillager-content'
import { skillagerContentLabel } from './skillager-content-model'
import { SkillagerReviewContent } from './SkillagerReviewContent'

export function SkillagerBody({
  id,
  controller,
  openCanonical,
}: {
  readonly id: string
  readonly controller: SkillagerContentController
  readonly openCanonical?: () => void
}) {
  const { state, asset, read } = controller
  const loadAsset = useCallback(
    (_id: string, document: string, entry: string) => asset(document, entry),
    [asset],
  )
  const open = useCallback((_id: string, entry: string) => read(entry), [read])
  const shown = state.id === id ? state : undefined
  const selection = shown?.selection
  return (
    <section className="skillager-body" aria-label="Skill body">
      {selection ? (
        <p className="skillager-body-source">
          {skillagerContentLabel(selection)} · {selection.path.hostId}:
          {selection.path.path}
          {selection.kind === 'router'
            ? ' · Reading the installed router; this skill is a member.'
            : ''}
        </p>
      ) : null}
      {openCanonical ? (
        <button type="button" onClick={openCanonical}>
          Read definition in Your library
        </button>
      ) : null}
      {shown?.currentFile ? (
        <p className="skillager-hint">
          Current file opened separately from the earlier accepted search version. These
          bytes may have unaccepted changes.
        </p>
      ) : null}
      {shown?.loading ? <p role="status">Reading skill…</p> : null}
      {shown?.message ? <p role="status">{shown.message}</p> : null}
      {shown?.stale ? (
        <button type="button" onClick={controller.reopen}>
          Open current file
        </button>
      ) : null}
      {shown?.content ? (
        <>
          <div className="skillager-body-modes" role="group" aria-label="Skill view">
            <button
              type="button"
              aria-pressed={!shown.source}
              onClick={() => controller.mode(false)}
            >
              Rendered
            </button>
            <button
              type="button"
              aria-pressed={Boolean(shown.source)}
              disabled={shown.content.text === undefined}
              onClick={() => controller.mode(true)}
            >
              Source
            </button>
            {shown.content.entry !== 'SKILL.md' ? (
              <button type="button" onClick={() => void read('SKILL.md')}>
                Skill body
              </button>
            ) : null}
          </div>
          <div className="skillager-body-content">
            <SkillagerReviewContent
              id={id}
              content={shown.content}
              source={Boolean(shown.source)}
              navigation={{ root: selection?.root, asset: loadAsset, open }}
            />
          </div>
          <p className="skillager-hint">
            Current file contents. Acceptance uses a separate complete-tree review.
          </p>
        </>
      ) : !shown?.loading && !shown?.message ? (
        <p className="skillager-hint">
          Activate this skill tab to read its current file.
        </p>
      ) : null}
    </section>
  )
}
