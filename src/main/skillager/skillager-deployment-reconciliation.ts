import type {
  ManagedDirectoryInspection,
  ManagedDirectoryReceipt,
  ManagedDirectoryTree,
} from '../project-host/managed-directory'
import { deploymentTree, type SkillagerStoredTarget } from './skillager-deployment-record'
import { inspectionLocation } from '../project-host/managed-directory-contract'

export interface DeploymentCheck {
  readonly name:
    'installed' | 'incoming' | 'candidate' | 'displaced' | 'cleanup' | 'cleanup-private'
  readonly entry: string
  readonly tree: ManagedDirectoryTree
}
export type DeploymentAssessment =
  | {
      readonly status: 'current' | 'absent'
      readonly installed?: SkillagerStoredTarget['installed']
      readonly outcome?: 'completed' | 'not-applied'
      readonly cleanup?: ManagedDirectoryReceipt
    }
  | { readonly status: 'modified' }
  | { readonly status: 'uncertain' }

/** The observer batches these exact known records; it never enumerates a remote catalog. */
export function deploymentChecks(
  target: SkillagerStoredTarget,
): readonly DeploymentCheck[] {
  const checks: DeploymentCheck[] = []
  const { installed, intent } = target
  if (installed)
    checks.push({
      name: 'installed',
      entry: target.identity.targetEntry,
      tree: installed.receipt.tree,
    })
  if (intent?.incoming) {
    const tree = deploymentTree(intent.incoming)
    checks.push(
      { name: 'incoming', entry: target.identity.targetEntry, tree },
      { name: 'candidate', entry: intent.stageEntry, tree },
    )
  }
  if (intent?.before)
    checks.push({
      name: 'displaced',
      entry: intent.action === 'remove' ? intent.quarantineEntry : intent.stageEntry,
      tree: intent.before.tree,
    })
  if (intent?.cleanup)
    checks.push(
      { name: 'cleanup', entry: intent.cleanup.entry, tree: intent.cleanup.tree },
      {
        name: 'cleanup-private',
        entry: intent.cleanup.entry + '.cleanup',
        tree: {
          files: intent.cleanup.tree.files.map((file) => ({
            ...file,
            entry: 'tree/' + file.entry,
          })),
        },
      },
    )
  // A completed removal still checks the exact absent target using its old tree.
  if (!installed && intent?.action === 'remove' && intent.before)
    checks.push({
      name: 'installed',
      entry: target.identity.targetEntry,
      tree: intent.before.tree,
    })
  return checks
}

export function assessDeployment(
  target: SkillagerStoredTarget,
  checks: readonly DeploymentCheck[],
  results: readonly ManagedDirectoryInspection[],
): DeploymentAssessment {
  if (checks.length !== results.length) return { status: 'uncertain' }
  const observed = new Map(checks.map((check, i) => [check.name, results[i]!]))
  const { installed, intent } = target
  const expectedLocation =
    intent?.location ??
    (installed
      ? inspectionLocation({ status: 'exact', receipt: installed.receipt })
      : undefined)
  if (
    !expectedLocation ||
    results.some(
      (result) =>
        result.status === 'absent' &&
        JSON.stringify(result.location) !== JSON.stringify(expectedLocation),
    )
  )
    return { status: 'uncertain' }
  const matches = (
    name: DeploymentCheck['name'],
    receipt: ManagedDirectoryReceipt | undefined,
  ) => {
    const actual = observed.get(name)
    return Boolean(
      receipt && actual?.status === 'exact' && sameDirectory(actual.receipt, receipt),
    )
  }
  const absent = (name: DeploymentCheck['name']) =>
    observed.get(name)?.status === 'absent'
  const unchanged = installed
    ? matches('installed', installed.receipt)
    : absent(intent?.incoming ? 'incoming' : 'installed')
  const current = (): Extract<
    DeploymentAssessment,
    { status: 'current' | 'absent' }
  > => ({ status: installed ? 'current' : 'absent', installed })
  if (!intent) {
    if (unchanged) return current()
    return absent('installed') ? { status: 'absent' } : { status: 'modified' }
  }
  if (intent.state === 'completed') {
    if (!unchanged) return { status: 'uncertain' }
    if (!intent.cleanup) return { ...current(), outcome: 'completed' }
    if (matches('cleanup', intent.cleanup))
      return { ...current(), outcome: 'completed', cleanup: intent.cleanup }
    if (absent('cleanup') && absent('cleanup-private'))
      return { ...current(), outcome: 'completed' }
    return { status: 'uncertain' }
  }
  if (['submitted', 'uncertain'].includes(intent.state)) {
    if (
      intent.action !== 'remove' &&
      intent.incoming &&
      matches('incoming', intent.candidate) &&
      (intent.action === 'add' || matches('displaced', intent.before))
    ) {
      const receipt = (
        observed.get('incoming') as Extract<
          ManagedDirectoryInspection,
          { status: 'exact' }
        >
      ).receipt
      const cleanup =
        intent.action === 'update'
          ? (
              observed.get('displaced') as Extract<
                ManagedDirectoryInspection,
                { status: 'exact' }
              >
            ).receipt
          : undefined
      return {
        status: 'current',
        installed: { deployment: intent.incoming, receipt },
        outcome: 'completed',
        cleanup,
      }
    }
    if (
      intent.action === 'remove' &&
      absent('installed') &&
      matches('displaced', intent.before)
    ) {
      return {
        status: 'absent',
        outcome: 'completed',
        cleanup: (
          observed.get('displaced') as Extract<
            ManagedDirectoryInspection,
            { status: 'exact' }
          >
        ).receipt,
      }
    }
  }
  if (unchanged) {
    if (intent.action === 'remove' && absent('displaced'))
      return { ...current(), outcome: 'not-applied' }
    if (intent.action !== 'remove') {
      if (matches('candidate', intent.candidate))
        return { ...current(), outcome: 'not-applied', cleanup: intent.candidate }
      if (intent.state === 'prepared' && !intent.candidate && absent('candidate'))
        return { ...current(), outcome: 'not-applied' }
    }
  }
  return { status: 'uncertain' }
}

/** Content equality alone cannot adopt a copied record or a replaced directory. */
function sameDirectory(
  actual: ManagedDirectoryReceipt,
  expected: ManagedDirectoryReceipt,
): boolean {
  return (
    actual.root.hostId === expected.root.hostId &&
    actual.root.path === expected.root.path &&
    actual.device === expected.device &&
    actual.inode === expected.inode &&
    actual.rootDevice === expected.rootDevice &&
    actual.rootInode === expected.rootInode &&
    JSON.stringify(actual.ancestors) === JSON.stringify(expected.ancestors) &&
    JSON.stringify(actual.tree) === JSON.stringify(expected.tree)
  )
}
