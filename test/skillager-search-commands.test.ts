import { expect, it, vi } from 'vitest'
import { SkillagerSearchCommands } from '../src/main/skillager/skillager-search-commands'
import { SkillagerProcess } from '../src/main/skillager/skillager-process'
import { SkillagerError } from '../src/main/skillager/skillager-port'
import { asHostId, hostPath, localPath, type HostPath } from '../src/shared/host-path'
import type {
  SkillagerSearchRequest,
  SkillagerWorkspaceExposure,
} from '../src/shared/skillager'
import type { ExecOptions } from '../src/main/project-host/project-host'
import type { ExecResult } from '../src/shared'
import {
  searchEnvelope,
  searchLibrary,
  searchRequest,
} from './fixtures/skillager-search-fixture'

const selection = {
  executable: localPath('/tools/skillager'),
  catalog: localPath('/catalog'),
  environment: {},
  version: 'version-is-not-capability',
  library: searchLibrary,
  searchView: 'skillager.search.v1' as const,
}
const remote = hostPath(asHostId('ssh:fixture'), '/remote-only')
const request: SkillagerSearchRequest = {
  ...searchRequest,
  query: '--help; $HOME',
  scope: 'library',
  workspaceRoot: remote,
  includeInstalled: false,
}
const copy: SkillagerWorkspaceExposure = {
  id: 'copy',
  agent: 'claude',
  skillId: 'lib/merge',
  sourceLibraryId: searchLibrary.id,
  target: hostPath(remote.hostId, '/remote-only/copy'),
  mode: 'native',
  status: 'local_edit',
}
function fixture() {
  const writes = new Map<string, string>()
  const exec = vi.fn<
    (
      _command: string,
      args: readonly string[],
      options?: ExecOptions,
    ) => Promise<ExecResult>
  >((_command, args) => {
    const raw = searchEnvelope()
    raw.policy.scope = 'library'
    raw.policy.include_installed = args.includes('--include-installed')
    raw.context.project_root = null
    raw.context.installed_observation = args.includes('--installed-identities')
      ? 'provided'
      : 'unknown'
    raw.results = []
    if (
      !raw.policy.include_installed &&
      raw.context.installed_observation === 'unknown'
    ) {
      raw.status = 'unavailable'
      raw.reason_code = 'installed-state-unknown'
    }
    return Promise.resolve({
      code: raw.status === 'completed' ? 0 : 2,
      signal: null,
      stdout: JSON.stringify(raw),
      stderr: '',
    })
  })
  const process = new SkillagerProcess({ exec })
  const validate = vi.fn(() => Promise.resolve())
  const cleanup = vi.fn((path: HostPath) => {
    writes.delete(path.path)
    return Promise.resolve()
  })
  const commands = new SkillagerSearchCommands(
    {
      fileTransfer: {
        async writeFileChunksExclusive(path, chunks) {
          const bytes: Uint8Array[] = []
          for await (const chunk of chunks) bytes.push(chunk)
          writes.set(path.path, Buffer.concat(bytes).toString())
        },
      },
    },
    process,
    localPath('/private/context'),
    validate,
    cleanup,
  )
  return { commands, process, exec, validate, writes, cleanup }
}
it('sends one scoped CLI query with unique proven any-agent exclusions and cleans its exact input', async () => {
  const f = fixture()
  let encoded = ''
  const original = f.exec.getMockImplementation()!
  f.exec.mockImplementation((command, args, options) => {
    encoded = [...f.writes.values()][0]!
    return original(command, args, options)
  })
  const result = await f.commands.search(
    selection,
    request,
    new AbortController().signal,
    {
      exposures: [
        copy,
        { ...copy, agent: 'codex' },
        { ...copy, skillId: 'lib/older', status: 'source_update' },
      ],
    },
  )
  expect(JSON.parse(encoded)).toEqual({
    schema: 'skillager.search-installed.v1',
    identities: [
      { library_id: searchLibrary.id, skill_id: 'lib/merge' },
      { library_id: searchLibrary.id, skill_id: 'lib/older' },
    ],
  })
  expect(encoded).not.toContain(remote.path)
  expect(f.exec).toHaveBeenCalledTimes(1)
  const args = f.exec.mock.calls[0]![1]
  expect(args.slice(-2)).toEqual(['--', '--help; $HOME'])
  expect(args).not.toContain('--agent')
  expect(args).not.toContain(remote.path)
  expect(f.exec.mock.calls[0]![2]?.cwd).toEqual(localPath('/private/context'))
  expect(result.search.coverage).toBe('hvir-deliveries')
  expect(f.writes.size).toBe(0)
  expect(f.cleanup).toHaveBeenCalledTimes(1)
  await f.process.dispose()
})
it.each([
  undefined,
  [{ ...copy, status: 'uncertain' }],
  [{ ...copy, reconciliation: 'pending' as const }],
])('does not turn uncertain recorded presence into absence', async (exposures) => {
  const f = fixture()
  await expect(
    f.commands.search(selection, request, new AbortController().signal, { exposures }),
  ).rejects.toMatchObject({ reason: 'installed-unknown' })
  expect(f.writes.size).toBe(0)
  const included = await f.commands.search(
    selection,
    { ...request, includeInstalled: true },
    new AbortController().signal,
    { exposures },
  )
  expect(included.search.installedObservation).toBe('unknown')
  expect(
    f.exec.mock.calls.every(([, args]) => !args.includes('--installed-identities')),
  ).toBe(true)
  await f.process.dispose()
})
it('leaves unsupported discovery explicit and performs legacy search only when requested', async () => {
  const f = fixture()
  await expect(
    f.commands.search(
      { ...selection, searchView: undefined },
      request,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: 'search-unsupported' })
  expect(f.exec).not.toHaveBeenCalled()
  f.exec.mockResolvedValue({ code: 0, signal: null, stdout: '[]', stderr: '' })
  const result = await f.commands.search(
    { ...selection, searchView: undefined },
    { ...request, view: 'legacy', browseAgent: 'claude', includeInstalled: true },
    new AbortController().signal,
  )
  expect(result.search).toMatchObject({
    view: 'legacy',
    browseAgent: 'claude',
    includeInstalled: true,
  })
  expect(f.exec.mock.calls[0]![1]).toContain('--full-json')
  expect(f.exec.mock.calls[0]![1]).not.toContain('--view')
  expect(f.exec.mock.calls[0]![1]).toContain('claude')
  await f.process.dispose()
})
it('waits for actual process close before cleanup and preserves cancellation if cleanup fails', async () => {
  const f = fixture(),
    controller = new AbortController()
  let close!: () => void, started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  f.exec.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        close = () => reject(Error('closed'))
        started()
      }),
  )
  f.cleanup.mockRejectedValue(new Error('PRIVATE CLEANUP FAILURE'))
  const requestResult = f.commands.search(selection, request, controller.signal, {
    exposures: [copy],
  })
  const failure = expect(requestResult).rejects.toMatchObject({
    reason: 'cancelled',
    message: 'Skillager request cancelled. Temporary search input cleanup also failed.',
  })
  await ready
  controller.abort()
  expect(f.cleanup).not.toHaveBeenCalled()
  expect(f.writes.size).toBe(1)
  close()
  await failure
  expect(f.cleanup).toHaveBeenCalledTimes(1)
  await f.process.dispose()
})
it('preserves the primary deadline refusal when cleanup also fails', async () => {
  const f = fixture()
  f.exec.mockRejectedValue(new SkillagerError('timeout', 'Bounded search timeout.'))
  f.cleanup.mockRejectedValue(new Error('PRIVATE'))
  await expect(
    f.commands.search(selection, request, new AbortController().signal, {
      exposures: [copy],
    }),
  ).rejects.toMatchObject({
    reason: 'timeout',
    message: 'Bounded search timeout. Temporary search input cleanup also failed.',
  })
  await f.process.dispose()
})
