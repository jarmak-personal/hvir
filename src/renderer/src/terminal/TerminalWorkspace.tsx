import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import {
  asSessionsTerminalHandle,
  sessionsProjectionTitle,
  type HostConnectionState,
  type HostPath,
  type MoveTerminalResponse,
  type SessionsWorkspaceQualifier,
  type WorkspaceState,
} from '../../../shared'
import type { SessionsRendererSession } from '../sessions/sessions-renderer-observation'
import { fitSplitPrimaryWidth } from '../layout/split-layout-policy'
import type { TerminalPreferences } from '../settings/settings'
import {
  normalizeTerminalWebTarget,
  resolveTerminalFileTarget,
  type ResolvedTerminalFileTarget,
} from './terminal-file-link'
import { TerminalDeck } from './TerminalDeck'
import { TerminalWorkspaceControls } from './TerminalWorkspaceControls'
import {
  readTerminalSplitLayout,
  writeTerminalSplitLayout,
} from './terminal-split-persistence'
import {
  initialTerminalWorkspaceModel,
  terminalPaneActiveId,
  terminalWorkspaceReducer,
  terminalWorkspaceActionAffectsSessionsProjection,
  terminalWorkspaceSplit,
  type TerminalSession,
  type TerminalWorkspaceAction,
} from './terminal-workspace-model'
import {
  useTerminalAttentionController,
  useTerminalAttentionRollup,
} from './use-terminal-attention-controller'
import { useTerminalProfiles } from './use-terminal-profiles'
import { useTerminalPersistence } from './use-terminal-persistence'
import { useTerminalRecovery } from './use-terminal-recovery'
import type { TerminalRuntimeRegistry } from './terminal-runtime-registry'
import {
  useTerminalWorkspaceMove,
  type TerminalWorkspaceController,
} from './use-terminal-workspace-move'
import { useTerminalSessionCommands } from './use-terminal-session-commands'

interface TerminalWorkspaceProps {
  readonly cwd: HostPath
  readonly workspaceId: string
  readonly sessionsWorkspaceQualifier: SessionsWorkspaceQualifier
  readonly connectionState: HostConnectionState
  readonly available: boolean
  readonly visible: boolean
  readonly presentationVisible: boolean
  readonly railCompact: boolean
  readonly onRailCompact: (compact: boolean) => void
  readonly label: string
  readonly onRollup: (workspaceId: string, rollup: TerminalWorkspaceRollup) => void
  readonly onOpenPath: (target: ResolvedTerminalFileTarget) => void
  readonly onOpenWebLink: (activation: {
    readonly terminalId: string
    readonly workspaceRoot: HostPath
    readonly url: string
  }) => void
  readonly preferences: TerminalPreferences
  readonly onOpenSettings: () => void
  readonly onOpenTerminalSettings: () => void
  readonly onOpenHarnessSettings: () => void
  readonly onAddHarness: () => void
  readonly runtimes: TerminalRuntimeRegistry
  readonly moveTargets: readonly WorkspaceState[]
  readonly onMaterializationChange: (workspaceId: string, retained: boolean) => void
  readonly onSessionsSource: (
    workspaceId: string,
    source: (() => readonly SessionsRendererSession[]) | undefined,
  ) => void
  readonly onSessionsChanged: (workspaceId: string) => void
  readonly onController: (
    workspaceId: string,
    controller: TerminalWorkspaceController | undefined,
  ) => void
  readonly onPrepareMoveTarget: (workspaceId: string) => Promise<void>
  readonly onReleaseMoveTarget: (workspaceId: string) => void
  readonly onTerminalMoved: (
    sessionId: string,
    sourceWorkspaceId: string,
    targetWorkspaceId: string,
    response: MoveTerminalResponse,
  ) => void
  readonly onAcknowledgeMoveTargets: (workspaceIds: readonly string[]) => Promise<void>
  readonly onError: (message: string) => void
}

export interface TerminalWorkspaceRollup {
  readonly actionable: number
  readonly working: number
}

export function TerminalWorkspace({
  cwd,
  workspaceId,
  sessionsWorkspaceQualifier,
  connectionState,
  available,
  visible,
  presentationVisible,
  railCompact,
  onRailCompact,
  label,
  onRollup,
  onOpenPath,
  onOpenWebLink,
  preferences,
  onOpenSettings,
  onOpenTerminalSettings,
  onOpenHarnessSettings,
  onAddHarness,
  runtimes,
  moveTargets,
  onMaterializationChange,
  onSessionsSource,
  onSessionsChanged,
  onController,
  onPrepareMoveTarget,
  onReleaseMoveTarget,
  onTerminalMoved,
  onAcknowledgeMoveTargets,
  onError,
}: TerminalWorkspaceProps): ReactElement {
  const workspaceRootRef = useRef(cwd)
  if (
    workspaceRootRef.current.hostId !== cwd.hostId ||
    workspaceRootRef.current.path !== cwd.path
  ) {
    workspaceRootRef.current = cwd
  }
  const workspaceRoot = workspaceRootRef.current
  const terminalDeckRef = useRef<HTMLDivElement>(null)
  const restoredSplitLayout = useRef(readTerminalSplitLayout(workspaceRoot))
  const [model, dispatch] = useReducer(terminalWorkspaceReducer, {
    ...initialTerminalWorkspaceModel,
    primaryWidth: restoredSplitLayout.current.primaryWidth,
  })
  const modelRef = useRef(model)
  const [menuOpen, setMenuOpen] = useState(false)
  const profileState = useTerminalProfiles({
    root: workspaceRoot,
    connectionState,
    menuOpen,
  })
  const { providers, profiles, probes, acceptCatalog, acceptRecoveryProbes } =
    profileState
  const send = useCallback(
    (action: TerminalWorkspaceAction): void => {
      const current = modelRef.current
      const next = terminalWorkspaceReducer(current, action)
      modelRef.current = next
      dispatch(action)
      if (next !== current && terminalWorkspaceActionAffectsSessionsProjection(action)) {
        onSessionsChanged(workspaceId)
      }
    },
    [onSessionsChanged, workspaceId],
  )
  modelRef.current = model
  useEffect(() => {
    onSessionsSource(workspaceId, () =>
      modelRef.current.sessions.map((session) => {
        const runtime = runtimes.sessionSnapshot(session.id)
        return {
          handle: asSessionsTerminalHandle(session.id),
          workspaceQualifier: sessionsWorkspaceQualifier,
          providerId: session.providerId,
          profileId: session.profileId,
          title: sessionsProjectionTitle(session.title),
          dormant: session.dormant === true,
          resumeOnStart: session.resumeOnStart,
          exited: runtime?.exited === true,
          recoveryUnavailable: runtime?.recoveryFailure !== undefined,
          attention: session.attention,
        }
      }),
    )
    return () => onSessionsSource(workspaceId, undefined)
  }, [onSessionsSource, runtimes, sessionsWorkspaceQualifier, workspaceId])
  const { sessions, activeId } = model
  useEffect(() => {
    onMaterializationChange(workspaceId, sessions.length > 0)
  }, [onMaterializationChange, sessions.length, workspaceId])
  const updateSession = useCallback(
    (id: string, update: (session: TerminalSession) => TerminalSession): void => {
      const session = modelRef.current.sessions.find((candidate) => candidate.id === id)
      if (!session) return
      const updated = update(session)
      if (updated !== session) send({ type: 'session-updated', session: updated })
    },
    [send],
  )
  const {
    reset: resetAttention,
    focusSession: focusAttentionSession,
    forgetSession: forgetAttentionSession,
    raiseAttention,
    recordInput,
    recordOutput,
  } = useTerminalAttentionController({
    idleThresholdMs: preferences.idleThresholdMs,
    onUpdateSession: updateSession,
  })
  useTerminalAttentionRollup({ workspaceId, sessions, onRollup })
  const recovery = useTerminalRecovery({
    root: workspaceRoot,
    available,
    visible,
    mode: preferences.terminalRecoveryMode,
    model,
    providers,
    profiles,
    probes,
    splitLayout: restoredSplitLayout.current,
    ports: {
      acceptCatalog,
      acceptProbes: acceptRecoveryProbes,
      resetAttention,
      send,
    },
  })
  const { ready: recoveryReady, defaultProvider, defaultProfile } = recovery
  useTerminalPersistence({ root: workspaceRoot, model, ready: recoveryReady })
  const commands = useTerminalSessionCommands({
    available,
    workspaceRoot,
    profiles,
    providers,
    probes,
    defaultProfile,
    defaultProvider,
    modelRef,
    send,
    closeLaunchMenu: () => setMenuOpen(false),
    focusAttention: focusAttentionSession,
    forgetAttention: forgetAttentionSession,
    runtimes,
  })
  const moving = useTerminalWorkspaceMove({
    workspaceId,
    modelRef,
    send,
    forgetAttention: forgetAttentionSession,
    moveTargets,
    registerController: onController,
    prepareMoveTarget: onPrepareMoveTarget,
    releaseMoveTarget: onReleaseMoveTarget,
    onMoved: onTerminalMoved,
    acknowledgeTargets: onAcknowledgeMoveTargets,
    onError,
  })

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menuOpen])

  const terminalSplit = terminalWorkspaceSplit(model)
  const primaryActiveId = terminalPaneActiveId(model, 'primary')
  const secondaryActiveId = terminalPaneActiveId(model, 'secondary')

  const setTerminalPrimaryWidth = (width: number): void => {
    const deck = terminalDeckRef.current
    if (!deck) return
    const next = fitSplitPrimaryWidth(width, deck.clientWidth, 220)
    deck.style.setProperty('--terminal-primary-track', `${next}px`)
    const layout = readTerminalSplitLayout(workspaceRoot)
    const updated = { ...layout, primaryWidth: next }
    restoredSplitLayout.current = updated
    writeTerminalSplitLayout(workspaceRoot, updated)
    send({ type: 'primary-width-changed', width: next })
  }

  const resetTerminalPrimaryWidth = (): void => {
    terminalDeckRef.current?.style.removeProperty('--terminal-primary-track')
    const updated = {
      ...readTerminalSplitLayout(workspaceRoot),
      primaryWidth: undefined,
    }
    restoredSplitLayout.current = updated
    writeTerminalSplitLayout(workspaceRoot, updated)
    send({ type: 'primary-width-changed', width: undefined })
  }
  return (
    <>
      <TerminalDeck
        deckRef={terminalDeckRef}
        label={label}
        visible={visible}
        presentationVisible={presentationVisible}
        available={available}
        ready={recoveryReady}
        sessions={sessions}
        providers={providers}
        activeId={activeId}
        primaryActiveId={primaryActiveId}
        secondaryActiveId={secondaryActiveId}
        split={terminalSplit}
        primaryWidth={model.primaryWidth}
        terminalTheme={preferences.terminalTheme}
        terminalLightThemeId={preferences.terminalLightThemeId}
        terminalDarkThemeId={preferences.terminalDarkThemeId}
        terminalTypography={preferences.terminalTypography}
        cursorDefaults={preferences.terminalCursorDefaults}
        ligatures={preferences.terminalLigatures}
        composerSubmitMode={preferences.composerSubmitMode}
        workspaceRoot={workspaceRoot}
        connectionState={connectionState}
        onCreateDefault={defaultProfile ? commands.startDefault : undefined}
        onUpdateSession={updateSession}
        onFreshStarted={commands.acceptFreshStart}
        onInput={recordInput}
        onOutput={recordOutput}
        onBell={(id) => raiseAttention(id, 'bell')}
        onFocus={commands.focus}
        onLink={(session, activation) => {
          if (activation.kind === 'file') {
            const resolved = resolveTerminalFileTarget(activation.target, workspaceRoot)
            if (resolved) onOpenPath(resolved)
            return
          }
          const url = normalizeTerminalWebTarget(activation.target)
          if (url) onOpenWebLink({ terminalId: session.id, workspaceRoot, url })
        }}
        onSplit={commands.split}
        onOpenTerminalSettings={onOpenTerminalSettings}
        onSetPrimaryWidth={setTerminalPrimaryWidth}
        onResetPrimaryWidth={resetTerminalPrimaryWidth}
        runtimes={runtimes}
      />
      {visible ? (
        <TerminalWorkspaceControls
          label={label}
          available={available}
          railCompact={railCompact}
          onRailCompact={onRailCompact}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          model={model}
          profileState={profileState}
          recovery={recovery}
          commands={commands}
          moving={moving}
          preferences={preferences}
          onOpenSettings={onOpenSettings}
          onOpenHarnessSettings={onOpenHarnessSettings}
          onAddHarness={onAddHarness}
        />
      ) : null}
    </>
  )
}
