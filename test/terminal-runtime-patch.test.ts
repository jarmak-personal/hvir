import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertTerminalRuntimePatch,
  verifyTerminalRuntimePatch,
} from '../scripts/check-terminal-runtime-patch.mts'

describe('terminal runtime patch preflight', () => {
  it('accepts the installed ghostty terminal presentation patch', () => {
    const root = process.cwd()

    expect(() =>
      execFileSync(
        process.execPath,
        [join(root, 'scripts/check-terminal-runtime-patch.mts')],
        {
          cwd: root,
        },
      ),
    ).not.toThrow()
  })

  it('reports every missing presentation capability and the recovery command', () => {
    class UnpatchedTerminal {}

    expect(() => assertTerminalRuntimePatch(UnpatchedTerminal)).toThrow(
      /requestRender, setRenderPaused, resetCursorBlink, getRenderStats, custom link-provider priority.*npm ci.*retry the command/,
    )
  })

  it('rejects a runtime that lets built-in links override custom routing', () => {
    class UnprioritizedTerminal {
      requestRender(): void {}
      setRenderPaused(): void {}
      resetCursorBlink(): void {}
      getRenderStats(): void {}
      registerLinkProvider(): void {}
    }

    expect(() => assertTerminalRuntimePatch(UnprioritizedTerminal)).toThrow(
      /custom link-provider priority/,
    )
  })

  it('reports an install mismatch when ghostty-web cannot be loaded', async () => {
    await expect(
      verifyTerminalRuntimePatch(() => Promise.reject(new Error('module unavailable'))),
    ).rejects.toThrow(/ghostty-web could not be loaded.*npm ci.*retry the command/)
  })

  it('reports an install mismatch when the Terminal export is absent', async () => {
    await expect(
      verifyTerminalRuntimePatch(() => Promise.resolve(undefined)),
    ).rejects.toThrow(
      /ghostty-web does not export the required Terminal constructor.*npm ci.*retry the command/,
    )
  })

  it('runs the preflight before development and production builds', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> }

    expect(packageJson.scripts.predev).toBe(
      'node scripts/check-terminal-runtime-patch.mts',
    )
    expect(packageJson.scripts.prebuild).toBe(
      'node scripts/check-terminal-runtime-patch.mts',
    )
  })
})
