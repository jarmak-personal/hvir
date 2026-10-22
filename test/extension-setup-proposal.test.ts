import { describe, expect, it } from 'vitest'
import {
  parseExtensionSetup,
  extensionSetupTemplate,
  SETUP_LIMITS,
} from '../src/shared/extensions/setup-proposal'
import type { ExtensionManifest } from '../src/shared/extensions/contract'

const manifest: ExtensionManifest = {
  id: 'example',
  name: 'Example',
  version: '1.0.0',
  contract: '1.0',
  requiredCapabilities: [],
  optionalCapabilities: [],
  views: [],
  connectors: [
    {
      id: 'tool',
      description: 'Project tool',
      context: 'workspace',
      timeoutMs: 1000,
      outputBytes: 1024,
      environment: ['TOOL_HOME'],
      setup: { executable: 'tool-cli' },
    },
  ],
  access: [
    {
      id: 'project',
      description: 'Project files',
      context: 'workspace',
      mode: 'read-only',
    },
    {
      id: 'library',
      description: 'Library files',
      context: 'application',
      mode: 'read-only',
    },
  ],
}
const program = {
  connector: 'tool',
  host: 'local',
  executable: '/bin/tool',
  configuration: { args: ['literal $(x)', '${x}'], env: { TOOL_HOME: '/library' } },
}
const parse = (value: object) =>
  parseExtensionSetup(
    JSON.stringify({ schema: 1, extension: 'example', ...value }),
    manifest,
  )
describe('declaration-derived extension setup files', () => {
  it('includes only declarations and unresolved hints, with no saved configuration or trust', () => {
    const text = extensionSetupTemplate(manifest)
    expect(text).toContain('tool-cli')
    expect(text).toContain('TOOL_HOME')
    expect(text).toContain('<exact registered workspace path>')
    expect(text).not.toMatch(
      /canonicalExecutable|installationId|trustUpdates|requestAgentAccess|token/,
    )
    expect(() => parseExtensionSetup(text, manifest)).toThrow(/absolute/)
  })
  it('hints only configured SSH hosts for managed delivery', () => {
    const text = extensionSetupTemplate({
      ...manifest,
      access: [
        {
          id: 'delivery',
          description: 'Delivery',
          context: 'workspace',
          mode: 'managed-delivery',
        },
      ],
    })
    expect(text).toContain('<configured SSH host>')
    const template = JSON.parse(text) as { sources: { workspace: { host: string } }[] }
    expect(template.sources[0]!.workspace.host).not.toContain('local')
  })
  it('keeps literal argv and env and treats omission as no requested changes', () => {
    expect(parse({})).toEqual({
      schema: 1,
      extension: 'example',
      connectors: [],
      sources: [],
    })
    expect(parse({ connectors: [program] }).connectors[0]).toMatchObject({
      executable: { hostId: 'local', path: '/bin/tool' },
      configuration: program.configuration,
    })
  })
  it.each([
    { accepted: true },
    { requestAgentAccess: 'yes' },
    { schema: 2 },
    { extension: 'different' },
    { connectors: [{ ...program, token: 'forged' }] },
    {
      connectors: [
        { ...program, configuration: { ...program.configuration, shell: 'run' } },
      ],
    },
    {
      connectors: [
        { ...program, configuration: { args: [], env: { UNDECLARED: 'value' } } },
      ],
    },
    { connectors: [{ ...program, connector: 'unknown' }] },
    { connectors: [{ ...program, executable: 'relative' }] },
    { connectors: [{ ...program, executable: '/bin/../tool' }] },
    { sources: [{ source: 'project' }] },
    {
      sources: [
        {
          source: 'project',
          root: { host: 'local', path: '/project' },
          workspace: { host: 'local', path: '/project' },
        },
      ],
    },
    { sources: [{ source: 'unknown', workspace: { host: 'local', path: '/project' } }] },
  ])('rejects invalid or authority-bearing input %#', (value) =>
    expect(() => parse(value)).toThrow(),
  )
  it('rejects duplicate bindings but admits full distinct-host rows up to the owner limit', () => {
    expect(() => parse({ connectors: [program, program] })).toThrow(/duplicate/)
    const connectors = Array.from({ length: 256 }, (_, index) => ({
      ...program,
      host: `host${index}`,
    }))
    expect(parse({ connectors }).connectors).toHaveLength(256)
    expect(() =>
      parse({ connectors: [...connectors, { ...program, host: 'one-more' }] }),
    ).toThrow(/too many/)
    const source = { source: 'project', workspace: { host: 'local', path: '/project' } }
    expect(parse({ sources: [source, source] }).sources).toHaveLength(2)
  })
  it('bounds bytes before parsing and uses existing configuration bounds', () => {
    expect(() =>
      parseExtensionSetup(' '.repeat(SETUP_LIMITS.bytes + 1), manifest),
    ).toThrow(/384/)
    expect(() =>
      parse({
        connectors: [
          { ...program, configuration: { args: ['x'.repeat(8192)], env: {} } },
        ],
      }),
    ).toThrow(/bound/)
    expect(() => parseExtensionSetup('{', manifest)).toThrow(/valid JSON/)
  })
})
