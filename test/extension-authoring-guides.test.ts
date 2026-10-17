import { readFileSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_GUIDE_TOPICS } from '../src/shared/agent/reference-catalog'
import { AGENT_COMMANDS, parseAgentCommand } from '../src/shared/agent/commands'
import { EXTENSION_CONTRACT } from '../src/shared/extensions/contract'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { validateExtensionItemValue } from '../src/shared/extensions/contributions'
import { validateConnectorDeclarations } from '../src/shared/extensions/connectors'
import { connectorFixture } from './fixtures/extension-connector'
import { installedAuthoringAssets } from '../src/agent-transport/reference-assets'

describe('installed authoring guides and executable public examples', () => {
  it('indexes every maintained topic, keeps command examples parseable and uses the current starter contract', () => {
    expect(
      readdirSync('build/native/agent-guides')
        .map((name) => name.replace(/\.md$/, ''))
        .sort(),
    ).toEqual(Object.keys(AGENT_GUIDE_TOPICS).sort())
    for (const topic of Object.keys(AGENT_GUIDE_TOPICS)) {
      const text = readFileSync(`build/native/agent-guides/${topic}.md`, 'utf8')
      for (const match of text.matchAll(/(?:hvir-agent )guide ([a-z-]+)/g))
        expect(Object.hasOwn(AGENT_GUIDE_TOPICS, match[1]!)).toBe(true)
      for (const match of text.matchAll(/(?:hvir-agent )help ([a-z-]+)/g))
        expect(AGENT_COMMANDS.some((command) => command.name === match[1])).toBe(true)
    }
    for (const command of AGENT_COMMANDS) {
      if (command.example.startsWith('hvir-agent '))
        expect(
          parseAgentCommand(
            command.example
              .slice(11)
              .match(/"[^"]*"|\S+/g)!
              .map((value) => value.replace(/^"|"$/g, '')),
          ).name,
        ).toBe(command.name)
    }
    const manifest = validateExtensionManifest(
      JSON.parse(
        readFileSync('packages/extension-authoring/clock/hvir-extension.json', 'utf8'),
      ),
    ).manifest
    expect(manifest.contract).toBe(EXTENSION_CONTRACT)
    expect(manifest.connectors).toBeUndefined()
    expect(manifest.access).toEqual([])
    expect(installedAuthoringAssets()).toMatch(/packages\/extension-authoring$/)
  })
  it('runs the guide observation against the owning bounded value schema and ships inert destructive preview metadata', () => {
    const text = readFileSync('build/native/agent-guides/examples.md', 'utf8')
    const send = vi.fn()
    runInNewContext(text.match(/```js\n([\s\S]*?)```/)![1]!, {
      window: { hvirExtension: { send } },
      Date,
    })
    const message = send.mock.calls[0]![0] as { capability: string; input: unknown }
    expect(message.capability).toBe('contributions.publish')
    expect(validateExtensionItemValue(message.input)).toMatchObject({
      item: 'pulse',
      availability: 'current',
    })
    const manifest = validateExtensionManifest(
      JSON.parse(
        readFileSync('packages/extension-reference/hvir-extension.json', 'utf8'),
      ),
    ).manifest
    expect(manifest.actions).toContainEqual(
      expect.objectContaining({
        id: 'preview-replacement',
        agents: true,
        effects: { delete: false, replace: true },
      }),
    )
  })
})

it('executes installed connector request examples through the owning approval/execution ports', async () => {
  const text = readFileSync('build/native/agent-guides/connectors.md', 'utf8')
  const declaration = JSON.parse(text.match(/```json\n([\s\S]*?)```/)![1]!) as unknown
  expect(validateConnectorDeclarations([declaration], () => undefined)[0]).toMatchObject({
    id: 'tool',
    context: 'application',
  })
  const send = vi.fn()
  runInNewContext(text.match(/```js\n([\s\S]*?)```/)![1]!, {
    window: { hvirExtension: { send } },
  })
  const fixture = connectorFixture()
  try {
    const status = send.mock.calls[0]![0] as { capability: string }
    const command = send.mock.calls[1]![0] as { capability: string; input: unknown }
    expect(status.capability).toBe('connector.status')
    expect(command.capability).toBe('connector.execute')
    expect(await fixture.execution.execute(fixture.caller, command.input)).toMatchObject({
      outcome: 'not-started',
      reason: 'unapproved',
    })
    await fixture.approve()
    expect(fixture.approvals.status(fixture.activation)).toContainEqual(
      expect.objectContaining({ connector: 'tool', availability: 'supported' }),
    )
    const result = await fixture.execution.execute(fixture.caller, command.input)
    expect(result).toMatchObject({ outcome: 'completed', code: 0 })
    expect(
      fixture.execution.output(fixture.caller, {
        receipt: result.receipt,
        stream: 'stdout',
        offset: 0,
      }),
    ).toMatchObject({ data: 'result', nextOffset: null, result })
    expect(
      fixture.execution.output(fixture.caller, {
        receipt: result.receipt,
        release: true,
      }),
    ).toBeNull()
    expect(() =>
      fixture.execution.output(fixture.caller, {
        receipt: result.receipt,
        stream: 'stdout',
        offset: 0,
      }),
    ).toThrow('stale')
  } finally {
    fixture.execution.dispose()
  }
})
