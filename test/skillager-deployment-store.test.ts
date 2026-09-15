import { expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { SkillagerDeploymentStore } from '../src/main/skillager/skillager-deployment-store'
import {
  deploymentKey,
  parseDeploymentFile,
  deploymentRecordBytes,
  deploymentTree,
  type SkillagerDeployment,
} from '../src/main/skillager/skillager-deployment-record'
import { deploymentFixture, preparedTarget } from './skillager-deployment-fixture'

function fixture(initial?: string) {
  let content = initial
  const writeFile = vi.fn(async (_path: unknown, next: Uint8Array | string) => {
    await Promise.resolve()
    content = String(next)
  })
  const host = {
    hostId: localPath('/').hostId,
    readTextFilePrefix: vi.fn(async () => {
      await Promise.resolve()
      if (content === undefined) throw Object.assign(Error('missing'), { code: 'ENOENT' })
      return {
        content,
        complete: true,
        byteLength: Buffer.byteLength(content),
        lineCount: content.split('\n').length,
      }
    }),
    writeFile,
  }
  return {
    host,
    store: new SkillagerDeploymentStore(host, localPath('/state/deployments.json')),
    content: () => content,
  }
}
it('keeps record bytes and transport trees stable across object ordering and reload', async () => {
  const incoming: SkillagerDeployment = {
    ...deploymentFixture,
    payload: {
      files: [
        ...deploymentFixture.payload.files,
        { ...deploymentFixture.payload.files[0]!, entry: 'helper.sh', mode: 0o755 },
      ],
    },
  }
  const reordered: SkillagerDeployment = {
    ...(Object.fromEntries(Object.entries(incoming).reverse()) as SkillagerDeployment),
    library: {
      skillsRoot: Object.assign(
        { path: incoming.library.skillsRoot.path },
        incoming.library.skillsRoot,
      ),
      root: Object.assign({ path: incoming.library.root.path }, incoming.library.root),
      id: incoming.library.id,
    },
    destination: {
      root: Object.assign(
        { path: incoming.destination.root.path },
        incoming.destination.root,
      ),
      workspaceId: incoming.destination.workspaceId,
      projectId: incoming.destination.projectId,
    },
    payload: {
      files: incoming.payload.files
        .toReversed()
        .map(({ entry, mode, size, sha256 }) => ({ sha256, size, mode, entry })),
    },
  }
  expect(deploymentRecordBytes(reordered)).toEqual(deploymentRecordBytes(incoming))
  expect(deploymentTree(reordered)).toEqual(deploymentTree(incoming))
  const { store, host } = fixture(),
    target = preparedTarget()
  await store.save(deploymentKey(target.identity), 0, {
    ...target,
    intent: { ...target.intent!, incoming: reordered },
  })
  const reopened = new SkillagerDeploymentStore(
    host,
    localPath('/state/deployments.json'),
  )
  const restored = (await reopened.read())[0]!.intent!.incoming!
  expect(deploymentRecordBytes(restored)).toEqual(deploymentRecordBytes(incoming))
  expect(deploymentTree(restored)).toEqual(deploymentTree(incoming))
})
it('persists exact local intent and reloads it without adopting remote metadata', async () => {
  const { store, host, content } = fixture()
  expect(await store.read()).toEqual([])
  const target = preparedTarget(),
    key = deploymentKey(target.identity)
  const saved = await store.save(key, 0, target)
  expect(saved?.intent?.state).toBe('prepared')
  expect(parseDeploymentFile(JSON.parse(content()!))).toEqual([saved])
  const reopened = new SkillagerDeploymentStore(
    host,
    localPath('/state/deployments.json'),
  )
  expect(await reopened.read()).toEqual([saved])
  expect(deploymentTree(deploymentFixture).files.at(-1)?.entry).toBe(
    '.hvir-skillager.json',
  )
  expect(Buffer.from(deploymentRecordBytes(deploymentFixture)).toString()).toContain(
    'hvir.skillager-deployment.v1',
  )
  await expect(store.save(key, 0, target)).rejects.toMatchObject({
    reason: 'stale-review',
  })
  await store.save(key, 1, undefined)
  expect(await store.read()).toEqual([])
})
it.each([
  'invalid json',
  JSON.stringify({ version: 99, targets: [] }),
  JSON.stringify({
    version: 1,
    targets: [
      {
        revision: 1,
        ...preparedTarget(),
        intent: {
          ...preparedTarget().intent,
          stageEntry: '.agents/skills/user-directory',
        },
      },
    ],
  }),
])('preserves unavailable records and blocks writes (%s)', async (initial) => {
  const { store, host, content } = fixture(initial)
  await expect(store.read()).rejects.toMatchObject({ reason: 'unavailable' })
  const target = preparedTarget()
  await expect(
    store.save(deploymentKey(target.identity), 0, target),
  ).rejects.toMatchObject({ reason: 'unavailable' })
  expect(host.writeFile).not.toHaveBeenCalled()
  expect(content()).toBe(initial)
})
it('admits one write without accumulating a queue and blocks after uncertain persistence', async () => {
  const { store, host } = fixture()
  await store.read()
  let reject: (reason: Error) => void = () => {}
  host.writeFile.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail
      }),
  )
  const target = preparedTarget(),
    key = deploymentKey(target.identity)
  const writing = store.save(key, 0, target)
  await vi.waitFor(() => expect(host.writeFile).toHaveBeenCalledOnce())
  await expect(store.save(key, 0, target)).rejects.toMatchObject({ reason: 'busy' })
  reject(Error('atomic write outcome unknown'))
  await expect(writing).rejects.toMatchObject({ reason: 'uncertain' })
  await expect(store.read()).rejects.toMatchObject({ reason: 'unavailable' })
})

it('publishes only delivery identity and fingerprints while local records retain qualified authority', async () => {
  const { store, content } = fixture(),
    target = preparedTarget()
  await store.save(deploymentKey(target.identity), 0, target)
  const raw = Buffer.from(deploymentRecordBytes(deploymentFixture)).toString()
  const published = JSON.parse(raw) as Record<string, unknown>
  expect(Object.keys(published)).toEqual([
    'schema',
    'id',
    'library',
    'skillId',
    'sourceHash',
    'agent',
    'targetEntry',
    'exposureId',
    'payload',
  ])
  expect(published.library).toEqual({ id: deploymentFixture.library.id })
  expect(raw).not.toContain(deploymentFixture.library.root.path)
  expect(published).not.toHaveProperty('destination')
  const retained = parseDeploymentFile(JSON.parse(content()!))[0]!.intent!.incoming!
  expect(retained.library).toEqual(deploymentFixture.library)
  expect(retained.destination).toEqual(deploymentFixture.destination)
})
it('requires an app restart after restoring unavailable local records and retains the protective latch', async () => {
  const { store, host } = fixture('broken')
  await expect(store.read()).rejects.toThrow('restart hvir')
  host.readTextFilePrefix.mockResolvedValue({
    content: '{"version":1,"targets":[]}',
    complete: true,
    byteLength: 26,
    lineCount: 1,
  })
  await expect(store.read()).rejects.toThrow('restart hvir')
  expect(host.readTextFilePrefix).toHaveBeenCalledOnce()
  const restarted = new SkillagerDeploymentStore(
    host,
    localPath('/state/deployments.json'),
  )
  expect(await restarted.read()).toEqual([])
})
