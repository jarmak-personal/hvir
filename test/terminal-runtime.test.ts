import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertTerminalRuntimeContract,
  verifyInstalledTerminalWasmEvidence,
  verifyTerminalRuntimeContract,
} from '../scripts/check-terminal-runtime.mts'
import { GHOSTTY_TERMINAL_CAPABILITY_PROFILE } from '../scripts/ghostty-terminal-capability-profile.mts'

class CompatibleParser {
  isSynchronizedOutput(): void {}
  getSynchronizedOutputGeneration(): void {}
  resetSynchronizedOutput(): void {}
}

describe('terminal runtime capability preflight', () => {
  it('accepts the installed ghostty-web runtime contract', () => {
    const root = process.cwd()

    expect(() =>
      execFileSync(process.execPath, [join(root, 'scripts/check-terminal-runtime.mts')], {
        cwd: root,
      }),
    ).not.toThrow()
  })

  it('reports every missing presentation capability and the recovery command', () => {
    class IncompatibleTerminal {}

    expect(() =>
      assertTerminalRuntimeContract({
        Terminal: IncompatibleTerminal,
        GhosttyTerminal: IncompatibleTerminal,
      }),
    ).toThrow(
      /requestRender, setRenderPaused, resetCursorBlink, getRenderStats, resolveEventProvenance, hasSelection, getSelection, paste, selectAll, clear, reset, searchRetainedBuffer, cancelRetainedBufferSearch, extractRetainedBufferRange, cancelRetainedBufferExtraction, captureRetainedBufferBoundary, isSynchronizedOutput, getSynchronizedOutputGeneration, resetSynchronizedOutput, custom link-provider priority.*npm ci.*retry the command/,
    )
  })

  it('rejects a runtime that lets built-in links override custom routing', () => {
    class UnprioritizedTerminal {
      requestRender(): void {}
      setRenderPaused(): void {}
      resetCursorBlink(): void {}
      getRenderStats(): void {}
      resolveEventProvenance(): void {}
      hasSelection(): void {}
      getSelection(): void {}
      paste(): void {}
      selectAll(): void {}
      clear(): void {}
      reset(): void {}
      registerLinkProvider(): void {}
    }

    expect(() =>
      assertTerminalRuntimeContract({
        Terminal: UnprioritizedTerminal,
        GhosttyTerminal: CompatibleParser,
      }),
    ).toThrow(/custom link-provider priority/)
  })

  it('reports an install mismatch when ghostty-web cannot be loaded', async () => {
    await expect(
      verifyTerminalRuntimeContract(() =>
        Promise.reject(new Error('module unavailable')),
      ),
    ).rejects.toThrow(/ghostty-web could not be loaded.*npm ci.*retry the command/)
  })

  it('reports an install mismatch when the Terminal export is absent', async () => {
    await expect(
      verifyTerminalRuntimeContract(() => Promise.resolve(undefined)),
    ).rejects.toThrow(
      /ghostty-web does not export the required Terminal and GhosttyTerminal constructors.*npm ci.*retry the command/,
    )
  })

  it('matches the installed WASM size to the reviewed capability evidence', async () => {
    await expect(verifyInstalledTerminalWasmEvidence()).resolves.toBeUndefined()
    await expect(
      verifyInstalledTerminalWasmEvidence(async () =>
        Promise.resolve(GHOSTTY_TERMINAL_CAPABILITY_PROFILE.artifact.wasmBytes - 1),
      ),
    ).rejects.toThrow(/ghostty-vt\.wasm is 523292 bytes.*requires 523293.*npm ci/)
  })

  it('pins the consumed package URL and npm lock integrity', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> }
    const packageLock = JSON.parse(
      readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
    ) as { packages: Record<string, { resolved?: string; integrity?: string }> }
    const profile = GHOSTTY_TERMINAL_CAPABILITY_PROFILE

    expect(packageJson.dependencies['ghostty-web']).toBe(profile.artifact.url)
    expect(packageLock.packages['node_modules/ghostty-web']?.resolved).toBe(
      profile.artifact.url,
    )
    expect(packageLock.packages['node_modules/ghostty-web']?.integrity).toBe(
      profile.artifact.npmIntegrity,
    )
  })

  it('runs the preflight before development and production builds', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> }

    expect(packageJson.scripts.predev).toBe('node scripts/check-terminal-runtime.mts')
    expect(packageJson.scripts.prebuild).toBe('node scripts/check-terminal-runtime.mts')
  })
})
