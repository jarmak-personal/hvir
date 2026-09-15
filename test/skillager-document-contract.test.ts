import { expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { validateSkillagerDocumentBody } from '../src/main/skillager/skillager-document-contract'
const selected = {
  kind: 'library' as const,
  skillId: 'lib/example',
  libraryId: 'library',
  root: localPath('/library/skills/example'),
  path: localPath('/library/skills/example/SKILL.md'),
  expectedHash: 'a'.repeat(64),
}
const payload = (content: string) => ({
  skill: {
    id: selected.skillId,
    content_hash: selected.expectedHash,
    trust: 'reviewed',
    root: selected.root.path,
    entrypoint: selected.path.path,
    source: { library_id: selected.libraryId },
  },
  content,
})
it.each(['# Body\n', '# Body\r\n', '# Body\r', '\ufeff# Body\r\n'])(
  'compares public universal-newline text without changing the selected raw bytes: %j',
  (text) => {
    const bytes = Buffer.from(text)
    expect(() =>
      validateSkillagerDocumentBody(
        payload(text.replace(/\r\n?/g, '\n')),
        selected,
        bytes,
      ),
    ).not.toThrow()
    expect(bytes.equals(Buffer.from(text))).toBe(true)
  },
)
it('refuses a changed body, another selected version, trust, identity and invalid UTF-8', () => {
  const raw = payload('# Body\n'),
    bytes = Buffer.from(raw.content)
  for (const patch of [
    { content: '# Other\n' },
    { skill: { ...raw.skill, content_hash: 'b'.repeat(64) } },
    { skill: { ...raw.skill, trust: 'discovered' } },
    { skill: { ...raw.skill, id: 'lib/other' } },
    { skill: { ...raw.skill, root: '/other' } },
    { skill: { ...raw.skill, source: { library_id: 'other' } } },
  ])
    expect(() =>
      validateSkillagerDocumentBody({ ...raw, ...patch }, selected, bytes),
    ).toThrow('selected accepted search source changed')
  expect(() =>
    validateSkillagerDocumentBody(payload('�'), selected, Uint8Array.of(255)),
  ).toThrow()
})
