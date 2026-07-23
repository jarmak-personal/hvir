// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTerminalAttentionController } from '../src/renderer/src/terminal/use-terminal-attention-controller'
import type { TerminalSession } from '../src/renderer/src/terminal/terminal-workspace-model'
import { asHarnessProfileId, asHarnessProviderId, localPath } from '../src/shared'

let controller: ReturnType<typeof useTerminalAttentionController> | undefined
let host: HTMLDivElement
let root: Root
let session: TerminalSession

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  session = terminalSession()
  act(() => {
    root.render(
      <AttentionControllerProbe
        onUpdateSession={(id, update) => {
          if (id === session.id) session = update(session)
        }}
      />,
    )
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  controller = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('terminal attention controller', () => {
  it('advances unfocused submitted-turn output from working to ready at the threshold', () => {
    act(() => {
      controller?.recordInput(session.id, '\r')
      controller?.recordOutput(session.id)
    })
    expect(session.attention).toBe('working')

    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(session.attention).toBe('working')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(session.attention).toBe('idle')
  })
})

function AttentionControllerProbe({
  onUpdateSession,
}: {
  readonly onUpdateSession: Parameters<
    typeof useTerminalAttentionController
  >[0]['onUpdateSession']
}) {
  controller = useTerminalAttentionController({
    idleThresholdMs: 1_000,
    onUpdateSession,
  })
  return null
}

function terminalSession(): TerminalSession {
  return {
    id: 'terminal-1',
    providerId: asHarnessProviderId('codex'),
    profileId: asHarnessProfileId('codex-default'),
    launchRevision: 1,
    riskAcknowledged: false,
    capabilities: {
      sessionIdentity: 'discovered',
      exactResume: true,
      contextPresentation: 'none',
    },
    fallbackTitle: 'Codex · repo',
    title: 'Codex · repo',
    status: 'pid 73',
    resumeOnStart: false,
    pane: 'primary',
    cwd: localPath('/repo'),
  }
}
