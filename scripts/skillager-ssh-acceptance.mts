import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  hostPathEquals,
  joinHostPath,
  localPath,
  type HostPath,
} from '../src/shared/host-path'
import type { SkillagerAgent } from '../src/shared/skillager'
import type { SkillagerExposureRequest } from '../src/shared/skillager-exposure'
import type { ExecOptions, ProjectHost } from '../src/main/project-host/project-host'
import { LocalHost } from '../src/main/project-host/local-host'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { SkillagerDeploymentStore } from '../src/main/skillager/skillager-deployment-store'
import { SkillagerRemoteExposures } from '../src/main/skillager/skillager-remote-exposures'
import { skillagerFixtureEnvironment } from '../src/main/smoke/skillager-fixture-environment'
import { managedDirectoryMechanicsCases } from '../test/managed-directory-mechanics-cases'

/** Explicit, disposable real-host scenario; no ambient CLI installation or remote library. */
export async function runSkillagerSshAcceptance(
  remote: ProjectHost,
  ownedRoot: HostPath,
  executable: string,
): Promise<void> {
  assert(isAbsolute(executable), 'Supply an explicit local Skillager executable')
  const signal = AbortSignal.timeout(180_000)
  const mechanics = joinHostPath(ownedRoot, 'managed-mechanics')
  await remote.createDirectoryExclusive(mechanics, { mode: 0o755, signal })
  const passed = [...(await managedDirectoryMechanicsCases(remote, mechanics))]
  const destination = {
    projectId: 'acceptance-project',
    workspaceId: 'acceptance-workspace',
    root: joinHostPath(ownedRoot, 'skillager-workspace'),
  }
  await remote.createDirectoryExclusive(destination.root, { mode: 0o755, signal })
  const bootstrap = new LocalHost()
  const allocated = localPath(join(tmpdir(), 'hvir-skillager-ssh-' + randomUUID()))
  assert.equal(
    (
      await bootstrap.exec('mkdir', ['-m', '700', '--', allocated.path], {
        signal,
        maxBuffer: 4096,
      })
    ).code,
    0,
  )
  const root = (await bootstrap.realpath(allocated)).path
  await bootstrap.dispose()
  const library = join(root, 'library'),
    catalog = join(root, 'catalog'),
    scratch = join(root, 'scratch')
  const { env, unsetEnv } = skillagerFixtureEnvironment(localPath(root), process.env)
  class SourceHost extends LocalHost {
    override defaultShell() {
      return Promise.resolve('/bin/sh')
    }
    override exec(command: string, args: readonly string[], options: ExecOptions = {}) {
      return super.exec(command, args, {
        ...options,
        unsetEnv,
        env: { ...env, ...options.env },
      })
    }
  }
  const local = new SourceHost(),
    cli = new SkillagerCli(local, localPath(scratch))
  const store = new SkillagerDeploymentStore(
    local,
    localPath(join(root, 'deployments.json')),
  )
  const adapter = new SkillagerRemoteExposures(cli, store, (at) =>
    hostPathEquals(at, destination.root) ? remote : undefined,
  )
  const run = async (args: readonly string[]) => {
    const result = await local.exec(
      executable,
      ['--catalog-state-dir', catalog, '--state-dir', catalog, ...args],
      { cwd: localPath(root), signal, maxBuffer: 4 * 1024 * 1024 },
    )
    assert.equal(result.code, 0, 'Local Skillager fixture command failed')
  }
  try {
    await Promise.all(
      [scratch, join(root, 'home')].map((path) =>
        local.createDirectoryExclusive(localPath(path), { mode: 0o755, signal }),
      ),
    )
    await run(['library', 'init', '--path', library, '--json'])
    await run(['library', 'new', 'café', '--json'])
    const skill = join(library, 'skills/café')
    await local.writeFile(
      localPath(join(skill, 'SKILL.md')),
      '---\nname: café\ndescription: Explain bundled fixture references.\n---\n# Café\n\nRead the supporting references.\n',
    )
    await local.createDirectoryExclusive(localPath(join(skill, 'references')), {
      mode: 0o755,
      signal,
    })
    const binary = Buffer.alloc(1024 * 1024 + 19, 0xfe)
    await local.writeFile(localPath(join(skill, 'references/bytes.bin')), binary)
    await local.writeFile(
      localPath(join(skill, 'helper.sh')),
      '#!/bin/sh\nprintf "fixture\\n"\n',
    )
    assert.equal(
      (
        await local.exec('chmod', ['755', join(skill, 'helper.sh')], {
          signal,
          maxBuffer: 4096,
        })
      ).code,
      0,
    )
    const selection = await cli.probe(localPath(executable), signal)
    const initial = await cli.review(selection, 'lib/café', signal)
    await cli.accept(selection, initial, signal)
    const oldHash = initial.detail.hash
    await initial.dispose()
    const request = (agent: SkillagerAgent): SkillagerExposureRequest => ({
      connectionId: 'acceptance',
      requestId: 1,
      workspaceRoot: destination.root,
      destination,
      agent,
      action: 'add',
      skillId: 'lib/café',
      mode: 'native',
    })
    const observe = async (agent: SkillagerAgent) =>
      adapter.observe(
        selection,
        request(agent),
        { rows: await cli.inventory(selection, signal), complete: true },
        signal,
      )
    for (const agent of ['codex', 'claude'] as const) {
      const preview = await adapter.previewExposure(selection, request(agent), signal)
      assert.equal(preview.detail.sourceHash, oldHash)
      assert(
        preview.detail.effects.some((effect) => effect.path === '.hvir-skillager.json'),
      )
      const result = await adapter.applyExposure(selection, preview, signal)
      await preview.dispose!()
      assert.equal(result.status, 'exposed')
      assert.deepEqual(
        await remote.readFile(joinHostPath(result.target, 'references/bytes.bin')),
        binary,
      )
      assert.equal(
        (await remote.stat(joinHostPath(result.target, 'helper.sh'))).mode & 0o777,
        0o755,
      )
      assert.equal((await observe(agent))?.[0]?.status, 'current')
    }
    passed.push(
      'released native Full delivery for both agents, exact 1MiB binary/executable and hvir record',
    )
    await local.writeFile(
      localPath(join(skill, 'references/bytes.bin')),
      Buffer.from('Reviewed next version\n'),
    )
    const reviewed = await cli.review(selection, 'lib/café', signal)
    await cli.accept(selection, reviewed, signal)
    const diff = await cli.diff(selection, reviewed, oldHash, signal)
    assert.equal(diff.fromHash, oldHash)
    assert.equal(diff.toHash, reviewed.detail.hash)
    const exposure = (await observe('codex'))![0]!
    assert.equal(exposure.status, 'source_update')
    const update = await adapter.previewExposure(
      selection,
      { ...request('codex'), action: 'update', exposure },
      signal,
    )
    assert.equal(await adapter.updateSourceHash(selection, update, signal), oldHash)
    assert.equal(update.detail.sourceHash, reviewed.detail.hash)
    await adapter.applyExposure(selection, update, signal)
    await update.dispose!()
    await reviewed.dispose()
    assert.equal((await observe('codex'))![0]!.status, 'current')
    assert.equal((await observe('claude'))![0]!.status, 'source_update')
    passed.push(
      'exact historical source diff and one-target Full update; other agent retained',
    )
    const codex = (await observe('codex'))![0]!
    await remote.writeFile(joinHostPath(codex.target, 'human.txt'), 'Retain user file\n')
    await assert.rejects(
      adapter.previewExposure(
        selection,
        { ...request('codex'), action: 'remove', exposure: codex },
        signal,
      ),
    )
    assert.equal(
      await remote.readTextFile(joinHostPath(codex.target, 'human.txt')),
      'Retain user file\n',
    )
    passed.push('modified managed target retained')
    const claude = (await observe('claude'))![0]!
    const remove = await adapter.previewExposure(
      selection,
      { ...request('claude'), action: 'remove', exposure: claude },
      signal,
    )
    assert.equal(
      (await adapter.applyExposure(selection, remove, signal)).status,
      'removed',
    )
    await remove.dispose!()
    assert.equal((await observe('claude'))?.length, 0)
    passed.push('verified unchanged managed removal')
    console.log(`[real-host:ssh] Skillager checks ${JSON.stringify(passed)}`)
  } finally {
    await adapter.dispose()
    await store.dispose()
    await cli.dispose()
    try {
      assert.equal(
        (
          await local.exec('rm', ['-rf', '--', root], {
            signal: AbortSignal.timeout(10_000),
            maxBuffer: 4096,
          })
        ).code,
        0,
      )
    } finally {
      await local.dispose()
    }
  }
}
