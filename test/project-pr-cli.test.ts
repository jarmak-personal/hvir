import { describe, expect, it } from 'vitest'

import {
  parseProjectPullRequestCliOptions,
  projectPullRequestExitCode,
} from '../scripts/project-management/pull-request-cli.ts'

describe('pull request planning CLI policy', () => {
  it('parses dry-run and apply requests from flags or the workflow environment', () => {
    expect(parseProjectPullRequestCliOptions(['--pull-request', '86'], {})).toEqual({
      help: false,
      pullRequestNumber: 86,
      apply: false,
      output: 'concise',
    })
    expect(
      parseProjectPullRequestCliOptions([], {
        HVIR_PULL_REQUEST_NUMBER: '86',
        HVIR_APPLY: 'true',
      }),
    ).toEqual({
      help: false,
      pullRequestNumber: 86,
      apply: true,
      output: 'concise',
    })
    expect(parseProjectPullRequestCliOptions(['--issue', '50'], {})).toEqual({
      help: false,
      issueNumber: 50,
      apply: false,
      output: 'concise',
    })
  })

  it('lets explicit flags override workflow defaults', () => {
    expect(
      parseProjectPullRequestCliOptions(['--pull-request', '87', '--apply'], {
        HVIR_PULL_REQUEST_NUMBER: '86',
        HVIR_APPLY: 'false',
      }),
    ).toEqual({
      help: false,
      pullRequestNumber: 87,
      apply: true,
      output: 'concise',
    })
  })

  it('returns help without requiring a PR or credentials', () => {
    expect(parseProjectPullRequestCliOptions(['--help'], {})).toEqual({
      help: true,
      apply: false,
      output: 'concise',
    })
  })

  it('offers verbose and JSON diagnosis without changing the concise default', () => {
    expect(
      parseProjectPullRequestCliOptions(['--pull-request', '86', '--verbose'], {}),
    ).toMatchObject({ output: 'verbose' })
    expect(
      parseProjectPullRequestCliOptions(['--pull-request', '86', '--json'], {}),
    ).toMatchObject({ output: 'json' })
    expect(() =>
      parseProjectPullRequestCliOptions(
        ['--pull-request', '86', '--verbose', '--json'],
        {},
      ),
    ).toThrow('cannot be combined')
  })

  it.each([
    { args: [] as string[], environment: {}, message: 'One of --pull-request' },
    {
      args: ['--pull-request', '0'],
      environment: {},
      message: '--pull-request must be a positive integer.',
    },
    {
      args: [],
      environment: { HVIR_APPLY: 'yes' },
      message: 'HVIR_APPLY must be true or false.',
    },
    { args: ['--unknown'], environment: {}, message: 'Unknown argument' },
    {
      args: ['--pull-request', '86', '--issue', '50'],
      environment: {},
      message: 'one pull request or issue',
    },
  ])('rejects invalid input: $message', ({ args, environment, message }) => {
    expect(() => parseProjectPullRequestCliOptions(args, environment)).toThrow(message)
  })

  it('accepts a previous body only as edited-event environment data', () => {
    expect(
      parseProjectPullRequestCliOptions([], {
        HVIR_PULL_REQUEST_NUMBER: '86',
        HVIR_EVENT_ACTION: 'edited',
        HVIR_PREVIOUS_PR_BODY: 'Contributes-to: #50',
      }),
    ).toMatchObject({ previousBody: 'Contributes-to: #50' })
    expect(
      parseProjectPullRequestCliOptions([], {
        HVIR_PULL_REQUEST_NUMBER: '86',
        HVIR_EVENT_ACTION: 'opened',
        HVIR_PREVIOUS_PR_BODY: 'Contributes-to: #50',
      }),
    ).not.toHaveProperty('previousBody')
  })

  it('uses exit 2 for partial policy failures after emitting a report', () => {
    expect(
      projectPullRequestExitCode({
        summary: {
          wouldAdvance: 0,
          advanced: 1,
          unchanged: 0,
          failed: 1,
          warnings: 0,
          errors: 1,
        },
      }),
    ).toBe(2)
  })
})
