import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('architecture hotspot report', () => {
  it('reproduces the named baseline budgets from source', () => {
    const root = process.cwd()
    const output = execFileSync(
      process.execPath,
      [join(root, 'scripts/architecture-hotspots.mjs'), '--json'],
      { cwd: root, encoding: 'utf8' },
    )
    const report = JSON.parse(output) as {
      baselineCommit: string
      rows: {
        path: string
        lines: number
        limit?: number
        exception?: {
          owner: string
          rationale: string
          removalIssue: string
          expiresOn: string
        }
      }[]
    }
    const main = report.rows.find((row) => row.path === 'src/main/index.ts')
    expect(report.baselineCommit).toBe('ea1c157')
    expect(typeof main?.lines).toBe('number')
    expect(main?.limit).toBe(520)
    expect(main?.exception?.owner).toBe('architecture epic #33')
    expect(main?.exception?.rationale).toContain('composition root')
    expect(main?.exception?.removalIssue).toBe('#35-#40')
    expect(main?.exception?.expiresOn).toBe('2026-09-30')
  })

  it('blocks the normal verification path on budget violations', () => {
    const root = process.cwd()
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(packageJson.scripts.verify).toContain('npm run architecture:check')
    expect(packageJson.scripts['architecture:check']).toContain('--enforce')
  })
})
