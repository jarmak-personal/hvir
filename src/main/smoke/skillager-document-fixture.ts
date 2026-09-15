import type { SkillagerDocumentCliPort } from '../skillager/skillager-document-read'

/** Named delayed-CLI fixture bytes; actual LocalHost/SSH content has separate acceptance. */
export function skillagerDocumentFixture(): SkillagerDocumentCliPort {
  const bytes = new TextEncoder().encode(
    '# Current skill body\n\nRead this skill before choosing an action.\n',
  )
  return {
    documentAccess: (selection, _source, signal) =>
      Promise.resolve({
        root: selection.library!.skillsRoot,
        assertCurrent: () => signal.throwIfAborted(),
        host: {
          hostId: selection.library!.root.hostId,
          realpath: (path) => Promise.resolve(path),
          stat: () =>
            Promise.resolve({
              type: 'file',
              size: bytes.length,
              mode: 0o644,
              mtimeMs: 1,
            }),
          fileTransfer: {
            async *readFileChunks() {
              yield await Promise.resolve(bytes)
            },
            async *readFileChunksNoFollow() {
              yield await Promise.resolve(bytes)
            },
          },
        },
      }),
    validateDocument: (_selection, _source, _workspace, _bytes, signal) => {
      signal.throwIfAborted()
      return Promise.resolve()
    },
  }
}
