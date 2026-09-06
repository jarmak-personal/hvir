import { joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { SmokeCleanup } from './cleanup'
import { harnessProviders } from '../harness/harness-provider'

export function documentReviewSmokeProvider() {
  const provider = harnessProviders
    .all()
    .find((candidate) => candidate.documentReviewSendNow)
  if (!provider) throw new Error('No harness provider supports document review send-now')
  return provider
}
export async function createDocumentReviewFixture(
  host: ProjectHost,
  smokeRoot: HostPath,
  cleanup: SmokeCleanup,
  writeDocument: boolean,
) {
  const documentReviewFixturePath = joinHostPath(
    smokeRoot,
    '.hvir-smoke-document-review.md',
  )
  const documentReviewCaptureAPath = joinHostPath(
    smokeRoot,
    '.hvir-smoke-document-review-a.bin',
  )
  const documentReviewCaptureBPath = joinHostPath(
    smokeRoot,
    '.hvir-smoke-document-review-b.bin',
  )
  const documentReviewFixtureContents =
    '# Review fixture\n\nFirst paragraph for a rendered comment.\n\n' +
    'Second paragraph for keyboard navigation.\n\n' +
    'Third paragraph keeps the exact context unique.\n'
  cleanup.defer('document review workflow fixtures', () =>
    host
      .exec('rm', [
        '-f',
        '--',
        documentReviewFixturePath.path,
        documentReviewCaptureAPath.path,
        documentReviewCaptureBPath.path,
      ])
      .then(() => undefined),
  )
  if (writeDocument)
    await host.writeFile(documentReviewFixturePath, documentReviewFixtureContents)
  return {
    documentReviewFixturePath,
    documentReviewFixtureContents,
    documentReviewCaptureAPath,
    documentReviewCaptureBPath,
  }
}
