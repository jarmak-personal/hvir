// @vitest-environment happy-dom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  useSkillagerProject,
  type SkillagerSetupTerminal,
} from '../src/renderer/src/skillager/use-skillager-project'
import { SkillagerProjectSetup } from '../src/renderer/src/skillager/SkillagerProjectSetup'
import { localPath } from '../src/shared/host-path'
import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import type { SkillagerConnection } from '../src/shared/skillager'
import type { PreparedTerminalSession } from '../src/renderer/src/terminal/terminal-workspace-model'
import type { StartPtyRequest } from '../src/shared'

const root = localPath('/workspace')
const connection: SkillagerConnection = {
  connectionId: 'connection',
  executable: localPath('/tools/skillager'),
  version: '0.9.1',
  library: {
    id: 'library',
    root: localPath('/library'),
    skillsRoot: localPath('/library/skills'),
  },
}
const setup = {
  setupId: 'grant',
  sessionId: 'new-terminal',
  projectRoot: root,
  agent: 'codex' as const,
  executable: connection.executable,
  profile: builtInProfiles()[0]!,
}
const metadata = {
  ok: true,
  value: {
    rows: [],
    exposures: [],
    setupRunning: false,
    checkedAt: 1,
    durationMs: 1,
    status: {
      projectRoot: root,
      agent: 'codex',
      status: 'review-needed',
      canProceed: false,
      working: 'missing',
      reviewNeeded: 1,
      lintBlocked: 0,
    },
  },
}
const started = {
  ok: true,
  value: {
    outcome: 'started',
    id: 'new-terminal',
    instanceId: 'instance',
    pid: 2,
    identityStatus: 'none',
    capabilities: {
      sessionIdentity: 'none',
      exactResume: false,
      contextPresentation: 'none',
    },
    resumed: false,
    reattached: false,
  },
}
const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>()
const exits = new Set<(event: { id: string; exitCode: number }) => void>()
let current!: ReturnType<typeof useSkillagerProject>,
  prepared: PreparedTerminalSession | undefined
let mount: HTMLDivElement, react: Root
const open = vi.fn<SkillagerSetupTerminal>((_root, session) => {
  prepared = session
  return Promise.resolve()
})
function Harness({
  enabled = true,
  demand = true,
}: {
  enabled?: boolean
  demand?: boolean
}): ReactElement {
  current = useSkillagerProject({
    connection: enabled ? connection : undefined,
    root,
    agent: 'codex',
    demand: enabled && demand,
    openTerminal: open,
  })
  return enabled ? (
    <SkillagerProjectSetup
      root={root}
      controller={{ project: current, connection, agent: 'codex' }}
    />
  ) : (
    <span>Disabled</span>
  )
}
async function render(props = {}) {
  await act(() => {
    react.render(<Harness {...props} />)
    return Promise.resolve()
  })
}
const request = {
  sessionId: 'new-terminal',
  cols: 100,
  rows: 30,
  position: 0,
} as StartPtyRequest
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mount = document.createElement('div')
  document.body.append(mount)
  react = createRoot(mount)
  prepared = undefined
  open.mockClear()
  exits.clear()
  invoke
    .mockReset()
    .mockImplementation((channel) =>
      Promise.resolve(
        channel === 'skillager:project-metadata'
          ? metadata
          : channel === 'skillager:prepare-project-setup'
            ? { ok: true, value: setup }
            : channel === 'skillager:start-project-setup'
              ? started
              : undefined,
      ),
    )
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke,
      on: (
        _channel: string,
        callback: (event: { id: string; exitCode: number }) => void,
      ) => {
        exits.add(callback)
        return () => exits.delete(callback)
      },
    },
  })
})
afterEach(() => {
  act(() => react.unmount())
  mount.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('starts one explicit new terminal and keeps the gesture disabled until matching exit and public observation', async () => {
  await render()
  expect(mount.textContent).toContain('Project review needed · Working not installed')
  expect(mount.textContent).toContain('/tools/skillager setup --agent codex')
  await act(() => {
    mount.querySelector('button')!.click()
    return Promise.resolve()
  })
  expect(open).toHaveBeenCalledOnce()
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'skillager:start-project-setup'),
  ).toHaveLength(0)
  expect(current.starting).toBe(true)
  await act(async () => {
    await prepared!.initialStart.start(request)
  })
  expect(current.running).toBe(true)
  expect(mount.querySelector('button')!.disabled).toBe(true)
  await act(async () => {
    await current.setup()
  })
  expect(open).toHaveBeenCalledOnce()
  await act(() => {
    for (const callback of exits) callback({ id: 'other-terminal', exitCode: 0 })
    return Promise.resolve()
  })
  expect(current.running).toBe(true)
  await act(() => {
    for (const callback of [...exits]) callback({ id: 'new-terminal', exitCode: 0 })
    return Promise.resolve()
  })
  expect(current.running).toBe(false)
  expect(mount.textContent).toContain('Project review needed')
  expect(mount.textContent).not.toContain('Project setup ready')
  expect(exits.size).toBe(0)
})

it('uses independent read and setup identities so an in-flight metadata completion still settles', async () => {
  let complete!: (value: unknown) => void
  const original = invoke.getMockImplementation()!
  invoke.mockReset().mockImplementation((channel, value) =>
    channel === 'skillager:project-metadata'
      ? new Promise((resolve) => {
          complete = resolve
        })
      : original(channel, value),
  )
  await render()
  expect(current.loading).toBe(true)
  await act(async () => {
    await current.setup()
  })
  await act(() => {
    complete(metadata)
    return Promise.resolve()
  })
  expect(current.loading).toBe(false)
  expect(current.result).toEqual(metadata)
  act(() => prepared!.initialStart.cancel())
})

it('releases a late prepared grant on disable and preserves an already handed-off user terminal', async () => {
  await render()
  await act(async () => {
    await current.setup()
    await prepared!.initialStart.start(request)
  })
  const releaseCount = () =>
    invoke.mock.calls.filter(([channel]) => channel === 'skillager:release-project-setup')
      .length
  const before = releaseCount()
  await render({ enabled: false })
  expect(releaseCount()).toBe(before)
  expect(exits.size).toBe(0)
  const original = invoke.getMockImplementation()!
  let resolve!: (value: unknown) => void
  invoke.mockImplementation((channel, value) =>
    channel === 'skillager:prepare-project-setup'
      ? new Promise((done) => {
          resolve = done
        })
      : original(channel, value),
  )
  await render()
  let pending!: Promise<void>
  act(() => {
    pending = current.setup()
  })
  await render({ enabled: false })
  await act(async () => {
    resolve({ ok: true, value: { ...setup, setupId: 'late-grant' } })
    await pending
  })
  expect(invoke).toHaveBeenCalledWith('skillager:release-project-setup', {
    setupId: 'late-grant',
  })
  expect(open).toHaveBeenCalledOnce()
})

it.each(['materialize', 'start'])(
  'cleans the one-use grant and exit listener after %s failure, without fallback or replay',
  async (failure) => {
    await render()
    if (failure === 'materialize')
      open.mockRejectedValueOnce(Error('Workspace unavailable'))
    else {
      const original = invoke.getMockImplementation()!
      invoke.mockImplementation((channel, value) =>
        channel === 'skillager:start-project-setup'
          ? Promise.resolve({
              ok: false,
              reason: 'cancelled',
              message: 'Setup handoff cancelled',
            })
          : original(channel, value),
      )
    }
    await act(async () => {
      await current.setup()
    })
    if (failure === 'start') {
      await act(async () => {
        await expect(prepared!.initialStart.start(request)).rejects.toThrow('cancelled')
      })
      await expect(prepared!.initialStart.start(request)).rejects.toThrow('again')
    }
    expect(exits.size).toBe(0)
    expect(current.starting).toBe(false)
    expect(invoke.mock.calls.some(([channel]) => channel === 'pty:start')).toBe(false)
    expect(invoke).toHaveBeenCalledWith('skillager:release-project-setup', {
      setupId: 'grant',
    })
  },
)

it('keeps demand scoped and recognizes a still-running terminal after re-enable or closure', async () => {
  await render({ demand: false })
  expect(
    invoke.mock.calls.some(([channel]) => channel === 'skillager:project-metadata'),
  ).toBe(false)
  const original = invoke.getMockImplementation()!
  let running = true
  invoke.mockImplementation((channel, value) =>
    channel === 'skillager:project-metadata'
      ? Promise.resolve({
          ...metadata,
          value: { ...metadata.value, setupRunning: running },
        })
      : original(channel, value),
  )
  await render()
  expect(current.running).toBe(true)
  await render({ enabled: false })
  await render()
  expect(current.running).toBe(true)
  expect(mount.querySelector('button')!.disabled).toBe(true)
  running = false
  await act(async () => {
    await current.refresh()
  })
  expect(current.running).toBe(false)
})
