import { describe, expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import {
  parseAcceptancePreview,
  parseReviewAccepted,
  parseReviewDiff,
  verifySnapshotLibrary,
  verifySnapshotPreview,
} from '../src/main/skillager/skillager-review-contract'

const hash = 'a'.repeat(64),
  root = localPath('/library/skills/example')
const preview = () => ({
  schema: 'skillager.library-accept.v1',
  status: 'preview',
  skill: { id: 'lib/example', path: root.path, working_hash: hash, trust: 'discovered' },
  lint: { status: 'ok', findings: [] },
  scan: { risk: 'low', findings: [] },
  git: { conflicts: [], operation: null },
  requires_override: false,
  next_command_argv: [
    'skillager',
    'library',
    'accept',
    'lib/example',
    '--json',
    '--yes',
    '--confirmation-token',
    'token',
  ],
})

describe('review contracts retain CLI authority', () => {
  it('permits exact acceptance and discloses refusal without supplying an override', () => {
    expect(parseAcceptancePreview(preview(), 'lib/example', root)).toMatchObject({
      hash,
      canAccept: true,
      confirmationToken: 'token',
    })
    const blocked = {
      ...preview(),
      requires_override: true,
      next_command_argv: undefined,
    }
    expect(parseAcceptancePreview(blocked, 'lib/example', root)).toMatchObject({
      canAccept: false,
      confirmationToken: undefined,
    })
  })
  it('rejects redirected canonical paths and injected token commands', () => {
    expect(() =>
      parseAcceptancePreview(
        {
          ...preview(),
          skill: { ...preview().skill, path: '/library/skills/example-other' },
        },
        'lib/example',
        root,
      ),
    ).toThrow()
    expect(() =>
      parseAcceptancePreview(
        {
          ...preview(),
          next_command_argv: [...preview().next_command_argv, '--override-lint'],
        },
        'lib/example',
        root,
      ),
    ).toThrow()
  })
  it('requires a fresh empty private library without Git or approval effects', () => {
    const snapshot = {
      schema: 'skillager.library-init.v1',
      status: 'initialized',
      created: true,
      git_repository_created: false,
      commit: null,
      indexed: 0,
      errors: [],
      git: { mode: 'disabled' },
      history: { available: false },
      library: {
        namespace: 'lib',
        registration: 'valid',
        root: '/snapshot',
        skills_path: '/snapshot/skills',
      },
    }
    expect(() => verifySnapshotLibrary(snapshot, localPath('/snapshot'))).not.toThrow()
    expect(() => verifySnapshotLibrary(snapshot, localPath('/other'))).toThrow()
    expect(() =>
      verifySnapshotLibrary(
        { ...snapshot, git_repository_created: true },
        localPath('/snapshot'),
      ),
    ).toThrow()
    expect(() =>
      verifySnapshotLibrary({ ...snapshot, indexed: 1 }, localPath('/snapshot')),
    ).toThrow()
  })
  it('requires a pending canonical snapshot preview matching the original CLI hash', () => {
    const snapshot = { ...preview(), git: { ...preview().git, mode: 'disabled' } }
    expect(() => verifySnapshotPreview(snapshot, 'lib/example', root, hash)).not.toThrow()
    expect(() =>
      verifySnapshotPreview(snapshot, 'lib/example', root, 'b'.repeat(64)),
    ).toThrow('differs')
    expect(() =>
      verifySnapshotPreview(
        { ...snapshot, skill: { ...snapshot.skill, trust: 'reviewed' } },
        'lib/example',
        root,
        hash,
      ),
    ).toThrow()
    expect(() =>
      verifySnapshotPreview({ ...snapshot, approval: {} }, 'lib/example', root, hash),
    ).toThrow()
  })
  it('rejects a newer diff endpoint and an unrelated accepted result', () => {
    const diff = {
      schema: 'skillager.library-diff.v1',
      status: 'ready',
      content_bearing: true,
      skill: preview().skill,
      from: { content_hash: null },
      to: { content_hash: 'b'.repeat(64) },
      diff: '+ new content',
    }
    expect(() => parseReviewDiff(diff, 'lib/example', root, hash)).toThrow('changed')
    expect(() =>
      parseReviewAccepted(
        {
          schema: 'skillager.library-accept.v1',
          status: 'accepted',
          skill: preview().skill,
          approval: { state: 'reviewed', content_hash: 'b'.repeat(64) },
        },
        'lib/example',
        root,
        hash,
      ),
    ).toThrow()
  })
})
