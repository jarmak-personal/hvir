import {
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

import type {
  HarnessContextPressurePolicy,
  HarnessUsageValue,
  SessionsContextFact,
  SessionsFact,
  SessionsUsageFact,
} from '../../../shared'
import { useViewportContextMenuPosition } from '../context-menu/viewport-context-menu'
import { ProviderContextMeter } from './ProviderContextMeter'
import type { CompactionMarkerFact } from './CompactionMarkers'
import type {
  SessionDetailsPopoverController,
  SessionDetailsRequest,
} from './use-session-details-popover'

export interface SessionDetailsModel {
  readonly title: string
  readonly provider: string
  readonly profile: string
  readonly model: SessionsFact<{ readonly id: string; readonly displayName?: string }>
  readonly workspace: string
  readonly host: string
  readonly state: string
  readonly context: SessionsFact<SessionsContextFact>
  readonly compactions: CompactionMarkerFact
  readonly freshness: SessionsFact<{ readonly staleAfterMs: number }>
  readonly usage: SessionsUsageFact
  readonly pressurePolicy?: HarnessContextPressurePolicy
}

export function SessionDetailsPopover({
  controller,
  details,
}: {
  readonly controller: SessionDetailsPopoverController
  /** Undefined is still loading; null means the requested session is unavailable. */
  readonly details?: SessionDetailsModel | null
}): ReactElement | null {
  const request = controller.request
  const requestAvailable = request !== undefined
  const dismiss = controller.dismiss
  const popover = useRef<HTMLDivElement>(null)
  const detailsAvailable = details !== undefined && details !== null
  useEffect(() => {
    if (requestAvailable && details === null) dismiss(false)
  }, [details, dismiss, requestAvailable])
  useEffect(() => {
    if (!requestAvailable || !detailsAvailable) return
    const pointer = (event: PointerEvent): void => {
      if (!popover.current?.contains(event.target as Node)) dismiss(false)
    }
    const keyboard = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      dismiss(true)
    }
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('keydown', keyboard, true)
    return () => {
      document.removeEventListener('pointerdown', pointer)
      document.removeEventListener('keydown', keyboard, true)
    }
  }, [detailsAvailable, dismiss, request?.id, requestAvailable])
  if (!request || !details) return null

  const compaction = factValue(details.compactions)
  return createPortal(
    <PositionedSessionDetails
      key={request.id}
      popover={popover}
      request={request}
      title={details.title}
    >
      <header>
        <div>
          <span>Session details</span>
          <strong>{details.title}</strong>
        </div>
        <button
          type="button"
          aria-label="Close session details"
          onClick={() => dismiss(true)}
          className="hvir-button"
        >
          ×
        </button>
      </header>
      <ProviderContextMeter
        contextFacet={details.context}
        pressurePolicy={details.pressurePolicy}
      />
      <dl>
        <Detail
          label="Current context"
          value={contextText(details.context, details.pressurePolicy)}
        />
        <Detail
          label="Observed compactions"
          value={
            compaction
              ? String(compaction.observedCount)
              : factStatus(details.compactions)
          }
        />
        <Detail
          label="Observation coverage"
          value={
            compaction
              ? compaction.coverage === 'gapped'
                ? 'Current app period · gaps observed'
                : 'Current app period · continuous'
              : factStatus(details.compactions)
          }
        />
        <Detail
          label="Last compaction"
          value={
            compaction?.lastObservedAt
              ? new Date(compaction.lastObservedAt).toLocaleString()
              : compaction
                ? 'None observed'
                : factStatus(details.compactions)
          }
        />
        <Detail
          label="Fresh input"
          value={usageCounter(details.usage, 'freshInputTokens')}
        />
        <Detail
          label="Cached input"
          value={usageCounter(details.usage, 'cacheReadInputTokens')}
        />
        <Detail
          label="Cache writes"
          value={usageCounter(details.usage, 'cacheWriteInputTokens')}
        />
        <Detail label="Output" value={usageCounter(details.usage, 'outputTokens')} />
        <Detail
          label="Reasoning output detail"
          value={usageCounter(details.usage, 'reasoningTokens')}
        />
        <Detail
          label="Provider / profile"
          value={`${details.provider} · ${details.profile}`}
        />
        <Detail label="Model" value={modelText(details.model)} />
        <Detail label="Workspace" value={details.workspace} />
        <Detail label="Host" value={details.host} />
        <Detail label="Session state" value={details.state} />
        <Detail label="Telemetry freshness" value={freshnessText(details.freshness)} />
      </dl>
    </PositionedSessionDetails>,
    document.body,
  )
}

function PositionedSessionDetails({
  popover,
  request,
  title,
  children,
}: {
  readonly popover: RefObject<HTMLDivElement | null>
  readonly request: SessionDetailsRequest
  readonly title: string
  readonly children: ReactNode
}): ReactElement {
  const position = useViewportContextMenuPosition(popover, request)
  useEffect(() => {
    if (!request.focusPopover) return
    popover.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [popover, request.focusPopover])
  return (
    <div
      ref={popover}
      className="session-details-popover"
      role="dialog"
      aria-modal="false"
      aria-label={`Session details for ${title}`}
      style={position}
    >
      {children}
    </div>
  )
}

function Detail({
  label,
  value,
}: {
  readonly label: string
  readonly value: string
}): ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function factValue(
  fact: CompactionMarkerFact,
):
  | import('../../../shared').HarnessCompactionFacet
  | import('../../../shared').SessionsCompactionFact
  | undefined {
  return fact.status === 'available' || fact.status === 'stale' ? fact.value : undefined
}

function factStatus(fact: { readonly status: string }): string {
  switch (fact.status) {
    case 'pending':
      return 'Pending'
    case 'stale':
      return 'Stale'
    case 'unsupported':
      return 'Unsupported by this provider version'
    default:
      return 'Unavailable'
  }
}

function contextText(
  fact: SessionsFact<SessionsContextFact>,
  policy?: HarnessContextPressurePolicy,
): string {
  if (fact.status !== 'available' && fact.status !== 'stale') return factStatus(fact)
  const capacity = fact.value.windowTokens ?? policy?.assumedWindowTokens
  const percent =
    fact.value.usedPercent ??
    (capacity ? (fact.value.usedTokens / capacity) * 100 : undefined)
  return `${tokenCount(fact.value.usedTokens)}${capacity ? ` / ${tokenCount(capacity)}${fact.value.windowTokens === undefined ? ' assumed' : ''}` : ''}${percent === undefined ? '' : ` · ${Math.floor(percent)}%`}`
}

function usageValue(fact: SessionsUsageFact): HarnessUsageValue | undefined {
  return fact.status === 'exact' || fact.status === 'partial' || fact.status === 'stale'
    ? fact.value
    : undefined
}

function usageCounter(fact: SessionsUsageFact, key: keyof HarnessUsageValue): string {
  const value = usageValue(fact)?.[key]
  const suffix =
    fact.status === 'partial' ? ' · partial' : fact.status === 'stale' ? ' · stale' : ''
  return typeof value === 'number' ? `${tokenCount(value)}${suffix}` : factStatus(fact)
}

function modelText(fact: SessionDetailsModel['model']): string {
  return fact.status === 'available' || fact.status === 'stale'
    ? (fact.value.displayName ?? fact.value.id)
    : factStatus(fact)
}

function freshnessText(fact: SessionDetailsModel['freshness']): string {
  if (fact.status === 'available')
    return `Fresh · ${Math.round(fact.value.staleAfterMs / 1000)}s window`
  if (fact.status === 'stale') return 'Stale'
  return factStatus(fact)
}

function tokenCount(value: number): string {
  return new Intl.NumberFormat().format(value)
}
