import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PRESENTATION_ASSETS,
  presentationTokenCss,
} from '../scripts/prepare-extension-ui.mts'

describe('captured public presentation assets', () => {
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
