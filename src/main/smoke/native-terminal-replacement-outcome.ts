interface ReplacementRoot {
  readonly hostId?: string
  readonly path?: string
}
export interface NativeReplacementExpected {
  readonly sessionId: string
  readonly instanceId: string
  readonly pid: number
  readonly handle: string
  readonly ownerId: number
  readonly previousOwnerGeneration: number
  readonly providerId: string
  readonly profileId: string | null
  readonly workspaceRoot: { readonly hostId: string; readonly path: string }
}
interface ReplacementEvent {
  readonly operation?: string
  readonly state?: string
  readonly viewId?: string
  readonly ownerId?: number
  readonly ownerGeneration?: number
  readonly visible?: boolean
  readonly result?: boolean
  readonly error?: string
  readonly admission?: boolean
  readonly target?: number
  readonly frameCurrent?: boolean
  readonly issued?: boolean
  readonly refit?: boolean
  readonly attachment?: number
  readonly nativeEpoch?: string
  readonly geometrySerial?: number
  readonly mode?: string
  readonly reason?: string
  readonly sequence?: number
}
export interface NativeReplacementSnapshot {
  readonly recoveryDecision?: boolean
  readonly owner?: { readonly id?: number; readonly generation?: number }
  readonly retained?: {
    readonly id?: string
    readonly instanceId?: string
    readonly pid?: number
    readonly ownerId?: number
    readonly ownerGeneration?: number
    readonly providerId?: string
    readonly profileId?: string | null
    readonly workspaceRoot?: ReplacementRoot
  }
  readonly native?: {
    readonly handle?: string
    readonly instanceId?: string
    readonly ownerId?: number
    readonly ownerGeneration?: number
    readonly workspaceRoot?: ReplacementRoot
    readonly retiring?: boolean
    readonly unavailable?: boolean
    readonly inputUnavailable?: boolean
    readonly inputClosed?: boolean
    readonly readonly?: boolean
  }
  readonly presentation?: {
    readonly viewId?: string | null
    readonly issuedGrant?: {
      readonly viewId?: string
      readonly target?: number
      readonly frameCurrent?: boolean
      readonly attachment?: number
      readonly nativeEpoch?: string
      readonly geometrySerial?: number
    }
    readonly drawn?: { readonly screen?: number; readonly geometrySerial?: number } | null
    readonly observations?: {
      readonly startedBeforeReload?: boolean
      readonly total?: number
      readonly truncated?: boolean
      readonly readFailed?: boolean
      readonly currentView?: readonly ReplacementEvent[]
      readonly mainSendIsNotReceiverDelivery?: boolean
      readonly unboundRetained?: number
      readonly otherViewRetained?: number
      readonly demandSummary?: {
        readonly started?: number
        readonly fulfilled?: number
        readonly trueResults?: number
        readonly falseResults?: number
        readonly scope?: string
      }
    }
  }
  readonly dom?: {
    readonly hasCanvas?: boolean
    readonly canvasCount?: number
    readonly panes?: readonly {
      readonly viewId?: string | null
      readonly sessionId?: string | null
      readonly connected?: boolean
      readonly paneUnavailable?: boolean
      readonly surfaceUnavailable?: boolean
      readonly inputDisabled?: boolean | null
      readonly canvasPresent?: boolean
    }[]
    readonly dialogPresent?: boolean
    readonly restorePresent?: boolean
    readonly restoreDisabled?: boolean | null
  }
}
const nonempty = (value: string | undefined | null): value is string =>
  typeof value === 'string' && value.length > 0
const positive = (value: number | undefined): value is number =>
  Number.isSafeInteger(value) && value! > 0
const sameRoot = (
  expected: NativeReplacementExpected['workspaceRoot'],
  actual?: ReplacementRoot,
) =>
  nonempty(expected.hostId) &&
  nonempty(expected.path) &&
  actual?.hostId === expected.hostId &&
  actual.path === expected.path

/** Classifies copied qualification facts only. The caller still owns live frame/
 * renderer revalidation, physical references, and any explicit recovery action. */
export function qualifyNativeReplacement(
  expected: NativeReplacementExpected,
  snapshot: NativeReplacementSnapshot,
): 'drawn' | 'quarantined' | undefined {
  const { owner, retained, native, presentation, dom } = snapshot
  const allPanes = dom?.panes
  if (
    !nonempty(expected.sessionId) ||
    !nonempty(expected.instanceId) ||
    !nonempty(expected.handle) ||
    !nonempty(expected.providerId) ||
    !(expected.profileId === null || nonempty(expected.profileId)) ||
    !positive(expected.pid) ||
    !Number.isSafeInteger(expected.ownerId) ||
    !Number.isSafeInteger(expected.previousOwnerGeneration) ||
    !owner ||
    owner.id !== expected.ownerId ||
    !positive(owner.generation) ||
    owner.generation <= expected.previousOwnerGeneration ||
    !retained ||
    retained.id !== expected.sessionId ||
    retained.instanceId !== expected.instanceId ||
    retained.pid !== expected.pid ||
    retained.providerId !== expected.providerId ||
    retained.profileId !== expected.profileId ||
    !sameRoot(expected.workspaceRoot, retained.workspaceRoot) ||
    retained.ownerId !== owner.id ||
    retained.ownerGeneration !== owner.generation ||
    !native ||
    native.handle !== expected.handle ||
    native.instanceId !== expected.instanceId ||
    native.ownerId !== owner.id ||
    native.ownerGeneration !== owner.generation ||
    !sameRoot(expected.workspaceRoot, native.workspaceRoot) ||
    native.retiring !== false ||
    native.unavailable !== false ||
    native.inputUnavailable !== false ||
    native.inputClosed !== false ||
    native.readonly !== false ||
    !presentation ||
    !nonempty(presentation.viewId) ||
    !dom ||
    !allPanes ||
    !Array.isArray(dom.panes)
  )
    return undefined
  const viewId = presentation.viewId
  const panes = allPanes.filter((pane) => pane.sessionId === expected.sessionId)
  if (panes.length !== 1) return undefined
  const pane = panes[0]!
  if (
    pane.viewId !== 'native-terminal-' + viewId ||
    pane.connected !== true ||
    pane.paneUnavailable !== false ||
    pane.inputDisabled !== false
  )
    return undefined
  const current = presentation.issuedGrant
  if (
    pane.canvasPresent === true &&
    pane.surfaceUnavailable === false &&
    current?.viewId === viewId &&
    current.frameCurrent === true &&
    positive(current.target) &&
    positive(current.attachment) &&
    nonempty(current.nativeEpoch) &&
    positive(current.geometrySerial) &&
    presentation.drawn &&
    (presentation.drawn.screen === 0 || presentation.drawn.screen === 1) &&
    presentation.drawn.geometrySerial === current.geometrySerial
  )
    return 'drawn'
  const observed = presentation.observations
  const events = observed?.currentView
  if (!observed || !events || !Array.isArray(observed.currentView)) return undefined
  const grants = events.filter((event) => event.operation === 'grant')
  const issued = grants.findLast((event) => event.issued === true)
  if (
    !issued ||
    issued.viewId !== viewId ||
    !positive(issued.sequence) ||
    issued.state !== 'returned' ||
    issued.frameCurrent !== true ||
    !positive(issued.target) ||
    !positive(issued.attachment) ||
    !positive(issued.geometrySerial) ||
    !nonempty(issued.nativeEpoch)
  )
    return undefined
  const latestGrant = grants.at(-1)
  const latestStatus = events.at(-1)
  if (
    observed.startedBeforeReload !== true ||
    observed.truncated !== false ||
    observed.readFailed !== false ||
    observed.mainSendIsNotReceiverDelivery !== true ||
    !positive(observed.total) ||
    !events.length ||
    events.length > 32
  )
    return undefined
  let previous = 0
  for (const event of events) {
    if (
      event.viewId !== viewId ||
      !positive(event.sequence) ||
      event.sequence <= previous ||
      event.sequence > observed.total ||
      ((event.operation === 'update' || event.operation === 'demand') &&
        event.state === 'rejected') ||
      (event.operation === 'status' &&
        event.mode === 'unavailable' &&
        event.reason !== 'import-unavailable')
    )
      return undefined
    if (event.operation === 'grant' || event.operation === 'status') {
      if (
        event.state !== 'returned' ||
        event.frameCurrent !== true ||
        event.target !== issued.target
      )
        return undefined
    } else if (event.operation === 'update' || event.operation === 'demand') {
      if (event.ownerId !== owner.id || event.ownerGeneration !== owner.generation)
        return undefined
    } else return undefined
    previous = event.sequence
  }
  if (
    pane.canvasPresent !== false ||
    pane.surfaceUnavailable !== true ||
    presentation.drawn !== null ||
    !latestGrant ||
    latestGrant.issued !== false ||
    latestGrant.state !== 'returned' ||
    latestGrant.frameCurrent !== true ||
    latestGrant.target !== issued.target ||
    !latestStatus ||
    latestStatus.operation !== 'status' ||
    latestStatus.state !== 'returned' ||
    latestStatus.frameCurrent !== true ||
    latestStatus.target !== issued.target ||
    latestStatus.mode !== 'unavailable' ||
    latestStatus.reason !== 'import-unavailable' ||
    !(
      issued.sequence < latestGrant.sequence! &&
      latestGrant.sequence! < latestStatus.sequence!
    )
  )
    return undefined
  const fulfilled = events.find(
    (event) =>
      event.operation === 'update' &&
      issued.sequence! < event.sequence! &&
      event.sequence! < latestGrant.sequence!,
  )
  const started = events.findLast(
    (event) => event.operation === 'update' && event.sequence! < issued.sequence!,
  )
  return fulfilled?.state === 'fulfilled' &&
    fulfilled.visible === true &&
    fulfilled.ownerId === owner.id &&
    fulfilled.ownerGeneration === owner.generation &&
    started?.state === 'started' &&
    started.visible === true &&
    started.ownerId === owner.id &&
    started.ownerGeneration === owner.generation
    ? 'quarantined'
    : undefined
}
