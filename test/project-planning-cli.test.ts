import { describe, expect, it } from 'vitest'

import {
  parseProjectPlanningCliOptions,
  parseProjectPlanningProjectNumber,
  parseProjectPlanningRepository,
} from '../scripts/project-management/planning-cli.ts'

describe('project planning CLI policy', () => {
  it('parses a read-only planning record request', () => {
    expect(parseProjectPlanningCliOptions(['--issue', '85'])).toEqual({
      help: false,
      issueNumber: 85,
      ensureProject: false,
      apply: false,
    })
  })

  it('parses an explicit dry-run or apply operation', () => {
    expect(
      parseProjectPlanningCliOptions([
        '--issue',
        '85',
        '--ensure-project',
        '--status',
        'In Progress',
        '--apply',
      ]),
    ).toEqual({
      help: false,
      issueNumber: 85,
      ensureProject: true,
      status: 'In Progress',
      apply: true,
    })
  })

  it('returns help without requiring an issue or tokens', () => {
    expect(parseProjectPlanningCliOptions(['--help'])).toEqual({
      help: true,
      ensureProject: false,
      apply: false,
    })
  })

  it.each([
    { args: [] as string[], message: '--issue is required' },
    { args: ['--issue', '0'], message: '--issue must be a positive integer.' },
    { args: ['--issue'], message: '--issue requires a value.' },
    {
      args: ['--issue', '85', '--status', 'Blocked'],
      message: '--status must be one of: Todo, In Progress, Done.',
    },
    {
      args: ['--issue', '85', '--kind', 'Feature'],
      message: 'Project Kind is label-derived',
    },
    { args: ['--unknown'], message: 'Unknown argument: --unknown' },
  ])('rejects invalid input: $message', ({ args, message }) => {
    expect(() => parseProjectPlanningCliOptions(args)).toThrow(message)
  })

  it('parses repository and Project coordinates', () => {
    expect(parseProjectPlanningRepository(' jarmak-personal / hvir ')).toEqual([
      'jarmak-personal',
      'hvir',
    ])
    expect(parseProjectPlanningProjectNumber('1')).toBe(1)
  })

  it('rejects malformed repository and Project coordinates', () => {
    expect(() => parseProjectPlanningRepository('other/hvir/extra')).toThrow(
      'HVIR_REPOSITORY must use owner/name syntax.',
    )
    expect(() => parseProjectPlanningProjectNumber('-1')).toThrow(
      'HVIR_PROJECT_NUMBER must be a positive integer.',
    )
  })
})
