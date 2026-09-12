import { joinHostPath } from '../../shared/host-path'
import type {
  SkillagerExposureEntry,
  SkillagerExposureRequest,
} from '../../shared/skillager-exposure'
import type { SkillagerExposureSnapshot } from './skillager-exposure-port'
import type { ManagedDirectoryTree } from '../project-host/managed-directory'
import { managedDirectoryLockEntry } from '../project-host/managed-directory-contract'
import {
  deploymentRecordBytes,
  deploymentTargetFingerprint,
  deploymentTree,
  SKILLAGER_DEPLOYMENT_RECORD,
  type SkillagerDeployment,
  type SkillagerStoredTarget,
} from './skillager-deployment-record'

/** Public effects contain no buffers, leases, executable declarations, or mutation authority. */
export function remoteExposurePreview(
  request: SkillagerExposureRequest,
  stored: SkillagerStoredTarget,
  declarations: readonly string[],
): SkillagerExposureSnapshot['detail'] {
  const intent = stored.intent!
  const before = entries(stored.installed?.receipt.tree, stored.installed?.deployment)
  const after = entries(
    intent.incoming ? deploymentTree(intent.incoming) : undefined,
    intent.incoming,
  )
  return {
    request,
    target: joinHostPath(request.destination.root, stored.identity.targetEntry),
    sourceHash: intent.incoming?.sourceHash,
    targetHash: intent.before ? deploymentTargetFingerprint(intent.before) : null,
    beforeMode: intent.before ? 0o755 : null,
    afterMode: request.action === 'remove' ? null : 0o755,
    effects: [...new Set([...before.keys(), ...after.keys()])].sort().map((path) => ({
      path,
      action: !before.has(path) ? 'create' : !after.has(path) ? 'remove' : 'replace',
      before: before.get(path) ?? null,
      after: after.get(path) ?? null,
    })),
    remote: {
      declarations,
      createdParents: intent.location.missingParents.map((entry) =>
        joinHostPath(request.destination.root, entry),
      ),
      temporaryPaths: [
        ...(request.action === 'remove'
          ? []
          : [intent.stageEntry, intent.stageEntry + '.cleanup']),
        ...(request.action === 'remove'
          ? [intent.quarantineEntry, intent.quarantineEntry + '.cleanup']
          : []),
      ].map((entry) => joinHostPath(request.destination.root, entry)),
      lock: joinHostPath(
        request.destination.root,
        managedDirectoryLockEntry(stored.identity.targetEntry),
      ),
    },
  }
}
function entries(
  tree: ManagedDirectoryTree | undefined,
  deployment: SkillagerDeployment | undefined,
): Map<string, SkillagerExposureEntry> {
  const result = new Map<string, SkillagerExposureEntry>()
  for (const file of tree?.files ?? []) {
    result.set(file.entry, {
      type: 'file',
      mode: file.mode,
      size: file.size,
      sha256: file.sha256,
      ...(file.entry === SKILLAGER_DEPLOYMENT_RECORD && deployment
        ? { metadata: Buffer.from(deploymentRecordBytes(deployment)).toString('utf8') }
        : {}),
    })
    const parts = file.entry.split('/')
    for (let i = 1; i < parts.length; i++)
      result.set(parts.slice(0, i).join('/'), { type: 'directory', mode: 0o755 })
  }
  return result
}
