import { readFileSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Window, type HTMLButtonElement, type HTMLInputElement } from 'happy-dom'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_GUIDE_TOPICS } from '../src/shared/agent/reference-catalog'
import { AGENT_COMMANDS, parseAgentCommand } from '../src/shared/agent/commands'
import {
  EXTENSION_CAPABILITIES,
  EXTENSION_CONTRACT,
} from '../src/shared/extensions/contract'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { validateExtensionItemValue } from '../src/shared/extensions/contributions'
import { validateConnectorDeclarations } from '../src/shared/extensions/connectors'
import { connectorFixture } from './fixtures/extension-connector'
import { installedAuthoringAssets } from '../src/agent-transport/reference-assets'
import { readAgentGuide } from '../src/agent-transport/reference-assets'
import { sourceFixture } from './fixtures/extension-source'
import { deliveryFixture } from './fixtures/extension-delivery'
import type { HostPath } from '../src/shared/host-path'

it('executes the installed reader recipe with keyboard selection, busy feedback and owned cancellation', async () => {
  const guide = (readAgentGuide('ui') as { content: string }).content
  const window = new Window()
  window.document.body.innerHTML = guide.match(/```html\n([\s\S]*?)```/)![1]!
  const pending: {
    input: { id: string; heading: string; details: boolean; signal: AbortSignal }
    resolve(text: string): void
    reject(error: Error): void
  }[] = []
  const readSelected = vi.fn(
    (input: (typeof pending)[number]['input']) =>
      new Promise<string>((resolve, reject) => pending.push({ input, resolve, reject })),
  )
  const dispose = runInNewContext(
    `${readFileSync('src/shared/presentation/guest-ui.js', 'utf8')}\n${guide.match(/```js\n([\s\S]*?)```/)![1]!}\nmountReader(document.querySelector('#reader-example'), readSelected)`,
    { window, document: window.document, readSelected, AbortController, Error },
  ) as () => void
  const root = window.document.querySelector('#reader-example')!
  const button = window.document.querySelector<HTMLButtonElement>('#read')!
  const feedback = window.document.querySelector('#feedback')!
  const reader = window.document.querySelector('#reader')!
  const rows = window.document.querySelectorAll<HTMLButtonElement>('[role=option]')
  try {
    window.document.querySelector<HTMLInputElement>('#heading')!.value = 'Selected'
    window.document.querySelector<HTMLInputElement>('#details')!.checked = true
    rows[0]!.focus()
    rows[0]!.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
      }),
    )
    expect(window.document.activeElement).toBe(rows[1])
    button.click()
    expect(pending[0]!.input).toMatchObject({
      id: 'two',
      heading: 'Selected',
      details: true,
    })
    expect(button.disabled).toBe(true)
    expect(root.getAttribute('aria-busy')).toBe('true')
    expect(feedback.textContent).toBe('Reading…')
    button.click()
    expect(readSelected).toHaveBeenCalledOnce()
    pending[0]!.resolve('Current second note')
    await vi.waitFor(() => expect(reader.textContent).toBe('Current second note'))
    expect(feedback.textContent).toBe('Read complete')
    expect(button.disabled).toBe(false)
    button.click()
    pending[1]!.reject(new Error('Source unavailable'))
    await vi.waitFor(() => expect(feedback.textContent).toBe('Source unavailable'))
    expect(feedback.getAttribute('data-state')).toBe('error')
    expect(button.disabled).toBe(false)
    button.click()
    rows[0]!.click()
    expect(pending[2]!.input.signal.aborted).toBe(true)
    pending[2]!.resolve('Stale second note')
    await Promise.resolve()
    expect(reader.textContent).toBe('First note')
    button.click()
    expect(pending[3]!.input.id).toBe('one')
    dispose()
    dispose()
    expect(pending[3]!.input.signal.aborted).toBe(true)
    pending[3]!.resolve('Late first note')
    await Promise.resolve()
    rows[1]!.click()
    button.click()
    expect(reader.textContent).toBe('First note')
    expect(readSelected).toHaveBeenCalledTimes(4)
  } finally {
    dispose()
    await window.happyDOM.close()
  }
})

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
  it('makes every current capability contract reachable through the installed topic lookup exactly once', () => {
    const documented: string[] = []
    for (const topic of Object.keys(AGENT_GUIDE_TOPICS)) {
      const guide = readAgentGuide(topic) as { id: string; content: string }
      expect(guide.id).toBe(topic)
      for (const match of guide.content.matchAll(/^### ([a-z]+\.[a-z-]+)$/gm))
        documented.push(match[1]!)
    }
    expect(documented.sort()).toEqual([...EXTENSION_CAPABILITIES].sort())
    const manifest = (readAgentGuide('manifest') as { content: string }).content
    for (const capability of EXTENSION_CAPABILITIES)
      expect(manifest).toContain(capability)
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

it('executes the installed source example with real grant, paging, release and refusal behavior', async () => {
  const guide = (readAgentGuide('sources') as { content: string }).content
  const readCurrent = runInNewContext(
    `${guide.match(/```js\n([\s\S]*?)```/)![1]!}\nreadCurrentDocument`,
  ) as (
    request: (capability: string, input: unknown) => Promise<unknown>,
    path: HostPath,
  ) => Promise<{ text: string; selected: { receipt: string; bytes: number } }>
  const f = sourceFixture()
  const text = 'Current instructions · '.repeat(300)
  f.host.readTextFilePrefix.mockResolvedValue({
    content: text,
    complete: true,
    byteLength: Buffer.byteLength(text),
    lineCount: 1,
    validUtf8: true,
  })
  const request = async (capability: string, input: unknown) => {
    if (capability === 'source.select') return f.reading.select(f.caller, input)
    if (capability === 'source.read') return f.reading.read(f.caller, input)
    throw new Error('Unexpected source operation')
  }
  try {
    await expect(readCurrent(request, f.path)).rejects.toThrow('Grant this source')
    await f.grant()
    const result = await readCurrent(request, f.path)
    expect(result.text).toBe(text)
    expect(result.selected.bytes).toBe(Buffer.byteLength(text))
    expect(() => f.reading.read(f.caller, { receipt: result.selected.receipt })).toThrow()
    let receipt: string | undefined
    const interrupted = async (capability: string, input: unknown) => {
      if (capability === 'source.select') {
        const result = (await request(capability, input)) as { receipt: string }
        receipt = result.receipt
        return result
      }
      if (!(input as { release?: boolean }).release) throw new Error('View hidden')
      return request(capability, input)
    }
    await expect(readCurrent(interrupted, f.path)).rejects.toThrow('View hidden')
    expect(() => f.reading.read(f.caller, { receipt })).toThrow()
  } finally {
    f.dispose()
  }
})

it('executes installed delivery observation against the journal and rejects mixed-revision pages', async () => {
  const guide = (readAgentGuide('delivery') as { content: string }).content
  const observe = runInNewContext(
    `${guide.match(/```js\n([\s\S]*?)```/)![1]!}\nobserveDelivery`,
  ) as (
    request: (capability: string, input: unknown) => Promise<unknown>,
    kind?: string,
  ) => Promise<{ entries: unknown[]; revision: string }>
  const f = await deliveryFixture()
  try {
    const preview = await f.preview('add')
    const result = await f.owner.apply(f.caller, { receipt: preview.receipt })
    expect(result.outcome).toBe('completed')
    const observed = await observe((capability, input) => {
      expect(capability).toBe('delivery.status')
      return Promise.resolve(f.owner.status(f.caller, input))
    })
    expect(observed.entries).toEqual([result.record])
    expect(observed.revision).toBeTypeOf('string')
    const changed = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [result.record],
        nextOffset: 1,
        revision: 'first',
      })
      .mockResolvedValueOnce({ entries: [], nextOffset: null, revision: 'changed' })
    await expect(observe(changed, 'operations')).rejects.toThrow('Delivery changed')
    expect(changed).toHaveBeenNthCalledWith(2, 'delivery.status', {
      kind: 'operations',
      offset: 1,
    })
  } finally {
    await f.dispose()
  }
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
