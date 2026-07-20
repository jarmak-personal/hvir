import {
  hostPath,
  joinHostPath,
  type ComposerSubmitMode,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'

const KEYBINDINGS_FILE = 'keybindings.json'
const STATE_FILE = '.hvir-keybindings-state.json'
const MAX_KEYBINDINGS_BYTES = 1024 * 1024
const MAX_STATE_BYTES = 32 * 1024
const MANAGED_ACTIONS = {
  enter: 'chat:newline',
  'ctrl-enter': 'chat:submit',
} as const

type ManagedKey = keyof typeof MANAGED_ACTIONS
const FILE_KEYS: Readonly<Record<ManagedKey, string>> = {
  enter: 'enter',
  'ctrl-enter': 'ctrl+enter',
}
type BindingValue = string | null
type JsonObject = Record<string, unknown>

interface BindingSlot {
  readonly block: JsonObject
  readonly bindings: JsonObject
  readonly key: string
}

interface BindingSnapshot {
  readonly target: ManagedKey
  readonly key: string
  readonly existed: boolean
  readonly value?: BindingValue
}

interface ActiveState {
  readonly version: 1
  readonly active: true
  readonly createdChatBlock: boolean
  readonly snapshots: readonly BindingSnapshot[]
}

interface OptionalFile {
  readonly content: string
  readonly mtimeMs: number
}

export async function configureClaudeComposerSubmit(
  host: ProjectHost,
  mode: ComposerSubmitMode,
): Promise<void> {
  let directory = await claudeConfigDirectory(host)
  const existingDirectory = await optionalStat(host, directory)
  if (!existingDirectory) {
    if (mode === 'enter' || !(await commandAvailable(host, 'claude'))) return
    const created = await host.exec('mkdir', ['-p', '--', directory.path])
    if (created.code !== 0)
      throw new Error('Could not create the Claude config directory')
  } else {
    directory = await host.realpath(directory)
    if ((await host.stat(directory)).type !== 'dir') {
      throw new Error('Claude config path is not a directory')
    }
  }

  let keybindingsPath = joinHostPath(directory, KEYBINDINGS_FILE)
  if ((await optionalStat(host, keybindingsPath))?.type === 'symlink') {
    keybindingsPath = await host.realpath(keybindingsPath)
  }
  const statePath = joinHostPath(directory, STATE_FILE)
  if (mode === 'ctrl-enter') {
    await enableIntentionalSubmit(host, keybindingsPath, statePath)
  } else {
    await restoreSubmitBindings(host, keybindingsPath, statePath)
  }
}

async function enableIntentionalSubmit(
  host: ProjectHost,
  keybindingsPath: HostPath,
  statePath: HostPath,
): Promise<void> {
  const keybindings = await readOptionalFile(host, keybindingsPath, MAX_KEYBINDINGS_BYTES)
  const document = parseKeybindings(keybindings?.content)
  const previousState = await readState(host, statePath)
  if (previousState?.active) {
    if (matchesState(document, previousState, 'managed')) return
    if (!matchesState(document, previousState, 'original')) {
      throw changedBindingsError()
    }
  }

  const { slots, createdChatBlock } = managedSlots(document)
  const snapshots = (['enter', 'ctrl-enter'] as const).map((target) => {
    const slot = slots.get(target)
    if (!slot) throw new Error('Could not prepare Claude keybindings')
    const existed = Object.hasOwn(slot.bindings, slot.key)
    const value = existed ? bindingValue(slot.bindings[slot.key]) : undefined
    return { target, key: slot.key, existed, value }
  })
  if (
    snapshots.every(
      ({ target, existed, value }) => existed && value === MANAGED_ACTIONS[target],
    )
  ) {
    return
  }
  for (const snapshot of snapshots) {
    const slot = slots.get(snapshot.target)
    if (slot) slot.bindings[slot.key] = MANAGED_ACTIONS[snapshot.target]
  }
  const state: ActiveState = {
    version: 1,
    active: true,
    createdChatBlock,
    snapshots,
  }
  await host.writeFile(statePath, serialize(state))
  try {
    await host.writeFile(keybindingsPath, serialize(document), {
      expectedMtimeMs: keybindings?.mtimeMs,
    })
  } catch (reason) {
    await host
      .writeFile(statePath, serialize({ version: 1, active: false }))
      .catch(() => undefined)
    throw reason
  }
}

async function restoreSubmitBindings(
  host: ProjectHost,
  keybindingsPath: HostPath,
  statePath: HostPath,
): Promise<void> {
  const state = await readState(host, statePath)
  if (!state?.active) return
  const keybindings = await readOptionalFile(host, keybindingsPath, MAX_KEYBINDINGS_BYTES)
  const document = parseKeybindings(keybindings?.content)
  if (matchesState(document, state, 'original')) {
    await host.writeFile(statePath, serialize({ version: 1, active: false }))
    return
  }
  if (!matchesState(document, state, 'managed')) throw changedBindingsError()

  const createdBlocks = new Set<JsonObject>()
  for (const snapshot of state.snapshots) {
    const slot = exactSlot(document, snapshot.key)
    if (!slot) throw changedBindingsError()
    if (state.createdChatBlock) createdBlocks.add(slot.block)
    if (snapshot.existed) slot.bindings[snapshot.key] = snapshot.value ?? null
    else delete slot.bindings[snapshot.key]
  }
  if (state.createdChatBlock) {
    const bindings = document['bindings'] as unknown[]
    document['bindings'] = bindings.filter(
      (block) =>
        !(
          isObject(block) &&
          createdBlocks.has(block) &&
          isObject(block['bindings']) &&
          Object.keys(block['bindings']).length === 0
        ),
    )
  }
  await host.writeFile(keybindingsPath, serialize(document), {
    expectedMtimeMs: keybindings?.mtimeMs,
  })
  await host.writeFile(statePath, serialize({ version: 1, active: false }))
}

function managedSlots(document: JsonObject): {
  readonly slots: ReadonlyMap<ManagedKey, BindingSlot>
  readonly createdChatBlock: boolean
} {
  const bindings = document['bindings'] as unknown[]
  const slots = new Map<ManagedKey, BindingSlot>()
  const chatBlocks: JsonObject[] = []
  for (const blockValue of bindings) {
    if (!isObject(blockValue) || blockValue['context'] !== 'Chat') continue
    const blockBindings = blockValue['bindings']
    if (!isObject(blockBindings)) throw new Error('Claude Chat keybindings are invalid')
    chatBlocks.push(blockValue)
    for (const key of Object.keys(blockBindings)) {
      const target = managedTarget(key)
      if (!target) continue
      if (slots.has(target))
        throw new Error(`Claude has duplicate ${target} Chat bindings`)
      slots.set(target, { block: blockValue, bindings: blockBindings, key })
    }
  }
  let createdChatBlock = false
  let targetBlock = chatBlocks[0]
  if (!targetBlock) {
    targetBlock = { context: 'Chat', bindings: {} }
    bindings.push(targetBlock)
    createdChatBlock = true
  }
  const targetBindings = targetBlock['bindings'] as JsonObject
  for (const target of ['enter', 'ctrl-enter'] as const) {
    if (!slots.has(target)) {
      slots.set(target, {
        block: targetBlock,
        bindings: targetBindings,
        key: FILE_KEYS[target],
      })
    }
  }
  return { slots, createdChatBlock }
}

function matchesState(
  document: JsonObject,
  state: ActiveState,
  expected: 'managed' | 'original',
): boolean {
  return state.snapshots.every((snapshot) => {
    const slot = exactSlot(document, snapshot.key)
    if (expected === 'managed') {
      return slot?.bindings[snapshot.key] === MANAGED_ACTIONS[snapshot.target]
    }
    if (!snapshot.existed) return slot === undefined
    return slot?.bindings[snapshot.key] === snapshot.value
  })
}

function exactSlot(document: JsonObject, key: string): BindingSlot | undefined {
  const found: BindingSlot[] = []
  for (const blockValue of document['bindings'] as unknown[]) {
    if (!isObject(blockValue) || blockValue['context'] !== 'Chat') continue
    const blockBindings = blockValue['bindings']
    if (!isObject(blockBindings)) continue
    if (Object.hasOwn(blockBindings, key)) {
      found.push({ block: blockValue, bindings: blockBindings, key })
    }
  }
  return found.length === 1 ? found[0] : undefined
}

function parseKeybindings(content: string | undefined): JsonObject {
  if (content === undefined) {
    return {
      $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
      $docs: 'https://code.claude.com/docs/en/keybindings',
      bindings: [],
    }
  }
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error('Claude keybindings contain invalid JSON; hvir left them unchanged')
  }
  if (!isObject(value) || !Array.isArray(value['bindings'])) {
    throw new Error(
      'Claude keybindings have an invalid structure; hvir left them unchanged',
    )
  }
  return value
}

async function readState(
  host: ProjectHost,
  path: HostPath,
): Promise<ActiveState | { readonly version: 1; readonly active: false } | undefined> {
  const file = await readOptionalFile(host, path, MAX_STATE_BYTES)
  if (!file) return undefined
  let value: unknown
  try {
    value = JSON.parse(file.content)
  } catch {
    throw new Error('hvir cannot read its Claude keybinding restore state')
  }
  if (
    !isObject(value) ||
    value['version'] !== 1 ||
    typeof value['active'] !== 'boolean'
  ) {
    throw new Error('hvir Claude keybinding restore state is invalid')
  }
  if (!value['active']) return { version: 1, active: false }
  if (
    !Array.isArray(value['snapshots']) ||
    typeof value['createdChatBlock'] !== 'boolean'
  ) {
    throw new Error('hvir Claude keybinding restore state is invalid')
  }
  const snapshots = value['snapshots'].map(parseSnapshot)
  if (
    snapshots.length !== 2 ||
    new Set(snapshots.map(({ target }) => target)).size !== 2
  ) {
    throw new Error('hvir Claude keybinding restore state is invalid')
  }
  return {
    version: 1,
    active: true,
    createdChatBlock: value['createdChatBlock'],
    snapshots,
  }
}

function parseSnapshot(value: unknown): BindingSnapshot {
  if (
    !isObject(value) ||
    (value['target'] !== 'enter' && value['target'] !== 'ctrl-enter') ||
    typeof value['key'] !== 'string' ||
    typeof value['existed'] !== 'boolean' ||
    (value['existed'] && value['value'] !== null && typeof value['value'] !== 'string')
  ) {
    throw new Error('hvir Claude keybinding restore state is invalid')
  }
  return {
    target: value['target'],
    key: value['key'],
    existed: value['existed'],
    value: value['existed'] ? (value['value'] as BindingValue) : undefined,
  }
}

async function claudeConfigDirectory(host: ProjectHost): Promise<HostPath> {
  const result = await host.exec('sh', [
    '-lc',
    'printf "%s" "${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"',
  ])
  const path = result.stdout.trim()
  if (
    result.code !== 0 ||
    !path.startsWith('/') ||
    path.length > 16_384 ||
    /[\0\r\n]/.test(path)
  ) {
    throw new Error('Could not resolve the Claude config directory')
  }
  return hostPath(host.hostId, path)
}

async function commandAvailable(host: ProjectHost, command: string): Promise<boolean> {
  const result = await host.exec('sh', ['-lc', `command -v ${command} >/dev/null 2>&1`])
  return result.code === 0
}

async function optionalStat(host: ProjectHost, path: HostPath) {
  return host.stat(path).catch(() => undefined)
}

async function readOptionalFile(
  host: ProjectHost,
  path: HostPath,
  maxBytes: number,
): Promise<OptionalFile | undefined> {
  const stat = await optionalStat(host, path)
  if (!stat) return undefined
  if (stat.type !== 'file' || stat.size > maxBytes) {
    throw new Error(`${path.path} is not a bounded regular file`)
  }
  return { content: await host.readTextFile(path), mtimeMs: stat.mtimeMs }
}

function managedTarget(key: string): ManagedKey | undefined {
  const normalized = key
    .trim()
    .toLowerCase()
    .replace(/^control\+/, 'ctrl+')
  if (normalized === 'enter' || normalized === 'return') return 'enter'
  if (normalized === 'ctrl+enter' || normalized === 'ctrl+return') return 'ctrl-enter'
  return undefined
}

function bindingValue(value: unknown): BindingValue {
  if (value === null || typeof value === 'string') return value
  throw new Error('Claude Chat keybindings have an invalid action')
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function changedBindingsError(): Error {
  return new Error(
    'Claude submit bindings changed after hvir configured them; hvir left the file untouched',
  )
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
