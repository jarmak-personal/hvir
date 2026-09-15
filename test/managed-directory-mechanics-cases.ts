import assert from 'node:assert/strict'
import { managedDirectoryUnavailableCases } from './managed-directory-unavailable-cases'
import { createHash } from 'node:crypto'
import { joinHostPath, type HostPath } from '../src/shared/host-path'
import type { ProjectHost } from '../src/main/project-host/project-host'
import { SshManagedDirectory } from '../src/main/project-host/ssh-managed-directory'
import { inspectionLocation } from '../src/main/project-host/managed-directory-contract'
import type { ManagedDirectoryTree } from '../src/main/project-host/managed-directory'

/** Real Python/syscall contract, reusable by Linux and explicitly configured SSH acceptance. */
export async function managedDirectoryMechanicsCases(
  host: ProjectHost,
  root: HostPath,
): Promise<readonly string[]> {
  const passed: string[] = []
  const signal = AbortSignal.timeout(60_000)
  const port = host.managedDirectory ?? new SshManagedDirectory(host, () => {})
  const location = async (entry: string, tree: ManagedDirectoryTree) => {
    const observed = await port.inspect(root, entry, tree, signal)
    assert.notEqual(observed.status, 'different')
    return inspectionLocation(
      observed as Exclude<typeof observed, { status: 'different' }>,
    )
  }
  const source = (text: string) => {
    const bytes = new Map<string, Uint8Array>([
      ['SKILL.md', Buffer.from(text)],
      ['references/😀.bin', Buffer.alloc(130_000, 0xfe)],
      ['helper.sh', Buffer.from('#!/bin/sh\nprintf fixture\n')],
    ])
    return {
      bytes,
      tree: {
        files: [...bytes].map(([entry, content]) => ({
          entry,
          mode: entry === 'helper.sh' ? (0o755 as const) : (0o644 as const),
          size: content.byteLength,
          sha256: createHash('sha256').update(content).digest('hex'),
        })),
      },
    }
  }
  const initial = source('First accepted source\n'),
    next = source('Next accepted source\n')
  const target = '.agents/skills/lib-fixture'
  const read = async () => {
    const result = await host.exec(
      'python3',
      [
        '-c',
        'import sys;sys.stdout.buffer.write(open(sys.argv[1],"rb").read())',
        joinHostPath(root, target, 'SKILL.md').path,
      ],
      { signal, maxBuffer: 4096 },
    )
    assert.equal(result.code, 0)
    return result.stdout
  }
  const edit = async (entry: string, text: string) => {
    const result = await host.exec(
      'python3',
      [
        '-c',
        'import json,os,sys\np,t=json.loads(sys.stdin.read())\nfd=os.open(p,os.O_WRONLY|os.O_TRUNC|os.O_NOFOLLOW)\ntry: os.write(fd,t.encode())\nfinally: os.close(fd)',
      ],
      {
        input: JSON.stringify([joinHostPath(root, entry).path, text]),
        signal,
        maxBuffer: 4096,
      },
    )
    assert.equal(result.code, 0)
  }
  assert.equal((await port.inspect(root, target, initial.tree, signal)).status, 'absent')
  const first = await port.stage(
    root,
    '.agents/skills/.first',
    initial.tree,
    initial.bytes,
    await location('.agents/skills/.first', initial.tree),
    signal,
  )
  const contended = new SshManagedDirectory(
    {
      hostId: host.hostId,
      execStream: (command, args, options) =>
        host.execStream(
          command,
          [
            '-c',
            `import fcntl,os,stat\n_flock=fcntl.flock\ndef _contend(fd,operation):\n assert stat.S_ISDIR(os.fstat(fd).st_mode)\n other=os.open('.',os.O_RDONLY|os.O_DIRECTORY,dir_fd=fd)\n try:\n  _flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)\n  _flock(fd,operation)\n finally: os.close(other)\nfcntl.flock=_contend\n` +
              args[1]!,
          ],
          options,
        ),
    },
    () => {},
  )
  assert.equal(
    (
      await contended.commit(
        { action: 'add', candidate: first, target },
        { signal, onSubmitted: () => {} },
      )
    ).status,
    'not-applied',
  )
  assert.equal(
    (await port.inspect(root, first.entry, initial.tree, signal)).status,
    'exact',
  )
  assert.equal((await port.inspect(root, target, initial.tree, signal)).status, 'absent')
  const added = await port.commit(
    { action: 'add', candidate: first, target },
    { signal, onSubmitted: () => {} },
  )
  assert.equal(added.status, 'completed')
  assert(added.published)
  assert.equal(await read(), 'First accepted source\n')
  passed.push('bounded complete-tree Add with binary, executable and Unicode files')
  assert.deepEqual(
    (await host.readdir(root)).map((entry) => entry.name),
    ['.agents'],
  )
  passed.push(
    'verified parent-directory flock rejects a competing lock and leaves no project-root artifact',
  )
  const candidate = await port.stage(
    root,
    '.agents/skills/.second',
    next.tree,
    next.bytes,
    await location('.agents/skills/.second', next.tree),
    signal,
  )
  assert.equal(
    (
      await port.commit(
        { action: 'add', candidate, target },
        { signal, onSubmitted: () => {} },
      )
    ).status,
    'not-applied',
  )
  assert.equal(await read(), 'First accepted source\n')
  passed.push('Add collision preserves both complete trees')
  const updated = await port.commit(
    { action: 'update', candidate, before: added.published },
    { signal, onSubmitted: () => {} },
  )
  assert.equal(updated.status, 'completed')
  assert(updated.published)
  assert(updated.displaced)
  assert.equal(await read(), 'Next accepted source\n')
  assert.equal(await port.cleanup(updated.displaced, signal), true)
  passed.push('atomic Full update and exact displaced cleanup')
  await edit(target + '/SKILL.md', 'Human changes\n')
  assert.equal((await port.inspect(root, target, next.tree, signal)).status, 'different')
  assert.equal(
    (
      await port.commit(
        {
          action: 'remove',
          before: updated.published,
          quarantine: '.agents/skills/.removed',
        },
        { signal, onSubmitted: () => {} },
      )
    ).status,
    'not-applied',
  )
  assert.equal(await read(), 'Human changes\n')
  passed.push('modified target refuses removal and preserves content')
  await edit(target + '/SKILL.md', 'Next accepted source\n')

  // Inject an ordinary external edit at the actual libc rename boundary. The
  // production Python program is unchanged; only its immediate syscall is wrapped.
  const raced = (action: 'update' | 'remove' | 'cleanup' | 'cleanup-replacement') =>
    new SshManagedDirectory(
      {
        hostId: host.hostId,
        execStream: (command, args, options) => {
          const prefix = `import ctypes,os\n_original_cdll=ctypes.CDLL\n_fired=False\nclass _Rename:\n def __init__(self,fn): self.fn=fn\n def __call__(self,source_fd,source,destination_fd,destination,flags):\n  global _fired\n  if not _fired and source and destination:\n   _fired=True\n   name=${action === 'update' ? 'destination' : 'source'}\n   fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=source_fd)\n   try:\n    ${action === 'cleanup-replacement' ? "os.rename('SKILL.md','retained-original',src_dir_fd=fd,dst_dir_fd=fd)\n    " : ''}leaf=os.open('SKILL.md',os.O_WRONLY|os.O_TRUNC|os.O_NOFOLLOW|os.O_CREAT,0o644,dir_fd=fd)\n    try: os.write(leaf,b'Concurrent human edit\\n')\n    finally: os.close(leaf)\n   finally: os.close(fd)\n  return self.fn(source_fd,source,destination_fd,destination,flags)\nclass _Lib:\n def __init__(self,*a,**kw):\n  lib=_original_cdll(*a,**kw)\n  real=lib.renameat2\n  real.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]\n  self.renameat2=_Rename(real)\nctypes.CDLL=_Lib\n`
          return host.execStream(command, ['-c', prefix + args[1]!], options)
        },
      },
      () => {},
    )
  const racedCandidate = await port.stage(
    root,
    '.agents/skills/.raced',
    initial.tree,
    initial.bytes,
    await location('.agents/skills/.raced', initial.tree),
    signal,
  )
  const racedUpdate = await raced('update').commit(
    { action: 'update', candidate: racedCandidate, before: updated.published },
    { signal, onSubmitted: () => {} },
  )
  assert.equal(racedUpdate.status, 'uncertain')
  assert.equal(await read(), 'Concurrent human edit\n')
  assert.equal(await port.cleanup(racedCandidate, signal), true)
  passed.push(
    'update race checks displaced content and restores without deleting the edit',
  )
  await edit(target + '/SKILL.md', 'Next accepted source\n')
  assert.equal(
    (
      await raced('remove').commit(
        {
          action: 'remove',
          before: updated.published,
          quarantine: '.agents/skills/.race-removed',
        },
        { signal, onSubmitted: () => {} },
      )
    ).status,
    'uncertain',
  )
  assert.equal(await read(), 'Concurrent human edit\n')
  passed.push('remove race retains the concurrently edited directory')
  await edit(target + '/SKILL.md', 'Next accepted source\n')
  assert.equal(await raced('cleanup').cleanup(updated.published, signal), false)
  assert.equal(await read(), 'Concurrent human edit\n')
  passed.push(
    'cleanup race verifies private displaced object and retains external changes',
  )
  await edit(target + '/SKILL.md', 'Next accepted source\n')
  const removed = await port.commit(
    {
      action: 'remove',
      before: updated.published,
      quarantine: '.agents/skills/.removed',
    },
    { signal, onSubmitted: () => {} },
  )
  assert.equal(removed.status, 'completed')
  assert(removed.displaced)
  assert.equal((await port.inspect(root, target, next.tree, signal)).status, 'absent')
  assert.equal(await port.cleanup(removed.displaced, signal), true)
  passed.push('unchanged managed removal publishes absence and cleans exact receipt')

  const partial = await port.stage(
    root,
    '.agents/skills/.partial-cleanup',
    initial.tree,
    initial.bytes,
    await location('.agents/skills/.partial-cleanup', initial.tree),
    signal,
  )
  const interrupted = new SshManagedDirectory(
    {
      hostId: host.hostId,
      execStream: (command, args, options) =>
        host.execStream(
          command,
          [
            '-c',
            `import os\n_unlink=os.unlink\n_count=0\ndef _fail_after_one(*args,**kw):\n global _count\n _count+=1\n if _count==2: raise OSError('injected cleanup interruption')\n return _unlink(*args,**kw)\nos.unlink=_fail_after_one\n` +
              args[1]!,
          ],
          options,
        ),
    },
    () => {},
  )
  assert.equal(await interrupted.cleanup(partial, signal), false)
  assert.equal(
    await host.readTextFile(
      joinHostPath(root, '.agents/skills/.partial-cleanup.cleanup/tree/helper.sh'),
    ),
    '#!/bin/sh\nprintf fixture\n',
  )
  passed.push('partial cleanup failure retains the private residual tree')
  const restrictive = new SshManagedDirectory(
    {
      hostId: host.hostId,
      execStream: (command, args, options) =>
        host.execStream(
          command,
          ['-c', 'import os\nos.umask(0o077)\n' + args[1]!],
          options,
        ),
    },
    () => {},
  )
  const privateMode = await restrictive.stage(
    root,
    '.agents/skills/.restrictive',
    initial.tree,
    initial.bytes,
    await location('.agents/skills/.restrictive', initial.tree),
    signal,
  )
  assert.equal(
    (await port.inspect(root, privateMode.entry, initial.tree, signal)).status,
    'exact',
  )
  assert.equal(await port.cleanup(privateMode, signal), true)
  passed.push(
    'restrictive umask normalizes only newly created exported directories and files',
  )

  const empty = joinHostPath(root, 'replaceable-workspace')
  await host.createDirectoryExclusive(empty, { mode: 0o755, signal })
  const emptyObserved = await port.inspect(empty, target, initial.tree, signal)
  assert.equal(emptyObserved.status, 'absent')
  const replace = await host.exec(
    'python3',
    [
      '-c',
      'import os,sys\np=sys.argv[1]\nos.rename(p,p+"-old")\nos.mkdir(p,0o755)',
      empty.path,
    ],
    { signal, maxBuffer: 4096 },
  )
  assert.equal(replace.code, 0)
  await assert.rejects(
    port.stage(
      empty,
      '.agents/skills/.wrong-root',
      initial.tree,
      initial.bytes,
      inspectionLocation(emptyObserved),
      signal,
    ),
    { reason: 'refused' },
  )
  passed.push('absent target refuses replacement of the observed workspace root')

  const observed = await port.inspect(root, target, initial.tree, signal)
  assert.equal(observed.status, 'absent')
  const replaceAncestor = await host.exec(
    'python3',
    [
      '-c',
      'import os,sys\np=sys.argv[1]\nos.rename(p,p+"-old")\nos.mkdir(p,0o755)',
      joinHostPath(root, '.agents/skills').path,
    ],
    { signal, maxBuffer: 4096 },
  )
  assert.equal(replaceAncestor.code, 0)
  await assert.rejects(
    port.stage(
      root,
      '.agents/skills/.wrong-parent',
      initial.tree,
      initial.bytes,
      inspectionLocation(observed),
      signal,
    ),
    { reason: 'refused' },
  )
  passed.push('absent target refuses replacement of an observed existing ancestor')
  for (const action of ['stage', 'commit', 'cleanup'] as const) {
    const workspace = joinHostPath(root, 'mutation-parent-' + action)
    await host.createDirectoryExclusive(workspace, { mode: 0o755, signal })
    const entry = '.agents/skills/.candidate'
    const absent = await port.inspect(workspace, entry, initial.tree, signal)
    assert(absent.status !== 'different')
    const candidate = await port.stage(
      workspace,
      entry,
      initial.tree,
      initial.bytes,
      inspectionLocation(absent),
      signal,
    )
    const before = await port.inspect(
      workspace,
      '.agents/skills/.next',
      initial.tree,
      signal,
    )
    assert(before.status !== 'different')
    const racedParent = new SshManagedDirectory(
      {
        hostId: host.hostId,
        execStream: (command, args, options) => {
          const prefix = `import os,sys\n_original_open=os.open\n_fired=False\ndef _swap_parent(path,flags,*a,**kw):\n global _fired\n if not _fired and path=='skills' and sys._getframe(1).f_code.co_name=='open_parent' and sys._getframe(2).f_code.co_name=='${action}':\n  _fired=True\n  parent=kw['dir_fd']\n  os.rename('skills','skills-retained',src_dir_fd=parent,dst_dir_fd=parent)\n  os.mkdir('skills',0o755,dir_fd=parent)\n  directory=_original_open('skills',os.O_RDONLY|os.O_DIRECTORY,dir_fd=parent)\n  try:\n   marker=_original_open('external-marker',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644,dir_fd=directory)\n   os.close(marker)\n  finally: os.close(directory)\n return _original_open(path,flags,*a,**kw)\nos.open=_swap_parent\n`
          return host.execStream(command, ['-c', prefix + args[1]!], options)
        },
      },
      () => {},
    )
    if (action === 'stage')
      await assert.rejects(
        racedParent.stage(
          workspace,
          '.agents/skills/.next',
          initial.tree,
          initial.bytes,
          inspectionLocation(before),
          signal,
        ),
      )
    else if (action === 'commit')
      assert.equal(
        (
          await racedParent.commit(
            { action: 'add', candidate, target: '.agents/skills/lib-fixture' },
            { signal, onSubmitted: () => {} },
          )
        ).status,
        'not-applied',
      )
    else assert.equal(await racedParent.cleanup(candidate, signal), false)
    assert.deepEqual(
      (await host.readdir(joinHostPath(workspace, '.agents/skills'))).map(
        (entry) => entry.name,
      ),
      ['external-marker'],
    )
    assert.equal(
      await host.readTextFile(
        joinHostPath(workspace, '.agents/skills-retained/.candidate/SKILL.md'),
      ),
      'First accepted source\n',
    )
    passed.push(
      action +
        ' binds the actual mutation parent before effects after an immediate ancestor replacement',
    )
  }
  const partialStage = new SshManagedDirectory(
    {
      hostId: host.hostId,
      execStream: (command, args, options) =>
        host.execStream(
          command,
          [
            '-c',
            `import os\n_write=os.write\n_writes=0\ndef _partial(fd,data):\n global _writes\n _writes+=1\n if _writes==2: raise OSError('injected stage failure')\n return _write(fd,data)\nos.write=_partial\n` +
              args[1]!,
          ],
          options,
        ),
    },
    () => {},
  )
  await assert.rejects(
    partialStage.stage(
      root,
      '.agents/skills/.partial-stage',
      initial.tree,
      initial.bytes,
      await location('.agents/skills/.partial-stage', initial.tree),
      signal,
    ),
    { reason: 'uncertain' },
  )
  assert.equal(
    await host.readTextFile(joinHostPath(root, '.agents/skills/.partial-stage/SKILL.md')),
    'First accepted source\n',
  )
  passed.push('partial stage failure retains unknown candidate and reports uncertainty')
  const leafCandidate = await port.stage(
    root,
    '.agents/skills/.leaf-race',
    initial.tree,
    initial.bytes,
    await location('.agents/skills/.leaf-race', initial.tree),
    signal,
  )
  assert.equal(await raced('cleanup-replacement').cleanup(leafCandidate, signal), false)
  assert.equal(
    await host.readTextFile(joinHostPath(root, '.agents/skills/.leaf-race/SKILL.md')),
    'Concurrent human edit\n',
  )
  assert.equal(
    await host.readTextFile(
      joinHostPath(root, '.agents/skills/.leaf-race/retained-original'),
    ),
    'First accepted source\n',
  )
  passed.push(
    'cleanup retains a replaced public leaf between verification and private ownership',
  )
  passed.push(...(await managedDirectoryUnavailableCases(host, root)))
  return passed
}
