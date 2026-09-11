import type { SkillagerWorkspaceExposure } from '../src/shared/skillager'
import { describe, expect, it, vi } from 'vitest'
import { SkillagerExposureCommands } from '../src/main/skillager/skillager-exposure-commands'
import { SkillagerProcess } from '../src/main/skillager/skillager-process'
import { parseExposurePreview } from '../src/main/skillager/skillager-exposure-contract'
import { localPath, hostPath, asHostId, type HostPath } from '../src/shared/host-path'
import type { ExecResult } from '../src/shared/fs-types'
import type { ExecOptions } from '../src/main/project-host/project-host'
import {
  exposureResponse,
  request,
  selection,
  token,
} from './fixtures/skillager-exposure-fixture'

function fixture() {
  const exec = vi.fn(
    (_command: string, _args: readonly string[], _options: ExecOptions) =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: JSON.stringify(exposureResponse().value),
        stderr: '',
      } as ExecResult),
  )
  const realpath = vi.fn((path: HostPath) => Promise.resolve(path))
  const process = new SkillagerProcess({ exec })
  const validate = vi.fn(() => Promise.resolve())
  const observe = vi.fn(() => Promise.resolve<readonly SkillagerWorkspaceExposure[]>([]))
  const commands = new SkillagerExposureCommands({ realpath }, process, validate, observe)
  return { exec, realpath, process, commands, validate, observe }
}
describe('bounded local exposure command adapter', () => {
  it('uses selected cwd, reconstructed argv, finite output/time bounds and one bound apply', async () => {
    const f = fixture(),
      snapshot = await f.commands.previewExposure(
        selection,
        request,
        new AbortController().signal,
      )
    expect(f.exec).toHaveBeenCalledWith(
      '/skillager',
      [
        '--catalog-state-dir',
        '/catalog',
        'expose',
        'lib/demo',
        '--mode',
        'native',
        '--agent',
        'codex',
        '--scope',
        'project',
        '--json',
        '--dry-run',
      ],
      expect.objectContaining({
        cwd: request.destination.root,
        maxStdoutBytes: 4 * 1024 * 1024,
        maxStderrBytes: 64 * 1024,
      }),
    )
    const response = exposureResponse()
    response.row.status = 'exposed'
    f.exec.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: JSON.stringify(response.value),
      stderr: '',
    })
    await expect(
      f.commands.applyExposure(selection, snapshot, new AbortController().signal),
    ).resolves.toMatchObject({ status: 'exposed' })
    expect(f.exec.mock.calls[1]![1].slice(-3)).toEqual([
      '--yes',
      '--confirmation-token',
      token,
    ])
    await f.process.dispose()
  })
  it.each([
    '--yes',
    '../lib-demo',
    'with space',
    'line\nbreak',
    'lib/demo',
    '.',
    '..',
    'x'.repeat(513),
  ])('refuses an unsafe selected ID before any CLI invocation: %s', async (id) => {
    const f = fixture(),
      selected = {
        ...request,
        action: 'remove' as const,
        exposure: {
          id,
          skillId: request.skillId,
          target: localPath('/other/copies/lib-demo'),
          mode: 'native',
          status: 'current',
        },
      }
    await expect(
      f.commands.previewExposure(selection, selected, new AbortController().signal),
    ).rejects.toMatchObject({ reason: 'invalid-request' })
    expect(f.exec).not.toHaveBeenCalled()
    expect(f.validate).not.toHaveBeenCalled()
    await f.process.dispose()
  })
  it.each([
    localPath('/outside/lib-demo'),
    localPath('/other'),
    localPath('/other/copies/different'),
    hostPath(asHostId('ssh-target'), '/other/copies/lib-demo'),
  ])('refuses an unbound selected target before any CLI invocation', async (target) => {
    const f = fixture(),
      selected = {
        ...request,
        action: 'remove' as const,
        exposure: {
          id: 'lib-demo',
          skillId: request.skillId,
          target,
          mode: 'native',
          status: 'current',
        },
      }
    await expect(
      f.commands.previewExposure(selection, selected, new AbortController().signal),
    ).rejects.toMatchObject({ reason: 'invalid-request' })
    expect(f.exec).not.toHaveBeenCalled()
    await f.process.dispose()
  })
  it('rejects a changed canonical destination before dispatch', async () => {
    const f = fixture()
    f.realpath.mockResolvedValue(localPath('/elsewhere'))
    await expect(
      f.commands.previewExposure(selection, request, new AbortController().signal),
    ).rejects.toMatchObject({ reason: 'unavailable' })
    expect(f.exec).not.toHaveBeenCalled()
    await f.process.dispose()
  })
  it('separates skipped refusal from uncertain post-dispatch results without retrying', async () => {
    const f = fixture(),
      snapshot = parseExposurePreview(exposureResponse().value, selection, request)
    const response = exposureResponse()
    Object.assign(response.row, { status: 'skipped', reason: 'preview is stale' })
    f.exec
      .mockResolvedValueOnce({
        code: 0,
        signal: null,
        stdout: JSON.stringify(response.value),
        stderr: '',
      })
      .mockResolvedValue({ code: 0, signal: null, stdout: 'incomplete', stderr: '' })
    await expect(
      f.commands.applyExposure(selection, snapshot, new AbortController().signal),
    ).rejects.toMatchObject({ reason: 'stale-review' })
    expect(f.exec).toHaveBeenCalledTimes(1)
    await expect(
      f.commands.applyExposure(selection, snapshot, new AbortController().signal),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    expect(f.exec).toHaveBeenCalledTimes(2)
    await f.process.dispose()
  })
  it('shares two-process admission with other CLI commands and never queues a write', async () => {
    const f = fixture(),
      snapshot = parseExposurePreview(exposureResponse().value, selection, request)
    f.exec.mockImplementation(
      (_command, _args, options) =>
        new Promise((_resolve, reject) =>
          options.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        ),
    )
    const limits = { stdout: 1024, stderr: 1024, deadlineMs: 30_000 }
    const first = f.process.run('metadata', [], {}, limits).catch(() => undefined),
      second = f.process.run('review', [], {}, limits).catch(() => undefined)
    await expect(
      f.commands.applyExposure(selection, snapshot, new AbortController().signal),
    ).rejects.toMatchObject({ reason: 'busy' })
    expect(f.exec).toHaveBeenCalledTimes(2)
    await f.process.dispose()
    await Promise.all([first, second])
  })
})

it('validates selection and canonical destination before reading workspace update status', async () => {
  const f = fixture()
  const snapshot = parseExposurePreview(exposureResponse().value, selection, request)
  try {
    f.validate.mockRejectedValueOnce(new Error('Changed library'))
    await expect(
      f.commands.updateSourceHash(selection, snapshot, new AbortController().signal),
    ).rejects.toThrow('Changed library')
    expect(f.observe).not.toHaveBeenCalled()
    f.realpath.mockResolvedValueOnce(localPath('/changed'))
    await expect(
      f.commands.updateSourceHash(selection, snapshot, new AbortController().signal),
    ).rejects.toThrow('location changed')
    expect(f.observe).not.toHaveBeenCalled()
    expect(f.exec).not.toHaveBeenCalled()
  } finally {
    await f.process.dispose()
  }
})

it('uses the existing exposure observer and independently bounds the library-status command', async () => {
  const f = fixture()
  const exposure = {
    id: 'lib-demo',
    skillId: request.skillId,
    target: localPath('/other/.agents/skills/lib-demo'),
    mode: 'native',
    status: 'source_update',
    expectedSourceHash: 'a'.repeat(64),
  }
  const update = { ...request, action: 'update' as const, exposure }
  const snapshot = parseExposurePreview(
    exposureResponse({ ...update, action: 'change' }).value,
    selection,
    update,
  )
  f.observe.mockResolvedValue([exposure])
  f.exec.mockResolvedValue({
    code: 0,
    signal: null,
    stderr: '',
    stdout: JSON.stringify({
      schema: 'skillager.library-status.v1',
      skill: {
        id: request.skillId,
        path: '/library/skills/demo',
        acceptance: 'accepted',
        working_hash: 'a'.repeat(64),
        accepted_hash: 'a'.repeat(64),
        exposures: [
          {
            path: exposure.target.path,
            agent: request.agent,
            kind: 'native',
            scope: 'project',
            status: 'update_available',
            source_hash: 'c'.repeat(64),
          },
        ],
      },
    }),
  })
  try {
    expect(
      await f.commands.updateSourceHash(
        selection,
        snapshot,
        new AbortController().signal,
      ),
    ).toBe('c'.repeat(64))
    expect(f.observe).toHaveBeenCalledTimes(1)
    expect(f.observe).toHaveBeenCalledWith(
      selection,
      { ...update, workspaceRoot: request.destination.root },
      expect.any(AbortSignal),
    )
    expect(f.exec).toHaveBeenCalledTimes(1)
    expect(f.exec).toHaveBeenCalledWith(
      '/skillager',
      ['--catalog-state-dir', '/catalog', 'library', 'status', request.skillId, '--json'],
      expect.objectContaining({
        cwd: request.destination.root,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 64 * 1024,
      }),
    )
  } finally {
    await f.process.dispose()
  }
})
