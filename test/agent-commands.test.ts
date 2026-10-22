import { describe, expect, it } from 'vitest'
import { parseAgentCommand, staticAgentReference } from '../src/shared/agent/commands'
import { AGENT_CONTRACT, validateAgentRequest } from '../src/shared/agent/contract'
import { readAgentGuide } from '../src/agent-transport/reference-assets'

describe('installed agent contract discovery', () => {
  it.each(['scaffold', 'validate', 'skill'])(
    'resolves %s help before authoring arguments or effects',
    (name) => {
      const focused = parseAgentCommand(['help', name])
      for (const flag of ['--help', '-h']) {
        const command = parseAgentCommand([name, flag])
        expect(command).toEqual(focused)
        expect(staticAgentReference(command, readAgentGuide)).toEqual(
          staticAgentReference(focused, readAgentGuide),
        )
      }
      for (const args of [
        ['--help', '--help'],
        ['--help=true'],
        ['--help', 'unexpected'],
        ['--help', '--instance', '/endpoint'],
      ])
        expect(() => parseAgentCommand([name, ...args])).toThrow(`help ${name}`)
    },
  )
  it('names valid options and focused help without echoing arbitrary arguments', () => {
    expect(() => parseAgentCommand(['scaffold', '--output'])).toThrow(
      'Missing --output value. Use hvir-agent help scaffold',
    )
    expect(() => parseAgentCommand(['validate', '--path', '/a', '--path', '/b'])).toThrow(
      'Duplicate --path option. Use hvir-agent help validate',
    )
    expect(() => parseAgentCommand(['skill', '--' + 'x'.repeat(5000)])).toThrow(
      'Unknown option for skill. Use hvir-agent help skill',
    )
    expect(() => parseAgentCommand(['scaffold', '--output', '--help'])).toThrow(
      'Missing --output value',
    )
  })
  it('accepts handle-qualified withdrawal and rejects content or invented close values', () => {
    expect(
      parseAgentCommand([
        'report',
        '--instance',
        '/instance.sock',
        '--handle',
        'opaque',
        '--close',
      ]).flags,
    ).toEqual({ instance: '/instance.sock', handle: 'opaque', close: 'true' })
    for (const argv of [
      ['report', '--close'],
      ['report', '--handle', 'opaque', '--close=true'],
      ['report', '--handle', 'opaque', '--close', 'false'],
      ['report', '--handle', 'opaque', '--close', '--close'],
      ...['title', 'format', 'stdin'].map((flag) => [
        'report',
        '--handle',
        'opaque',
        '--close',
        '--' + flag,
        ...(flag === 'stdin' ? [] : ['value']),
      ]),
    ])
      expect(() => parseAgentCommand(argv)).toThrow()
    const reference = JSON.parse(
      staticAgentReference(parseAgentCommand(['help', 'report']), readAgentGuide)!.stdout,
    ) as { reference: { flags: string[]; input: string } }
    expect(reference.reference.flags).toContain('close')
    expect(reference.reference.input).toContain('--close')
    expect(reference.reference.input).toContain('title at most 80 characters')
  })
  it('keeps top-level help progressive and returns focused installed reference offline', () => {
    const help = staticAgentReference(parseAgentCommand([]), readAgentGuide)!
    expect(help.exitStatus).toBe(0)
    expect(help.stdout).toContain(AGENT_CONTRACT)
    expect(help.stdout.length).toBeLessThan(1000)
    expect(JSON.parse(help.stdout)).not.toHaveProperty('commands')
    const reference = JSON.parse(
      staticAgentReference(parseAgentCommand(['help', 'report']), readAgentGuide)!.stdout,
    ) as {
      reference: {
        name: string
        input: string
        output: string
        targeting: string
        exitStatuses: { success: number }
      }
    }
    expect(reference.reference).toMatchObject({
      name: 'report',
      exitStatuses: { success: 0 },
    })
    expect(
      (
        JSON.parse(
          staticAgentReference(parseAgentCommand(['guide', 'access']), readAgentGuide)!
            .stdout,
        ) as { guide: unknown }
      ).guide,
    ).toBeDefined()
  })
  it.each(
    [
      ['report', '--stdin=no'],
      ['run', '--action'],
      ['open', '--path', 'a', '--path', 'b'],
      ['run', '--approval', 'human'],
      ['workspaces', '--session', 'x'],
    ].map((argv) => [argv]),
  )('refuses malformed options %j', (argv) => {
    expect(() => parseAgentCommand(argv)).toThrow()
  })
  it('describes only supported target flags and keeps reference commands offline', () => {
    const targeting = (name: string): string =>
      (
        JSON.parse(
          staticAgentReference(parseAgentCommand(['help', name]), readAgentGuide)!.stdout,
        ) as {
          reference: { targeting: string }
        }
      ).reference.targeting
    for (const name of ['workspaces', 'views', 'actions', 'action', 'instances']) {
      expect(targeting(name)).not.toContain('--workspace')
      expect(targeting(name)).not.toContain('--session')
      expect(() => parseAgentCommand([name, '--workspace', 'workspace'])).toThrow()
    }
    expect(targeting('report')).toContain('--workspace, --session')
    expect(
      parseAgentCommand([
        'report',
        '--workspace',
        'workspace',
        '--session',
        'session',
        '--stdin',
      ]).flags,
    ).toMatchObject({ workspace: 'workspace', session: 'session' })
    for (const name of ['help', 'commands', 'guide'])
      expect(targeting(name)).toContain('Offline reference; no instance')
    expect(targeting('instances')).toContain(
      'Local endpoint discovery; no selected instance',
    )
  })
  it('copies only public targeting data and never accepts caller authorization or origin', () => {
    const defaults = { workspace: 'exact', origin: 'forwarded', approval: 'human' }
    const request = validateAgentRequest({
      contract: AGENT_CONTRACT,
      argv: ['workspaces'],
      stdin: '',
      defaults,
      origin: 'forwarded',
      authorization: 'human',
    })
    defaults.workspace = 'changed'
    expect(request.defaults).toEqual({ workspace: 'exact' })
    expect(request).not.toHaveProperty('origin')
    expect(request).not.toHaveProperty('authorization')
    expect(() => validateAgentRequest({ ...request, contract: 'future' })).toThrow(
      'contract',
    )
  })
})

it.each([
  ['run'],
  ['run', '--extension', 'installed'],
  ['action', '--action', 'named'],
  ['view', '--extension', 'installed'],
  ['open'],
  ...['0', '33', '1.5', 'invalid'].map((limit) => ['workspaces', '--limit', limit]),
])('rejects statically invalid arguments %j', (...argv) => {
  expect(() => parseAgentCommand(argv)).toThrow()
})

it('keeps focused and index exit semantics aligned with opaque action values', () => {
  type ExitReference = {
    exitStatuses: Readonly<Record<string, number>>
    exitStatusMeanings: {
      invalid: string
      unavailable: string
      success: string
      retry: string
    }
  }
  const index = JSON.parse(
    staticAgentReference(parseAgentCommand(['commands']), readAgentGuide)!.stdout,
  ) as ExitReference
  const focused = (
    JSON.parse(
      staticAgentReference(parseAgentCommand(['help', 'run']), readAgentGuide)!.stdout,
    ) as { reference: ExitReference }
  ).reference
  expect(index.exitStatuses).toEqual({
    success: 0,
    invalid: 64,
    unavailable: 69,
    interrupted: 75,
  })
  expect(focused.exitStatuses).toEqual(index.exitStatuses)
  expect(focused.exitStatusMeanings).toEqual(index.exitStatusMeanings)
  expect(focused.exitStatusMeanings.invalid).toContain('declared input schema')
  expect(focused.exitStatusMeanings.unavailable).toContain(
    'outside the selected workspace',
  )
  expect(focused.exitStatusMeanings.success).toContain('not proof of domain success')
  expect(focused.exitStatusMeanings.retry).toContain('never authorizes automatic retry')
})
