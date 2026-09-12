import { expect, it } from 'vitest'
import type {
  ManagedDirectoryInspection,
  ManagedDirectoryReceipt,
} from '../src/main/project-host/managed-directory'
import {
  deploymentTree,
  type SkillagerStoredTarget,
} from '../src/main/skillager/skillager-deployment-record'
import {
  assessDeployment,
  deploymentChecks,
  type DeploymentCheck,
} from '../src/main/skillager/skillager-deployment-reconciliation'
import { deploymentFixture, preparedTarget } from './skillager-deployment-fixture'

const oldReceipt: ManagedDirectoryReceipt = {
  root: deploymentFixture.destination.root,
  entry: deploymentFixture.targetEntry,
  tree: deploymentTree(deploymentFixture),
  device: '1',
  inode: '100',
  rootDevice: '1',
  rootInode: '50',
  ancestors: [
    { entry: '.agents', device: '1', inode: '10' },
    { entry: '.agents/skills', device: '1', inode: '11' },
  ],
}
function assess(
  target: SkillagerStoredTarget,
  observed: Partial<Record<DeploymentCheck['name'], ManagedDirectoryInspection>>,
) {
  const checks = deploymentChecks(target)
  return assessDeployment(
    target,
    checks,
    checks.map(
      (check) =>
        observed[check.name] ?? {
          status: 'absent',
          location: {
            root: oldReceipt.root,
            rootDevice: oldReceipt.rootDevice,
            rootInode: oldReceipt.rootInode,
            ancestors: oldReceipt.ancestors,
            missingParents: [],
          },
        },
    ),
  )
}
const installed = { deployment: deploymentFixture, receipt: oldReceipt }
it('requires the local receipt identity as well as complete content equality', () => {
  const target = { revision: 1, identity: preparedTarget().identity, installed }
  expect(
    assess(target, { installed: { status: 'exact', receipt: oldReceipt } }),
  ).toMatchObject({ status: 'current' })
  expect(
    assess(target, {
      installed: { status: 'exact', receipt: { ...oldReceipt, inode: 'copied-record' } },
    }),
  ).toEqual({ status: 'modified' })
  expect(assess(target, { installed: { status: 'different' } })).toEqual({
    status: 'modified',
  })
  expect(assess(target, {})).toEqual({ status: 'absent' })
})
it('never promotes a prepared record from remote JSON or even an exact incoming tree', () => {
  const prepared = preparedTarget()
  const candidate = { ...oldReceipt, entry: prepared.intent!.stageEntry }
  expect(
    assess(
      { ...prepared, revision: 1 },
      {
        incoming: { status: 'exact', receipt: oldReceipt },
        candidate: { status: 'exact', receipt: candidate },
      },
    ),
  ).toEqual({ status: 'uncertain' })
  expect(assess({ ...prepared, revision: 1 }, {})).toMatchObject({
    status: 'absent',
    outcome: 'not-applied',
  })
})

it('retains interrupted intent when absences belong to a replaced workspace or ancestor', () => {
  const prepared = { ...preparedTarget(), revision: 1 }
  const checks = deploymentChecks(prepared)
  const location = prepared.intent!.location
  for (const replaced of [
    { ...location, rootInode: '999' },
    {
      ...location,
      ancestors: location.ancestors.map((part, i) =>
        i === 0 ? { ...part, inode: '999' } : part,
      ),
    },
  ]) {
    expect(
      assessDeployment(
        prepared,
        checks,
        checks.map(() => ({ status: 'absent', location: replaced })),
      ),
    ).toEqual({ status: 'uncertain' })
  }
})
it('reconciles a submitted Add only with its persisted candidate receipt', () => {
  const prepared = preparedTarget(),
    candidate = { ...oldReceipt, entry: prepared.intent!.stageEntry }
  const target = {
    ...prepared,
    revision: 2,
    intent: { ...prepared.intent!, state: 'submitted' as const, candidate },
  }
  expect(
    assess(target, { incoming: { status: 'exact', receipt: oldReceipt } }),
  ).toMatchObject({ status: 'current', outcome: 'completed', installed })
  expect(
    assess(target, {
      incoming: { status: 'exact', receipt: { ...oldReceipt, inode: 'other' } },
    }),
  ).toEqual({ status: 'uncertain' })
  expect(
    assess(target, { candidate: { status: 'exact', receipt: candidate } }),
  ).toMatchObject({ status: 'absent', outcome: 'not-applied', cleanup: candidate })
})
it('requires the exact displaced old tree when reconciling an Update', () => {
  const prepared = preparedTarget()
  const incoming = {
    ...deploymentFixture,
    id: '33333333-3333-3333-3333-333333333333',
    sourceHash: 'b'.repeat(64),
  }
  const published = { ...oldReceipt, inode: '200', tree: deploymentTree(incoming) }
  const candidate = { ...published, entry: prepared.intent!.stageEntry }
  const displaced = { ...oldReceipt, entry: prepared.intent!.stageEntry }
  const target = {
    ...prepared,
    revision: 2,
    installed,
    intent: {
      ...prepared.intent!,
      action: 'update' as const,
      state: 'submitted' as const,
      incoming,
      candidate,
      before: oldReceipt,
    },
  }
  expect(
    assess(target, {
      incoming: { status: 'exact', receipt: published },
      displaced: { status: 'exact', receipt: displaced },
    }),
  ).toMatchObject({ status: 'current', outcome: 'completed', cleanup: displaced })
  expect(
    assess(target, {
      incoming: { status: 'exact', receipt: published },
      displaced: { status: 'different' },
    }),
  ).toEqual({ status: 'uncertain' })
  expect(
    assess(target, {
      installed: { status: 'exact', receipt: oldReceipt },
      candidate: { status: 'exact', receipt: candidate },
    }),
  ).toMatchObject({ status: 'current', outcome: 'not-applied', cleanup: candidate })
})
it('retains uncertainty for interrupted cleanup until both exact cleanup locations are absent', () => {
  const prepared = preparedTarget(),
    cleanup = { ...oldReceipt, entry: prepared.intent!.stageEntry }
  const target = {
    ...prepared,
    revision: 3,
    installed,
    intent: { ...prepared.intent!, state: 'completed' as const, cleanup },
  }
  expect(
    assess(target, {
      installed: { status: 'exact', receipt: oldReceipt },
      cleanup: { status: 'exact', receipt: cleanup },
    }),
  ).toMatchObject({ status: 'current', outcome: 'completed', cleanup })
  expect(
    assess(target, {
      installed: { status: 'exact', receipt: oldReceipt },
      'cleanup-private': { status: 'different' },
    }),
  ).toEqual({ status: 'uncertain' })
  expect(
    assess(target, { installed: { status: 'exact', receipt: oldReceipt } }),
  ).toMatchObject({ status: 'current', outcome: 'completed' })
})
