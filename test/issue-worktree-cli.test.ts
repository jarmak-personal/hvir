import { describe, expect, it } from 'vitest'

import { parseIssueWorktreeCliOptions } from '../scripts/issue-worktree/cli.ts'

describe('issue worktree CLI policy', () => {
  it('defaults to a dry run with an exact base', () => {
    expect(
      parseIssueWorktreeCliOptions([
        '--issue',
        '129',
        '--base',
        'refs/remotes/origin/main',
      ]),
    ).toEqual({
      help: false,
      issueNumber: 129,
      baseRef: 'refs/remotes/origin/main',
      apply: false,
    })
  })

  it('requires explicit apply authority for mutations', () => {
    expect(
      parseIssueWorktreeCliOptions([
        '--issue',
        '129',
        '--base',
        'refs/heads/epic/127-agent-workflow',
        '--apply',
      ]),
    ).toMatchObject({ apply: true })
  })

  it('returns help without requiring an issue or base', () => {
    expect(parseIssueWorktreeCliOptions(['--help'])).toEqual({
      help: true,
      apply: false,
    })
  })

  it.each([
    { args: [] as string[], message: '--issue is required.' },
    { args: ['--issue', '0'], message: '--issue must be a positive integer.' },
    { args: ['--issue'], message: '--issue requires a value.' },
    {
      args: ['--issue', '129'],
      message: '--base is required.',
    },
    {
      args: ['--issue', '129', '--base', 'main'],
      message: '--base must be a full',
    },
    {
      args: ['--issue', '129', '--base', 'refs/heads/main~1'],
      message: '--base must be a full',
    },
    {
      args: ['--unknown'],
      message: 'Unknown argument: --unknown',
    },
  ])('rejects invalid input: $message', ({ args, message }) => {
    expect(() => parseIssueWorktreeCliOptions(args)).toThrow(message)
  })
})
