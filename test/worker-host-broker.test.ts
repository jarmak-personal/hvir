import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { dispatchWorkerHostCall } from '../src/main/git/worker-host-broker'
import { LocalHost } from '../src/main/project-host'
import { localPath, type WorkerHostCall } from '../src/shared'

type ExecHostCall = Extract<WorkerHostCall, { readonly operation: 'exec' }>

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('Git worker host broker', () => {
  it('pins execution to git and the active project root', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-'))
    cleanups.push(rootPath)
    const host = new LocalHost()
    const realpath = vi.spyOn(host, 'realpath')
    const exec = vi.spyOn(host, 'exec').mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
    })
    const call = hostCall(rootPath)

    await dispatchWorkerHostCall(call, { host, root: localPath(rootPath) })
    await dispatchWorkerHostCall(call, { host, root: localPath(rootPath) })

    expect(exec).toHaveBeenLastCalledWith('git', call.args, {
      cwd: localPath(rootPath),
      input: undefined,
      maxBuffer: 10 * 1024 * 1024,
    })
    expect(realpath).toHaveBeenCalledOnce()
  })

  it('rejects arbitrary commands and paths outside the active root', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-'))
    const outside = await mkdtemp(join(tmpdir(), 'hvir-broker-outside-'))
    cleanups.push(rootPath, outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const host = new LocalHost()
    const project = { host, root: localPath(rootPath) }

    await expect(
      dispatchWorkerHostCall({ ...hostCall(rootPath), command: 'sh' }, project),
    ).rejects.toThrow('only git')
    await expect(
      dispatchWorkerHostCall(
        {
          kind: 'host-call',
          callId: 2,
          hostId: 'local',
          operation: 'readTextFile',
          path: localPath(join(outside, 'secret.txt')),
        },
        project,
      ),
    ).rejects.toThrow('escapes the active project')
  })
})

function hostCall(root: string): ExecHostCall {
  return {
    kind: 'host-call',
    callId: 1,
    hostId: 'local',
    operation: 'exec',
    command: 'git',
    args: ['-C', root, 'status', '--porcelain=v2'],
  }
}
