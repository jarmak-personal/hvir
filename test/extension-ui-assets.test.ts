import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PRESENTATION_ASSETS,
  presentationTokenCss,
} from '../scripts/prepare-extension-ui.mts'

describe('captured public presentation assets', () => {
  it('copies from the script location outside the repository without changing source bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hvir-ui-copy-'))
    const source = new Map(
      PRESENTATION_ASSETS.map((asset) => [
        asset,
        readFileSync(`src/shared/presentation/${asset}`),
      ]),
    )
    try {
      execFileSync(
        process.execPath,
        [resolve('scripts/prepare-extension-ui.mts'), join(directory, 'package')],
        { cwd: directory, stdio: 'pipe' },
      )
      for (const asset of PRESENTATION_ASSETS) {
        expect(readFileSync(`src/shared/presentation/${asset}`)).toEqual(
          source.get(asset),
        )
        expect(readFileSync(join(directory, 'package', asset))).toEqual(source.get(asset))
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('ships the canonical token materialization and identical public primitive assets offline', async () => {
    expect(readFileSync('src/shared/presentation/tokens.css', 'utf8')).toBe(
      await presentationTokenCss(),
    )
    for (const asset of PRESENTATION_ASSETS)
      expect(readFileSync(`packages/extension-reference/${asset}`)).toEqual(
        readFileSync(`src/shared/presentation/${asset}`),
      )
    for (const page of ['index.html', 'detail.html', 'session.html']) {
      const html = readFileSync(`packages/extension-reference/${page}`, 'utf8')
      expect(html).toContain('href="presentation.css"')
      expect(html).toContain('src="guest-ui.js"')
      expect(html).not.toMatch(/(?:src|href)="https?:/)
    }
  })
})
