import { expect, it, onTestFinished, vi } from 'vitest'
import {
  exposureResponse,
  request as directRequest,
} from './fixtures/skillager-exposure-fixture'
import {
  parseRouterRemoval,
  type SkillagerRouterRemovalSnapshot,
} from '../src/main/skillager/skillager-router-removal-contract'
import type { SkillagerRouterRemovalRequest } from '../src/shared/skillager-exposure-plan'
import { SkillagerExposurePlanCommands } from '../src/main/skillager/skillager-exposure-plan-commands'
import { SkillagerProcess } from '../src/main/skillager/skillager-process'
import {
  parsePlanPreview,
  planCommand,
} from '../src/main/skillager/skillager-exposure-plan-contract'
import type { ExecOptions } from '../src/main/project-host/project-host'
import type { ExecResult } from '../src/shared/fs-types'
import { localPath, type HostPath } from '../src/shared/host-path'
import {
  planApplied,
  planRequest,
  planResponse,
  planSelection,
  planToken,
} from './fixtures/skillager-plan-fixture'

function fixture() {
  const exec = vi
    .fn<
      (
        _command: string,
        _args: readonly string[],
        _options: ExecOptions,
      ) => Promise<ExecResult>
    >()
    .mockResolvedValue({
      code: 0,
      signal: null,
      stdout: JSON.stringify(planResponse()),
      stderr: '',
    })
  const realpath = vi.fn((path: HostPath) => Promise.resolve(path)),
    validate = vi.fn(() => Promise.resolve()),
    process = new SkillagerProcess({ exec })
  onTestFinished(() => process.dispose())
  return {
    exec,
    realpath,
    validate,
    process,
    commands: new SkillagerExposurePlanCommands({ realpath }, process, validate),
  }
}
it('dispatches only reconstructed bounded argv with exact destination and retained token', async () => {
  const f = fixture(),
    signal = new AbortController().signal
  const snapshot = await f.commands.previewLocalAction(planSelection, planRequest, signal)
  expect(f.exec).toHaveBeenCalledWith(
    planSelection.executable.path,
    [
      '--catalog-state-dir',
      planSelection.catalog.path,
      ...planCommand(planRequest),
      '--dry-run',
    ],
    expect.objectContaining({
      cwd: planRequest.destination.root,
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 64 * 1024,
    }),
  )
  f.exec.mockResolvedValueOnce({
    code: 0,
    signal: null,
    stdout: JSON.stringify(planApplied()),
    stderr: '',
  })
  const submitted = vi.fn()
  expect(
    await f.commands.applyLocalAction(planSelection, snapshot, signal, submitted),
  ).toMatchObject({ kind: 'plan', status: 'applied' })
  expect(f.exec.mock.calls[1]![1].slice(-3)).toEqual([
    '--yes',
    '--confirmation-token',
    planToken,
  ])
  expect(submitted).toHaveBeenCalledTimes(1)
})
it('keeps rejected old options distinct from malformed/partial apply evidence and never retries', async () => {
  const f = fixture(),
    signal = new AbortController().signal,
    snapshot = parsePlanPreview(planResponse(), 0, planSelection, planRequest)
  f.exec.mockResolvedValueOnce({
    code: 2,
    signal: null,
    stdout: '',
    stderr: 'unrecognized arguments: --request-json',
  })
  await expect(
    f.commands.previewLocalAction(planSelection, planRequest, signal),
  ).rejects.toMatchObject({ reason: 'unsupported' })
  f.exec.mockResolvedValueOnce({
    code: 2,
    signal: null,
    stdout: JSON.stringify({
      schema: 'skillager.exposure-plan.v1',
      status: 'refused',
      reason_code: 'target-changed',
      results: [],
    }),
    stderr: '',
  })
  await expect(
    f.commands.applyLocalAction(planSelection, snapshot, signal, vi.fn()),
  ).rejects.toMatchObject({ reason: 'review-refused' })
  f.exec.mockResolvedValueOnce({
    code: 2,
    signal: null,
    stdout: '{incomplete',
    stderr: '',
  })
  await expect(
    f.commands.applyLocalAction(planSelection, snapshot, signal, vi.fn()),
  ).rejects.toMatchObject({ reason: 'uncertain' })
  expect(f.exec).toHaveBeenCalledTimes(3)
})
it('rechecks canonical target confinement before submission', async () => {
  const f = fixture(),
    snapshot = parsePlanPreview(planResponse(), 0, planSelection, planRequest),
    submitted = vi.fn()
  f.realpath.mockImplementation((path) =>
    Promise.resolve(
      path.path.endsWith('router-guidance')
        ? localPath('/foreign/router-guidance')
        : path,
    ),
  )
  await expect(
    f.commands.applyLocalAction(
      planSelection,
      snapshot,
      new AbortController().signal,
      submitted,
    ),
  ).rejects.toThrow()
  expect(submitted).not.toHaveBeenCalled()
  expect(f.exec).not.toHaveBeenCalled()
})
it('shares the existing two-process admission and does not queue an aggregate mutation', async () => {
  const f = fixture(),
    snapshot = parsePlanPreview(planResponse(), 0, planSelection, planRequest)
  f.exec.mockImplementation(
    (_command, _args, options) =>
      new Promise((_resolve, reject) =>
        options.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      ),
  )
  const limits = { stdout: 1024, stderr: 1024, deadlineMs: 30_000 },
    first = f.process.run('read', [], {}, limits).catch(() => undefined),
    second = f.process.run('read', [], {}, limits).catch(() => undefined)
  await expect(
    f.commands.applyLocalAction(
      planSelection,
      snapshot,
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toMatchObject({ reason: 'busy' })
  expect(f.exec).toHaveBeenCalledTimes(2)
  await f.process.dispose()
  await Promise.all([first, second])
})

it('classifies only the complete nonzero Remove stale diagnostic as proven refusal; unknown text and inconsistent success stay uncertain', async () => {
  const f = fixture(),
    at = {
      ...directRequest,
      workspaceRoot: directRequest.destination.root,
      action: 'remove' as const,
      exposure: {
        id: 'lib-demo',
        target: localPath('/other/.agents/skills/lib-demo'),
        agent: 'codex' as const,
        mode: 'native',
        status: 'current',
        skillId: 'lib/demo',
      },
    }
  const raw = exposureResponse(at)
  Object.assign(raw.row, { mode: 'router', skill_id: null })
  const request: SkillagerRouterRemovalRequest = {
    ...at,
    action: 'remove-router',
    exposure: { ...at.exposure, skillId: undefined, mode: 'router' },
  }
  const snapshot = parseRouterRemoval(
    raw.value,
    request,
  ) as SkillagerRouterRemovalSnapshot
  const exact =
    'skillager: error: exposure removal preview is stale or does not match this command; review the current preview and execute its returned command\n'
  for (const [code, stdout, stderr, reason] of [
    [2, '', exact, 'stale-review'],
    [
      2,
      '',
      'skillager: error: managed exposure has local edits; preview again with --force only if those edits may be discarded\n',
      'review-refused',
    ],
    [2, '', `failed to read filename "${exact.trim()}"`, 'uncertain'],
    [2, '', `${exact}additional failure\n`, 'uncertain'],
    [1, '', exact, 'uncertain'],
    [2, '{}', exact, 'uncertain'],
  ] as const) {
    f.exec.mockResolvedValueOnce({ code, stdout, stderr, signal: null })
    await expect(
      f.commands.applyLocalAction(
        planSelection,
        snapshot,
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ reason })
  }
  Object.assign(raw.row, {
    status: 'removed',
    target: '/other/.agents/skills/foreign',
    exposure_id: 'foreign',
  })
  f.exec.mockResolvedValueOnce({
    code: 0,
    stdout: JSON.stringify(raw.value),
    stderr: '',
    signal: null,
  })
  await expect(
    f.commands.applyLocalAction(
      planSelection,
      snapshot,
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toMatchObject({ reason: 'uncertain' })
  expect(f.exec).toHaveBeenCalledTimes(7)
})

it('keeps missing-router preview a sanitized current-target refusal rather than an unsupported installation', async () => {
  const f = fixture()
  f.exec.mockResolvedValueOnce({
    code: 2,
    signal: null,
    stdout: '',
    stderr: 'skillager: error: exposure not found: router-missing\n',
  })
  await expect(
    f.commands.previewLocalAction(
      planSelection,
      {
        ...planRequest,
        action: 'remove-router',
        exposure: {
          id: 'router-missing',
          mode: 'router',
          agent: 'codex',
          target: localPath('/workspace/.agents/skills/router-missing'),
          status: 'current',
        },
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: 'review-refused' })
  expect(f.exec).toHaveBeenCalledTimes(1)
})
