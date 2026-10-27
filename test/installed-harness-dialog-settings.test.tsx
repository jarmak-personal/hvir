// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import { runInstalledHarnessDialogExercise } from '../scripts/installed-harness-dialog-probe.mjs'
import { SettingsDialog } from '../src/renderer/src/settings/SettingsDialog'
import { normalizeAppSettings } from '../src/renderer/src/settings/settings'
import { useWorkbenchOverlays } from '../src/renderer/src/workbench/use-workbench-overlays'
import {
  asHarnessProviderId,
  localPath,
  type HarnessProfileProbe,
  type HarnessProviderDescriptor,
} from '../src/shared'

const workspaceRoot = localPath('/tmp/hvir-installed-harness-dialog')
const settings = normalizeAppSettings({})

/** Real Settings routing and profile dialogs; only the terminal menu shell is a fixture. */
function WorkbenchSettingsFixture() {
  const overlays = useWorkbenchOverlays()
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <>
      <button aria-label="New terminal" onClick={() => setMenuOpen(true)} />
      {menuOpen ? (
        <div className="terminal-new-menu">
          <button
            onClick={() => {
              setMenuOpen(false)
              overlays.openAddHarnessSettings()
            }}
          >
            Add a harness…
          </button>
        </div>
      ) : null}
      <button aria-label="Open settings" onClick={() => overlays.openSettings()} />
      <SettingsDialog
        open={overlays.settingsOpen}
        initialDestination={overlays.settingsDestination}
        theme="dark"
        settings={settings}
        workspaceRoot={workspaceRoot}
        projectRoot={workspaceRoot}
        onClose={overlays.closeSettings}
        onSave={overlays.closeSettings}
      />
    </>
  )
}

it('exercises both entries through the still-open real Harnesses Settings view', async () => {
  vi.useFakeTimers()
  const claude: HarnessProviderDescriptor = {
    id: asHarnessProviderId('claude-code'),
    displayName: 'Claude Code',
    default: false,
    capabilities: {
      exactResume: false,
      sessionIdentity: 'none',
      contextPresentation: 'none',
    },
    terminalInput: { modifiedKeyProtocol: 'none', metaEnterAliasesControl: false },
    profileTemplate: { displayName: 'Claude Code', description: 'Claude Code' },
    profileGuidance: { reservedArguments: [] },
  }
  const shell: HarnessProviderDescriptor = {
    ...claude,
    id: asHarnessProviderId('plain-shell'),
    displayName: 'Shell',
    default: true,
    profileTemplate: { displayName: 'Shell', description: 'Interactive shell' },
  }
  let finishProbes: (value: readonly HarnessProfileProbe[]) => void = () => {}
  const pendingProbes = new Promise<readonly HarnessProfileProbe[]>((resolve) => {
    finishProbes = resolve
  })
  vi.stubGlobal('hvir', {
    invoke: vi.fn((channel: string) => {
      if (channel === 'harness:catalog') return Promise.resolve([claude, shell])
      if (channel === 'harness:probe-templates') return pendingProbes
      if (channel === 'harness:preview')
        return Promise.resolve({ mode: 'fresh', command: '/bin/sh' })
      return Promise.resolve([])
    }),
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    act(() => root.render(<WorkbenchSettingsFixture />))
    let outcome: { readonly value?: string; readonly error?: unknown } | undefined
    act(() => {
      void runInstalledHarnessDialogExercise().then(
        (value) => {
          outcome = { value }
        },
        (error: unknown) => {
          outcome = { error }
        },
      )
    })
    for (let elapsed = 0; !outcome && elapsed < 10_000; elapsed += 25) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25)
      })
    }

    expect(outcome?.error).toBeUndefined()
    expect(outcome?.value).toBe(
      'both add-harness entries painted while Claude probe was pending; direct shell draft retained the dirty guard',
    )
    expect(document.querySelector('.settings-dialog')).toBeNull()
  } finally {
    await act(async () => {
      root.unmount()
      finishProbes([])
      await pendingProbes
    })
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
