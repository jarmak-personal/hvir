import { describe, expect, it } from 'vitest'
import { parseAgentCommand, staticAgentReference } from '../src/shared/agent/commands'
import { AGENT_CONTRACT, validateAgentRequest } from '../src/shared/agent/contract'
import { readAgentGuide } from '../src/agent-transport/reference-assets'

describe('installed agent contract discovery', () => {
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
