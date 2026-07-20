import { describe, expect, it } from 'vitest'

import {
  parseProjectKindCliOptions,
  parseProjectKindProjectNumber,
  parseProjectKindRepository,
  projectKindExitCode,
} from '../scripts/project-management/kind-cli.ts'

describe('project kind CLI policy', () => {
  it('defaults to a full dry-run inspection', () => {
    expect(parseProjectKindCliOptions([], {})).toEqual({ help: false, apply: false })
  })

  it('parses workflow environment values', () => {
    expect(
      parseProjectKindCliOptions([], {
        HVIR_ISSUE_NUMBER: '83',
        HVIR_APPLY: 'true',
        HVIR_EVENT_ACTION: 'labeled',
        HVIR_EVENT_LABEL: 'kind:feature',
        HVIR_EVENT_UPDATED_AT: '2026-07-20T10:00:00Z',
      }),
    ).toEqual({
      help: false,
      issueNumber: 83,
      apply: true,
      event: { action: 'labeled', label: 'kind:feature' },
      eventUpdatedAt: '2026-07-20T10:00:00Z',
    })
  })

  it('lets command-line values override workflow environment values', () => {
    expect(
      parseProjectKindCliOptions(
        [
          '--issue',
          '84',
          '--apply',
          '--event',
          'unlabeled',
          '--event-label',
          'kind:bug',
          '--event-updated-at',
          '2026-07-20T11:00:00Z',
        ],
        {
          HVIR_ISSUE_NUMBER: '83',
          HVIR_APPLY: 'false',
          HVIR_EVENT_ACTION: 'opened',
          HVIR_EVENT_LABEL: 'kind:feature',
          HVIR_EVENT_UPDATED_AT: '2026-07-20T10:00:00Z',
        },
      ),
    ).toEqual({
      help: false,
      issueNumber: 84,
      apply: true,
      event: { action: 'unlabeled', label: 'kind:bug' },
      eventUpdatedAt: '2026-07-20T11:00:00Z',
    })
  })

  it('returns help without requiring tokens or event context', () => {
    expect(parseProjectKindCliOptions(['--help'], {})).toEqual({
      help: true,
      apply: false,
    })
  })

  it.each(['opened', 'reopened'] as const)('parses a successful %s event', (action) => {
    expect(
      parseProjectKindCliOptions(['--issue', '83', '--event', action], {}),
    ).toMatchObject({ event: { action } })
  })

  it.each([
    {
      args: [] as string[],
      environment: { HVIR_APPLY: 'yes' },
      message: 'HVIR_APPLY must be true or false.',
    },
    {
      args: ['--issue', '0'],
      environment: {},
      message: '--issue must be a positive integer.',
    },
    {
      args: ['--event', 'opened'],
      environment: {},
      message: 'An event reconciliation requires --issue or HVIR_ISSUE_NUMBER.',
    },
    {
      args: ['--issue', '83', '--event', 'labeled'],
      environment: {},
      message: 'The labeled event requires an event label.',
    },
    {
      args: ['--issue', '83', '--event', 'closed'],
      environment: {},
      message: 'Unsupported issue event action: closed',
    },
    {
      args: ['--event-updated-at', 'not-a-date'],
      environment: {},
      message: 'The event updated_at value must be an ISO-8601 date.',
    },
    {
      args: ['--unknown'],
      environment: {},
      message: 'Unknown argument: --unknown',
    },
    {
      args: ['--issue'],
      environment: {},
      message: '--issue requires a value.',
    },
  ])('rejects invalid input: $message', ({ args, environment, message }) => {
    expect(() => parseProjectKindCliOptions(args, environment)).toThrow(message)
  })

  it('parses and normalizes repository coordinates', () => {
    expect(parseProjectKindRepository(' jarmak-personal / hvir ')).toEqual([
      'jarmak-personal',
      'hvir',
    ])
  })

  it.each(['hvir', '/hvir', 'jarmak-personal/', 'owner/repo/extra'])(
    'rejects malformed repository coordinates: %s',
    (repository) => {
      expect(() => parseProjectKindRepository(repository)).toThrow(
        'HVIR_REPOSITORY must use owner/name syntax.',
      )
    },
  )

  it('validates the Project number', () => {
    expect(parseProjectKindProjectNumber('1')).toBe(1)
    expect(() => parseProjectKindProjectNumber('0')).toThrow(
      'HVIR_PROJECT_NUMBER must be a positive integer.',
    )
  })

  it('uses exit 2 only when reconciliation needs classification', () => {
    expect(projectKindExitCode({ summary: { missing: 0, ambiguous: 0 } })).toBe(0)
    expect(projectKindExitCode({ summary: { missing: 1, ambiguous: 0 } })).toBe(2)
    expect(projectKindExitCode({ summary: { missing: 0, ambiguous: 1 } })).toBe(2)
  })
})
