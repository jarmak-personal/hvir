import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configureClaudeComposerSubmit } from '../src/main/harness/claude-keybindings'
import { LocalHost } from '../src/main/project-host/local-host'

describe('Claude composer keybinding configuration', () => {
  let root: string
  let configDirectory: string
  let keybindingsFile: string
  let stateFile: string
  let host: LocalHost

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hvir-claude-keybindings-'))
    configDirectory = join(root, '.claude')
    keybindingsFile = join(configDirectory, 'keybindings.json')
    stateFile = join(configDirectory, '.hvir-keybindings-state.json')
    await mkdir(configDirectory)
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDirectory)
    host = new LocalHost()
    await host.connect()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('removes a keybindings file that hvir created during exact restoration', async () => {
    await expect(access(keybindingsFile)).rejects.toBeDefined()

    await configureClaudeComposerSubmit(host, 'ctrl-enter')

    expect(await readStateJson(stateFile)).toMatchObject({
      version: 3,
      active: true,
      createdChatBlock: true,
      createdKeybindingsFile: true,
    })

    await configureClaudeComposerSubmit(host, 'enter')

    await expect(access(keybindingsFile)).rejects.toBeDefined()
    expect(await readStateJson(stateFile)).toEqual({ version: 3, active: false })
  })

  it('changes only the three Chat bindings and restores their previous values', async () => {
    const original = {
      $docs: 'custom docs',
      bindings: [
        { context: 'Global', bindings: { 'ctrl+t': 'app:toggleTodos' } },
        {
          context: 'Chat',
          bindings: {
            enter: 'command:review',
            'ctrl+enter': null,
            'shift+enter': 'command:review',
            'ctrl+e': 'chat:externalEditor',
          },
        },
      ],
    }
    await writeFile(keybindingsFile, JSON.stringify(original, null, 2))

    await configureClaudeComposerSubmit(host, 'ctrl-enter')

    const configured = await readJson(keybindingsFile)
    expect(configured).toMatchObject({
      $docs: 'custom docs',
      bindings: [
        { context: 'Global', bindings: { 'ctrl+t': 'app:toggleTodos' } },
        {
          context: 'Chat',
          bindings: {
            enter: 'chat:newline',
            'ctrl+enter': 'chat:submit',
            'shift+enter': 'chat:submit',
            'ctrl+e': 'chat:externalEditor',
          },
        },
      ],
    })

    await configureClaudeComposerSubmit(host, 'enter')

    expect(await readJson(keybindingsFile)).toEqual(original)
  })

  it('creates and later removes only its own Chat block', async () => {
    const original = {
      bindings: [{ context: 'Global', bindings: { 'ctrl+t': 'app:toggleTodos' } }],
    }
    await writeFile(keybindingsFile, JSON.stringify(original))

    await configureClaudeComposerSubmit(host, 'ctrl-enter')
    expect((await readJson(keybindingsFile)).bindings).toEqual([
      { context: 'Global', bindings: { 'ctrl+t': 'app:toggleTodos' } },
      {
        context: 'Chat',
        bindings: {
          enter: 'chat:newline',
          'ctrl+enter': 'chat:submit',
          'shift+enter': 'chat:submit',
        },
      },
    ])

    await configureClaudeComposerSubmit(host, 'enter')
    expect(await readJson(keybindingsFile)).toEqual(original)
  })

  it('leaves an existing intentional-submit configuration under user ownership', async () => {
    const original = JSON.stringify({
      bindings: [
        {
          context: 'Chat',
          bindings: {
            enter: 'chat:newline',
            'ctrl+enter': 'chat:submit',
            'shift+enter': 'chat:submit',
          },
        },
      ],
    })
    await writeFile(keybindingsFile, original)

    await configureClaudeComposerSubmit(host, 'ctrl-enter')

    expect(await readFile(keybindingsFile, 'utf8')).toBe(original)
    await expect(
      access(join(configDirectory, '.hvir-keybindings-state.json')),
    ).rejects.toBeDefined()
  })

  it('keeps additions made to a keybindings file that hvir created', async () => {
    await configureClaudeComposerSubmit(host, 'ctrl-enter')
    const configured = await readJson(keybindingsFile)
    configured.bindings.push({
      context: 'Global',
      bindings: { 'ctrl+t': 'app:toggleTodos' },
    })
    await writeFile(keybindingsFile, `${JSON.stringify(configured, null, 2)}\n`)

    await configureClaudeComposerSubmit(host, 'enter')

    expect((await readJson(keybindingsFile)).bindings).toEqual([
      { context: 'Global', bindings: { 'ctrl+t': 'app:toggleTodos' } },
    ])
  })

  it('upgrades active two-binding state without losing its restore snapshot', async () => {
    await writeFile(
      keybindingsFile,
      JSON.stringify({
        bindings: [
          {
            context: 'Chat',
            bindings: {
              enter: 'chat:newline',
              'ctrl+enter': 'chat:submit',
              'shift+enter': 'command:review',
            },
          },
        ],
      }),
    )
    await writeFile(
      stateFile,
      JSON.stringify({
        version: 1,
        active: true,
        createdChatBlock: false,
        snapshots: [
          {
            target: 'enter',
            key: 'enter',
            existed: true,
            value: 'command:review',
          },
          { target: 'ctrl-enter', key: 'ctrl+enter', existed: false },
        ],
      }),
    )

    await configureClaudeComposerSubmit(host, 'ctrl-enter')

    expect((await readJson(keybindingsFile)).bindings[0]?.bindings).toEqual({
      enter: 'chat:newline',
      'ctrl+enter': 'chat:submit',
      'shift+enter': 'chat:submit',
    })
    expect(await readStateJson(stateFile)).toEqual({
      version: 3,
      active: true,
      createdChatBlock: false,
      createdKeybindingsFile: false,
      snapshots: [
        {
          target: 'enter',
          key: 'enter',
          existed: true,
          value: 'command:review',
        },
        { target: 'ctrl-enter', key: 'ctrl+enter', existed: false },
        {
          target: 'shift-enter',
          key: 'shift+enter',
          existed: true,
          value: 'command:review',
        },
      ],
    })

    await configureClaudeComposerSubmit(host, 'enter')

    expect((await readJson(keybindingsFile)).bindings[0]?.bindings).toEqual({
      enter: 'command:review',
      'shift+enter': 'command:review',
    })
  })

  it('refuses to overwrite a targeted binding changed after hvir configured it', async () => {
    await writeFile(keybindingsFile, JSON.stringify({ bindings: [] }))
    await configureClaudeComposerSubmit(host, 'ctrl-enter')
    const manuallyEdited = await readJson(keybindingsFile)
    const chat = manuallyEdited.bindings[0]
    if (!chat) throw new Error('Expected hvir-managed Chat bindings')
    chat.bindings['shift+enter'] = 'command:review'
    await writeFile(keybindingsFile, JSON.stringify(manuallyEdited, null, 2))

    await expect(configureClaudeComposerSubmit(host, 'enter')).rejects.toThrow(
      /changed after hvir configured them/,
    )
    expect(await readJson(keybindingsFile)).toEqual(manuallyEdited)
  })
})

interface TestKeybindings {
  readonly $docs?: string
  readonly bindings: Array<{
    readonly context: string
    readonly bindings: Record<string, string | null>
  }>
}

interface TestConfigurationState {
  readonly version: number
  readonly active: boolean
  readonly createdChatBlock?: boolean
  readonly createdKeybindingsFile?: boolean
  readonly snapshots?: Array<{
    readonly target: string
    readonly key: string
    readonly existed: boolean
    readonly value?: string | null
  }>
}

async function readJson(path: string): Promise<TestKeybindings> {
  return JSON.parse(await readFile(path, 'utf8')) as TestKeybindings
}

async function readStateJson(path: string): Promise<TestConfigurationState> {
  return JSON.parse(await readFile(path, 'utf8')) as TestConfigurationState
}
