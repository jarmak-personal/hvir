import { readFileSync } from 'node:fs'

import { describe, expect, it, onTestFinished, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { waitForRendererAuthorityCondition } from '../src/main/smoke/renderer-authority'

const rendererAuthoritySource = readFileSync(
  new URL('../src/main/smoke/renderer-authority.ts', import.meta.url),
  'utf8',
)
const mainEntrySource = readFileSync(
  new URL('../src/main/index.ts', import.meta.url),
  'utf8',
)

describe('renderer-authority smoke boundaries', () => {
  it('fails a never-settling Electron operation at its named inner boundary', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const checkpoints: string[] = []
    const operation = waitForRendererAuthorityCondition(
      'renderer-authority-replacement-ipc-awaiting',
      () => new Promise<never>(() => undefined),
      'replacement renderer did not regain IPC authority',
      (checkpoint) => checkpoints.push(checkpoint),
      {
        operationTimeoutMs: 100,
        predicateTimeoutMs: 25,
        pollIntervalMs: 1,
        diagnosisTimeoutMs: 25,
      },
    )
    const failure = expect(operation).rejects.toThrow(
      'renderer-authority-replacement-ipc-awaiting timed out after 25ms',
    )

    await vi.advanceTimersByTimeAsync(25)

    await failure
    expect(checkpoints).toEqual(['renderer-authority-replacement-ipc-awaiting'])
  })

  it('keeps only the real-Electron route reload and preview destruction proofs', () => {
    expect(rendererAuthoritySource.match(/routes\.open\(/g)).toHaveLength(1)
    expect(rendererAuthoritySource.match(/htmlPreviews\.create\(/g)).toHaveLength(1)
    expect(rendererAuthoritySource).toContain("'did-finish-load'")
    expect(rendererAuthoritySource).toContain("'destroyed'")
    expect(rendererAuthoritySource).toContain('win.webContents.executeJavaScript')
    expect(rendererAuthoritySource).toContain('location.reload()')
    expect(rendererAuthoritySource).not.toContain('win.webContents.reload()')
    expect(rendererAuthoritySource).toContain(
      "'renderer-authority-route-revocation-awaiting'",
    )
    expect(rendererAuthoritySource).toContain(
      "'renderer-authority-preview-revocation-awaiting'",
    )
    expect(rendererAuthoritySource).not.toContain('rolloverPreview')
    expect(rendererAuthoritySource).not.toContain('destructionRoute')
  })

  it('keeps Linux last-window shutdown under the smoke cleanup owner', () => {
    expect(mainEntrySource).toContain(
      "if (!process.env['HVIR_SMOKE'] && process.platform !== 'darwin') app.quit()",
    )
  })
})
