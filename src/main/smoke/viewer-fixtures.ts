import { joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { SmokeCleanup } from './cleanup'

/** Files read through the real viewer/worker/watch seams; each acquisition owns cleanup. */
export async function createViewerFixtures(
  host: ProjectHost,
  smokeRoot: HostPath,
  cleanup: SmokeCleanup,
  mode: string,
) {
  const liveReloadPath = joinHostPath(smokeRoot, '.hvir-smoke-live.txt')
  const viewerPositionPath = joinHostPath(smokeRoot, '.hvir-smoke-position.md')
  const largeJsonPath = joinHostPath(smokeRoot, '.hvir-smoke-large.json')
  const largeTextPath = joinHostPath(smokeRoot, '.hvir-smoke-large.txt')
  const oversizedDiffPath = joinHostPath(smokeRoot, '.hvir-smoke-oversized-diff.txt')
  cleanup.defer('large text fixture', () =>
    host.exec('rm', ['-f', '--', largeTextPath.path]).then(() => undefined),
  )
  cleanup.defer('large JSON fixture', () =>
    host.exec('rm', ['-f', '--', largeJsonPath.path]).then(() => undefined),
  )
  cleanup.defer('live reload fixture', () =>
    host.exec('rm', ['-f', '--', liveReloadPath.path]).then(() => undefined),
  )
  cleanup.defer('viewer position fixture', () =>
    host.exec('rm', ['-f', '--', viewerPositionPath.path]).then(() => undefined),
  )
  cleanup.defer('oversized diff fixture', () =>
    host.exec('rm', ['-f', '--', oversizedDiffPath.path]).then(() => undefined),
  )
  const liveReloadBefore = `${Array.from({ length: 240 }, (_, index) => `line ${index}`).join('\n')}\n`
  await host.writeFile(liveReloadPath, liveReloadBefore)
  if (mode === 'viewer-position') {
    await host.writeFile(
      viewerPositionPath,
      Array.from(
        { length: 80 },
        (_, index) => `## Position ${index + 1}\n\nParagraph ${index + 1}\n`,
      ).join('\n'),
    )
  }
  if (mode === 'viewer-content') {
    await host.writeFile(
      largeJsonPath,
      JSON.stringify(
        Array.from({ length: 50_000 }, (_, index) => ({
          id: index,
          value: `item-${index}`,
        })),
      ),
    )
  }
  if (mode === 'viewer-position' || mode === 'viewer-content') {
    await host.writeFile(
      largeTextPath,
      `${'large file responsiveness fixture 0123456789\n'.repeat(135_000)}end\n`,
    )
  }
  if (mode === 'terminal-presentation') {
    await host.writeFile(
      oversizedDiffPath,
      `${'oversized diff fixture '.padEnd(255, 'x')}\n`.repeat(8_200),
    )
  }

  return {
    liveReloadPath,
    liveReloadBefore,
    viewerPositionPath,
    largeJsonPath,
    largeTextPath,
  }
}
