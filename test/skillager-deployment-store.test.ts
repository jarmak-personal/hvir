import { expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { SkillagerDeploymentStore } from '../src/main/skillager/skillager-deployment-store'
import {
  deploymentKey,
  parseDeploymentFile,
  deploymentRecordBytes,
  deploymentTree,
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
