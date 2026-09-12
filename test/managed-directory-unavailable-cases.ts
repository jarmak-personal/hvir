import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { joinHostPath, type HostPath } from '../src/shared/host-path'
import type { ProjectHost } from '../src/main/project-host/project-host'
import { SshManagedDirectory } from '../src/main/project-host/ssh-managed-directory'
import { inspectionLocation } from '../src/main/project-host/managed-directory-contract'

/** Actual fixed-program unsupported syscall and first-error observation contracts. */
export async function managedDirectoryUnavailableCases(
  host: ProjectHost,
  root: HostPath,
): Promise<readonly string[]> {
  const signal = AbortSignal.timeout(60_000),
    passed: string[] = []
  const tree = {
    files: [
      {
        entry: 'SKILL.md',
        mode: 0o644 as const,
        size: 4,
        sha256: createHash('sha256').update('test').digest('hex'),
      },
    ],
  }
  const bytes = new Map([['SKILL.md', Buffer.from('test')]])
  const port = new SshManagedDirectory(host, () => {})
  const at = async (entry: string) => {
    const observed = await port.inspect(root, entry, tree, signal)
    assert.notEqual(observed.status, 'different')
    return inspectionLocation(
      observed as Exclude<typeof observed, { status: 'different' }>,
    )
  }
  const altered = (mode: string) =>
    new SshManagedDirectory(
      {
        hostId: host.hostId,
        execStream: (command, args, options) =>
          host.execStream(
            command,
            [
              '-c',
              `import ctypes,errno\n_cdll=ctypes.CDLL\n_mode=${JSON.stringify(mode)}\nclass _Call:\n def __init__(self, fn): self.fn=fn\n def __call__(self,a,b,c,d,flags):\n  if _mode=='kernel' or (_mode=='flags' and flags==2):\n   ctypes.set_errno(errno.ENOSYS if _mode=='kernel' else errno.EINVAL); return -1\n  if b and _mode in ('filesystem','lost-success'):\n   if _mode=='lost-success': self.fn(a,b,c,d,flags)\n   ctypes.set_errno(errno.EOPNOTSUPP); return -1\n  return self.fn(a,b,c,d,flags)\nclass _Library:\n def __init__(self,*args,**kwargs):\n  if _mode!='libc': self.renameat2=_Call(_cdll(*args,**kwargs).renameat2)\nctypes.CDLL=_Library\n` +
                args[1]!,
            ],
            options,
          ),
      },
      () => {},
    )
  for (const mode of ['libc', 'kernel', 'flags']) {
    const unsupported = altered(mode),
      entry = `unsupported-${mode}/.candidate`
    const before = await host.readdir(root),
      submitted: string[] = []
    await assert.rejects(
      unsupported.stage(root, entry, tree, bytes, await at(entry), signal),
      { reason: 'unavailable' },
    )
    assert.deepEqual(await host.readdir(root), before)
    const candidate = await port.stage(
      root,
      `.candidate-${mode}`,
      tree,
      bytes,
      await at(`.candidate-${mode}`),
      signal,
    )
    await assert.rejects(
      unsupported.commit(
        { action: 'add', candidate, target: `target-${mode}` },
        { signal, onSubmitted: () => submitted.push('submitted') },
      ),
      { reason: 'unavailable' },
    )
    assert.deepEqual(submitted, [])
    assert.equal(
      (await port.inspect(root, candidate.entry, tree, signal)).status,
      'exact',
    )
    await assert.rejects(unsupported.cleanup(candidate, signal), {
      reason: 'unavailable',
    })
    assert.equal(
      (await port.inspect(root, candidate.entry + '.cleanup', tree, signal)).status,
      'absent',
    )
    assert.equal(await port.cleanup(candidate, signal), true)
    passed.push(`${mode} unavailability precedes stage, submitting, and cleanup effects`)
  }
  for (const action of ['add', 'update', 'remove'] as const) {
    const unsupported = altered('filesystem'),
      target = `unsupported-target-${action}`
    const candidate = await port.stage(
      root,
      `.candidate-${action}`,
      tree,
      bytes,
      await at(`.candidate-${action}`),
      signal,
    )
    const before =
      action === 'add'
        ? undefined
        : await port.stage(root, target, tree, bytes, await at(target), signal)
    const operation =
      action === 'add'
        ? { action, candidate, target }
        : action === 'update'
          ? { action, candidate, before: before! }
          : { action, before: before!, quarantine: `.removed-${action}` }
    let submitted = false
    await assert.rejects(
      unsupported.commit(operation, {
        signal,
        onSubmitted: () => {
          submitted = true
        },
      }),
      { reason: 'unavailable' },
    )
    assert.equal(submitted, true)
    assert.equal(
      (await port.inspect(root, candidate.entry, tree, signal)).status,
      'exact',
    )
    assert.equal(
      (await port.inspect(root, target, tree, signal)).status,
      before ? 'exact' : 'absent',
    )
    assert.equal(await port.cleanup(candidate, signal), true)
    if (before) assert.equal(await port.cleanup(before, signal), true)
    passed.push(`unsupported first ${action} rename requires exact original-state proof`)
  }
  const lost = await port.stage(
    root,
    '.lost-source',
    tree,
    bytes,
    await at('.lost-source'),
    signal,
  )
  const result = await altered('lost-success').commit(
    { action: 'add', candidate: lost, target: 'lost-target' },
    { signal, onSubmitted: () => {} },
  )
  assert.equal(result.status, 'uncertain')
  const published = await port.inspect(root, 'lost-target', tree, signal)
  assert.equal(published.status, 'exact')
  if (published.status === 'exact')
    assert.equal(await port.cleanup(published.receipt, signal), true)
  passed.push(
    'failed syscall after an actual rename remains uncertain and retains the published object',
  )
  const residual = await port.stage(
    root,
    '.cleanup-source',
    tree,
    bytes,
    await at('.cleanup-source'),
    signal,
  )
  assert.equal(await altered('filesystem').cleanup(residual, signal), false)
  assert.equal((await port.inspect(root, residual.entry, tree, signal)).status, 'exact')
  assert.equal(
    (await host.stat(joinHostPath(root, residual.entry + '.cleanup'))).type,
    'dir',
  )
  passed.push(
    'unsupported cleanup after exclusive quarantine creation retains explicit partial effects',
  )
  return passed
}
