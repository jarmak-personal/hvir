import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const entrypoint = fileURLToPath(
  new URL('../scripts/project-management/measure-agent-work.ts', import.meta.url),
)

describe('agent-work measurement entrypoint', () => {
  it('loads the shared usage vocabulary through native Node TypeScript resolution', () => {
    const result = spawnSync(process.execPath, [entrypoint, '--help'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Usage: npm run project:measure')
  })
})
