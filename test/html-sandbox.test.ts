import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { HTML_PREVIEW_CSP, HTML_PREVIEW_SCHEME, HTML_SANDBOX } from '../src/shared'

describe('HTML preview sandbox policy', () => {
  it('runs scripts without granting an origin, popups, or navigation', () => {
    expect(HTML_SANDBOX.split(/\s+/)).toContain('allow-scripts')
    expect(HTML_SANDBOX).not.toContain('allow-same-origin')
    expect(HTML_SANDBOX).not.toContain('allow-popups')
    expect(HTML_SANDBOX).not.toContain('allow-top-navigation')
    expect(HTML_SANDBOX).not.toContain('allow-forms')
  })

  it('keeps the preview CSP separate from the workbench document', () => {
    const attackPage = readFileSync(
      join(process.cwd(), 'test/fixtures/html-sandbox-attack.html'),
      'utf8',
    )
    const workbench = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')

    expect(attackPage).toContain('globalThis.preHeadRan')
    expect(HTML_PREVIEW_CSP).toContain("script-src 'unsafe-inline'")
    expect(HTML_PREVIEW_CSP).toContain("connect-src 'none'")
    expect(HTML_PREVIEW_CSP).toContain("form-action 'none'")
    expect(HTML_PREVIEW_CSP).toContain("object-src 'none'")
    expect(workbench).toContain(`frame-src ${HTML_PREVIEW_SCHEME}:`)
    expect(workbench).not.toContain('nonce-hvir-html-preview')
    expect(workbench).not.toContain("script-src 'self' 'unsafe-inline'")
  })
})
