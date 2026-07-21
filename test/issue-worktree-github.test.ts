import { describe, expect, it } from 'vitest'

import { GhPullRequestLookup } from '../scripts/issue-worktree/github-pull-requests.ts'
import type {
  CommandOptions,
  CommandResult,
  SystemRunner,
} from '../scripts/issue-worktree/system-runner.ts'

describe('issue worktree GitHub adapter', () => {
  it('reads only bounded PR metadata for the exact head branch', async () => {
    const runner = new FakeSystemRunner(
      JSON.stringify([
        {
          number: 42,
          state: 'MERGED',
          mergedAt: '2026-07-21T12:00:00Z',
          headRefName: 'agent/issue-129',
          headRefOid: 'abc123',
          baseRefName: 'main',
        },
      ]),
    )
    const lookup = new GhPullRequestLookup(runner, '/repo')

    await expect(lookup.listByHead('agent/issue-129')).resolves.toEqual([
      {
        number: 42,
        state: 'MERGED',
        mergedAt: '2026-07-21T12:00:00Z',
        headRefName: 'agent/issue-129',
        headRefOid: 'abc123',
        baseRefName: 'main',
      },
    ])
    expect(runner.calls).toEqual([
      {
        command: 'gh',
        args: [
          'pr',
          'list',
          '--head',
          'agent/issue-129',
          '--state',
          'all',
          '--limit',
          '100',
          '--json',
          'number,state,mergedAt,headRefName,headRefOid,baseRefName',
        ],
        options: { cwd: '/repo' },
      },
    ])
  })

  it.each(['not json', '{}', '[{"number":0}]'])(
    'rejects malformed gh output: %s',
    async (output) => {
      const lookup = new GhPullRequestLookup(new FakeSystemRunner(output), '/repo')
      await expect(lookup.listByHead('agent/issue-129')).rejects.toThrow()
    },
  )
})

class FakeSystemRunner implements SystemRunner {
  readonly calls: Array<{
    command: string
    args: readonly string[]
    options: CommandOptions
  }> = []

  constructor(private readonly stdout: string) {}

  run(
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args, options })
    return Promise.resolve({ stdout: this.stdout, stderr: '', exitCode: 0 })
  }

  pathExists(): Promise<boolean> {
    return Promise.resolve(false)
  }
}
