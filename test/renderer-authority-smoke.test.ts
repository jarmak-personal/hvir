import { readFileSync } from 'node:fs'

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import { waitForRendererAuthorityCondition } from '../src/main/smoke/renderer-authority'

const rendererAuthoritySource = readFileSync(
  new URL('../src/main/smoke/renderer-authority.ts', import.meta.url),
  'utf8',
)
const rendererRecoverySource = readFileSync(
  new URL('../src/main/smoke/renderer-recovery.ts', import.meta.url),
  'utf8',
)
const windowManagerSource = readFileSync(
  new URL('../src/main/window/electron-window-manager.ts', import.meta.url),
  'utf8',
)
const mainEntrySource = readFileSync(
  new URL('../src/main/index.ts', import.meta.url),
  'utf8',
)

describe('renderer-authority smoke boundaries', () => {
  it('accepts slow semantic readiness without an operation deadline', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const checkpoints: string[] = []
    let ready = false
    const operation = waitForRendererAuthorityCondition(
      'renderer-authority-resource-revocation-awaiting',
      () => ready,
      (checkpoint) => checkpoints.push(checkpoint),
      {
        pollIntervalMs: 25,
        diagnosisTimeoutMs: 25,
      },
    )
    await vi.advanceTimersByTimeAsync(100)
    ready = true
    await vi.advanceTimersByTimeAsync(25)
    await operation
    expect(checkpoints).toEqual(['renderer-authority-resource-revocation-awaiting'])
  })

  it('keeps only the real destruction-to-resource-revocation boundary', () => {
    expect(rendererAuthoritySource).not.toContain('routes.open(')
    expect(rendererAuthoritySource).not.toContain('htmlPreviews')
    expect(rendererAuthoritySource).not.toContain('net.fetch')
    expect(rendererAuthoritySource).toContain("type: 'filename-search'")
    expect(rendererAuthoritySource).toContain("'destroyed'")
    expect(rendererAuthoritySource).not.toContain('location.reload()')
    expect(rendererAuthoritySource).not.toContain("'did-finish-load'")
    expect(rendererRecoverySource).toContain('routes.open(')
    expect(rendererRecoverySource).toContain("'did-finish-load'")
    expect(rendererRecoverySource).toContain("process.kill(initialProcessId, 'SIGKILL')")
    expect(rendererRecoverySource).not.toContain('reloadUnresponsiveRenderer')
    expect(rendererRecoverySource).not.toContain("'render-process-gone'")
    expect(rendererRecoverySource).not.toContain("'renderer-recovery-exit-awaiting'")
    expect(rendererRecoverySource).not.toContain('win.webContents.capturePage()')
    expect(
      rendererRecoverySource.indexOf(
        'const initialProcessId = win.webContents.getOSProcessId()',
      ),
    ).toBeGreaterThan(
      rendererRecoverySource.indexOf("checkpoint('renderer-recovery-route-opened')"),
    )
    expect(rendererRecoverySource).toContain("event.reason === 'killed'")
    expect(rendererRecoverySource).toContain("window.hvir.invoke('app:info'")
    expect(rendererRecoverySource).toContain(
      "'renderer-recovery-replacement-ipc-awaiting'",
    )
    expect(rendererRecoverySource).toContain(
      "'renderer-recovery-route-revocation-awaiting'",
    )
    expect(rendererRecoverySource).toContain(
      '!routes.has(route.paneId, initialOwner.id, initialOwner.generation)',
    )
    expect(rendererAuthoritySource).toContain(
      "'renderer-authority-resource-revocation-awaiting'",
    )
    expect(windowManagerSource).toContain(
      "win.webContents.once('destroyed', revokeRendererResources)",
    )
    expect(windowManagerSource).toContain('dependencies.revokeRenderer(rendererOwner)')
    expect(rendererAuthoritySource).not.toContain('rolloverPreview')
    expect(rendererAuthoritySource).not.toContain('destructionRoute')
  })

  it('keeps Linux last-window shutdown under the smoke cleanup owner', () => {
    expect(mainEntrySource).toContain(
      "if (!__HVIR_SMOKE_BUILD__ && process.platform !== 'darwin') app.quit()",
    )
  })
})
