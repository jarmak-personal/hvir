import {
  basenameHostPath,
  dirnameHostPath,
  joinHostPath,
  hostPathEquals,
  type HostPath,
} from '../../shared'
import { LocalHost } from '../project-host'
import type { SmokeCleanup } from './cleanup'
export function createProjectFileFixture(smokeRoot: HostPath, cleanup: SmokeCleanup) {
  const smokeTrashRecoveryRoot = joinHostPath(
    dirnameHostPath(smokeRoot),
    `.hvir-smoke-trash-recovery-${process.pid}-${basenameHostPath(smokeRoot)}`,
  )
  let smokeTrashSequence = 0
  let smokeTrashFailurePath: HostPath | undefined
  const smokeRecoveredPaths = new Set<HostPath>()
  const host = new LocalHost({
    trashItem: async (path) => {
      if (smokeTrashFailurePath && hostPathEquals(path, smokeTrashFailurePath)) {
        throw new Error('Injected recoverable Trash failure')
      }
      const recovered = joinHostPath(
        smokeTrashRecoveryRoot,
        `${(smokeTrashSequence += 1)}-${basenameHostPath(path)}`,
      )
      await host.fileTransfer.renameNoReplace(path, recovered)
      smokeRecoveredPaths.add(recovered)
    },
  })
  cleanup.defer('local host', () => host.dispose())
  cleanup.defer('recoverable deletion fixture', async () => {
    for (const recovered of smokeRecoveredPaths) {
      await host.exec('rm', ['-rf', '--', recovered.path])
    }
    await host.fileTransfer.removeDirectory(smokeTrashRecoveryRoot, {
      ignoreMissing: true,
    })
  })
  const createdPointerPath = joinHostPath(smokeRoot, '.hvir-smoke-created-pointer.txt')
  const renamedPointerPath = joinHostPath(smokeRoot, '.hvir-smoke-renamed-pointer.txt')
  const createdKeyboardPath = joinHostPath(smokeRoot, '.hvir-smoke-created-keyboard')
  const organizationTargetPath = joinHostPath(
    smokeRoot,
    '.hvir-smoke-organization-target',
  )
  const createdSnapshotPath = joinHostPath(smokeRoot, '.hvir-smoke-created-snapshot.txt')
  cleanup.defer('created pointer fixture', () =>
    host
      .exec('rm', ['-f', '--', createdPointerPath.path, renamedPointerPath.path])
      .then(() => undefined),
  )
  cleanup.defer('created keyboard fixture', () =>
    host
      .exec('rm', ['-rf', '--', createdKeyboardPath.path, organizationTargetPath.path])
      .then(() => undefined),
  )
  cleanup.defer('created snapshot fixture', () =>
    host.exec('rm', ['-f', '--', createdSnapshotPath.path]).then(() => undefined),
  )

  return {
    host,
    smokeTrashRecoveryRoot,
    failTrashFor: (path?: HostPath) => {
      smokeTrashFailurePath = path
    },
    prepare: async () => {
      await host.exec('rm', [
        '-f',
        '--',
        createdPointerPath.path,
        renamedPointerPath.path,
        createdSnapshotPath.path,
      ])
      await host.createDirectoryExclusive(smokeTrashRecoveryRoot, { mode: 0o755 })
      await host.exec('rm', [
        '-rf',
        '--',
        createdKeyboardPath.path,
        organizationTargetPath.path,
      ])
    },
  }
}
