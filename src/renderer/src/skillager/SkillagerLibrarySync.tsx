import { useCallback, useEffect, useRef, useState } from 'react'
import { SKILLAGER_SYNC_OUTCOMES } from '../../../shared/skillager-library-sync'
import type { ContextMenuAnchor } from '../context-menu/viewport-context-menu'
import { SkillagerMenu } from './SkillagerMenu'
import type { SkillagerLibrarySyncController } from './use-skillager-library-sync'

const PAGE_SIZE = 50
export function SkillagerSyncAction({
  controller,
}: {
  readonly controller: SkillagerLibrarySyncController
}) {
  return (
    <button
      type="button"
      disabled={!controller.enabled || Boolean(controller.state.busy)}
      onClick={() =>
        void (controller.state.uncertain ? controller.check() : controller.sync())
      }
    >
      {controller.state.uncertain ? 'Check current state' : 'Sync approved skills'}
    </button>
  )
}

export function SkillagerLibraryMenu({
  controller,
}: {
  readonly controller: SkillagerLibrarySyncController
}) {
  const [anchor, setAnchor] = useState<ContextMenuAnchor & { readonly context: string }>()
  const trigger = useRef<HTMLButtonElement>(null)
  const dismiss = useCallback((restoreFocus = false) => {
    setAnchor(undefined)
    if (restoreFocus && trigger.current?.isConnected) trigger.current.focus()
  }, [])
  const current = anchor?.context === controller.context && controller.enabled
  useEffect(() => {
    if (!current) dismiss()
  }, [current, dismiss])
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="Your library actions"
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor && current)}
        onClick={() => {
          const box = trigger.current!.getBoundingClientRect()
          setAnchor({
            id: Date.now(),
            x: box.right,
            y: box.bottom,
            context: controller.context,
          })
        }}
      >
        ⋯
      </button>
      {anchor && current ? (
        <SkillagerMenu
          anchor={anchor}
          label="Your library actions"
          dismiss={dismiss}
          items={[
            {
              id: 'sync-approved',
              label: controller.state.uncertain
                ? 'Check current state'
                : 'Sync approved skills',
              disabled: Boolean(controller.state.busy),
              select: () => {
                if (!current || controller.state.busy) return
                dismiss(true)
                void (controller.state.uncertain ? controller.check() : controller.sync())
              },
            },
          ]}
        />
      ) : null}
    </>
  )
}

export function SkillagerSyncProgress({
  controller,
  local,
}: {
  readonly controller: SkillagerLibrarySyncController
  readonly local: boolean
}) {
  const { state } = controller
  const [page, setPage] = useState(0)
  useEffect(() => setPage(0), [state.completion])
  if (!state.busy && !state.message && !state.completion) return null
  const completion = state.completion
  return (
    <div className="skillager-sync-progress">
      <p role="status">
        {state.busy === 'checking'
          ? 'Checking approved skills…'
          : state.busy === 'syncing'
            ? 'Syncing approved skills…'
            : (state.message ??
              (completion
                ? `Sync ${completion.status}. ${
                    SKILLAGER_SYNC_OUTCOMES.filter((key) => completion.counts[key])
                      .map((key) => `${completion.counts[key]} ${key}`)
                      .join(' · ') || 'No approved sources to sync.'
                  }`
                : ''))}
      </p>
      {state.busy ? (
        <>
          <p>
            {local
              ? 'Approved sources available from this local project.'
              : 'Approved skills available on this computer; remote project sources are not scanned.'}
          </p>
          <button type="button" onClick={controller.cancel}>
            Cancel sync
          </button>
        </>
      ) : null}
      {state.uncertain && !state.busy ? (
        <SkillagerSyncAction controller={controller} />
      ) : null}
      {completion ? (
        <details>
          <summary>Sync details · {completion.items.length} sources</summary>
          <p>
            {completion.coverage.processedSources} of{' '}
            {completion.coverage.selectedSources} selected sources processed.{' '}
            {completion.coverage.complete
              ? 'All selected sources accounted for.'
              : 'Coverage incomplete; remaining work needs another explicit sync.'}
            {completion.coverage.discoveryErrors
              ? ` ${completion.coverage.discoveryErrors} discovery errors.`
              : ''}
          </p>
          <ol start={page * PAGE_SIZE + 1} className="skillager-sync-items">
            {completion.items
              .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
              .map((item) => (
                <li key={item.sourceIdentity}>
                  <strong>{item.canonicalSkillId ?? item.sourceIdentity}</strong> ·{' '}
                  {item.outcome}
                  <br />
                  {item.phase}
                  {item.reason ? ` · ${item.reason.replaceAll('-', ' ')}` : ''}
                  {item.repair !== 'none' ? (
                    <p>Next step: {item.repair.replaceAll('-', ' ')}.</p>
                  ) : null}
                  {item.recoveryPath ? (
                    <p>
                      Recovery retained at {item.recoveryPath.hostId}:
                      {item.recoveryPath.path}
                    </p>
                  ) : null}
                </li>
              ))}
          </ol>
          {completion.items.length > PAGE_SIZE ? (
            <nav aria-label="Sync outcome pages">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </button>
              <span>
                {page + 1} / {Math.ceil(completion.items.length / PAGE_SIZE)}
              </span>
              <button
                type="button"
                disabled={(page + 1) * PAGE_SIZE >= completion.items.length}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </nav>
          ) : null}
        </details>
      ) : null}
    </div>
  )
}
