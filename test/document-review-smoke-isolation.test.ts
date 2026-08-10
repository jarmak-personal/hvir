import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('document review smoke isolation', () => {
  it('uses and cleans an exact smoke-root draft path', async () => {
    const source = await readFile('src/main/smoke/index.ts', 'utf8')

    expect(source).toContain(
      "const documentReviewPath = joinHostPath(\n    smokeRoot,\n    '.hvir-smoke-document-review-drafts.json',\n  )",
    )
    expect(source).not.toContain("applicationUserDataPath('document-review-drafts.json')")
    expect(source.match(/host\.removeFile\(documentReviewPath/g)).toHaveLength(2)
    expect(source).toContain(
      'host.removeFile(documentReviewPath, { ignoreMissing: true })',
    )
  })
})
