import { promises as fs } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { deliveryFixture } from './fixtures/extension-delivery'
import { requestGuestDelivery } from '../src/main/extensions/guest-delivery'
import { ExtensionSourceReadingOwner } from '../src/main/extensions/source-reading'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import type { ExtensionInvocation } from '../src/shared/extensions/contract'
const fixtures: Awaited<ReturnType<typeof deliveryFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.dispose()
})
async function fixture() {
  const f = await deliveryFixture()
  fixtures.push(f)
  const manifest = validateExtensionManifest(
    JSON.parse(
      await fs.readFile('packages/skillager-extension/hvir-extension.json', 'utf8'),
    ),
  ).manifest
  return { f, manifest }
}
it('permits ordinary human delivery without D7 body reading and refuses updater/unapproved mutation', async () => {
  const { f, manifest } = await fixture(),
    plan = await f.preview('add'),
    reading = new ExtensionSourceReadingOwner(f.approvals)
  try {
    await expect(
      reading.select(
        { ...f.caller, allowed: true, context: () => f.caller.admitted },
        {
          source: 'delivery-source',
          path: { hostId: 'local', path: `${f.exports.path}/export-1/SKILL.md` },
        },
      ),
    ).rejects.toThrow(/Grant|read-only/)
    await expect(
      requestGuestDelivery(
        'delivery.apply',
        plan,
        f.caller,
        f.owner,
        f.caller.admitted,
        f.caller.authorize,
        false,
        manifest,
      ),
    ).rejects.toThrow(/admitted/)
    expect(f.remote.createDirectoryExclusive).not.toHaveBeenCalled()
    expect(
      await requestGuestDelivery(
        'delivery.apply',
        plan,
        f.caller,
        f.owner,
        f.caller.admitted,
        f.caller.authorize,
        true,
        manifest,
      ),
    ).toMatchObject({ outcome: 'completed' })
  } finally {
    reading.dispose()
  }
})
it('consumes main-admitted standing and interactive action effects without trusting caller-supplied flags', async () => {
  const { f, manifest } = await fixture(),
    invocation = {
      id: 'action',
      action: 'add-copy',
      input: {},
      context: f.caller.admitted!.value,
      caller: 'agent',
      authorization: 'standing',
    } as ExtensionInvocation
  const added = (await requestGuestDelivery(
    'delivery.apply',
    await f.preview('add'),
    f.caller,
    f.owner,
    f.caller.admitted,
    f.caller.authorize,
    false,
    manifest,
    invocation,
  )) as { record: { id: string } }
  const update = await f.preview('update', f.owner, added.record.id, 'new')
  await expect(
    requestGuestDelivery(
      'delivery.apply',
      update,
      f.caller,
      f.owner,
      f.caller.admitted,
      f.caller.authorize,
      false,
      manifest,
      invocation,
    ),
  ).rejects.toThrow(/declare/)
  const allowed = {
      ...invocation,
      action: 'change-exposure',
      authorization: 'interactive' as const,
    },
    newPlan = await f.preview('update', f.owner, added.record.id, 'new')
  expect(
    await requestGuestDelivery(
      'delivery.apply',
      newPlan,
      f.caller,
      f.owner,
      f.caller.admitted,
      f.caller.authorize,
      false,
      manifest,
      allowed,
    ),
  ).toMatchObject({ outcome: 'completed' })
  expect(
    await requestGuestDelivery(
      'delivery.apply',
      await f.preview('remove', f.owner, added.record.id),
      f.caller,
      f.owner,
      f.caller.admitted,
      f.caller.authorize,
      false,
      manifest,
      { ...invocation, action: 'remove-copy', authorization: 'interactive' },
    ),
  ).toMatchObject({ outcome: 'completed' })
})
it('does not transfer forgotten installation authority or domain records to a fresh same-ID activation', async () => {
  const { f } = await fixture(),
    plan = await f.preview('add')
  f.failCompletion()
  await f.owner.apply(f.caller, plan)
  f.forget()
  const fresh = {
    ...f.activation,
    installationId: 'new-installation',
    generation: 'new-generation',
  }
  f.active.set(fresh.installationId, fresh)
  const caller = { ...f.caller, activation: fresh }
  expect(f.owner.status(caller, { offset: 0 })).toMatchObject({
    entries: [],
    nextOffset: null,
  })
  expect(await f.owner.domain(caller, {})).toMatchObject({ value: null })
  await expect(
    f.owner.reconcile(caller, {
      operation: plan.operation,
      destination: 'delivery-target',
    }),
  ).rejects.toThrow(/does not belong/)
  expect(f.owner.recoveryStatus().some((entry) => entry.id === plan.operation)).toBe(true)
})
