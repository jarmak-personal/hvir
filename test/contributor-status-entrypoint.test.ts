import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parseContributorStatusOptions } from '../scripts/project-management/contributor-status-cli.ts'

describe('native contributor-status command', () => {
  it('loads its production imports under Node strip mode and prints help without credentials', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/project-management/read-contributor-status.ts', '--help'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Usage: npm run project:status')
    expect(result.stdout).not.toContain('checkpoint')
  })
  it('rejects incomplete batch selectors before capture', () => {
    for (const args of [
      ['--issues'],
      ['--issues', '757,757'],
      ['--issues', '758'],
      ['--issues', '757,0'],
    ])
      expect(() =>
        parseContributorStatusOptions([
          '--issue',
          '757',
          '--capture',
          'codex',
          '--phase',
          'planning',
          ...args,
        ]),
      ).toThrow()
  })
  it('defaults to read-only and requires explicit capture for mutation', () => {
    expect(parseContributorStatusOptions(['--issue', '757'])).toMatchObject({
      issue: 757,
      apply: false,
      json: false,
    })
    expect(() => parseContributorStatusOptions(['--issue', '757', '--apply'])).toThrow(
      'requires --capture',
    )
    expect(() =>
      parseContributorStatusOptions(['--issue', '757', '--issue', '758']),
    ).toThrow('Duplicate')
    expect(
      parseContributorStatusOptions([
        '--issue',
        '757',
        '--capture',
        'codex',
        '--phase',
        'implementation',
        '--apply',
      ]),
    ).toMatchObject({ capture: 'codex', apply: true })
  })
})
