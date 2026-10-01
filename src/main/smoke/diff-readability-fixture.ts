import { joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { SmokeCleanup } from './cleanup'

/** Synthetic, complete text with distant edits and a long line in each supported format. */
export const diffReadabilitySamples = [
  {
    name: '.hvir-smoke-diff.ts',
    language: 'typescript',
    base: [
      'export const enabled = true',
      'export const limit = 12',
      ...Array.from({ length: 24 }, (_, index) => `// unchanged context ${index + 1}`),
      "  \texport const description = 'Keep café e\u0301 漢字 🚀 \t the complete original line available when the viewer shares space with a terminal and both sides have limited room.'  \t",
      'export const legacy = true',
      '',
    ].join('\n'),
    replacements: [
      ['limit = 12', 'limit = 24'],
      ['original line available', 'original line readable'],
      [
        'export const legacy = true\n',
        'export const syntax = true\nexport const wrap = true\n',
      ],
    ],
  },
  {
    name: '.hvir-smoke-diff.json',
    language: 'json',
    base: [
      '{',
      '  "enabled": true,',
      '  "limit": 12,',
      ...Array.from(
        { length: 24 },
        (_, index) => `  "context${index + 1}": "unchanged",`,
      ),
      '  "description": "Keep café e\u0301 漢字 🚀 \\t the complete original line available when the viewer shares space with a terminal and both sides have limited room.",',
      '  "legacy": true',
      '}',
      '',
    ].join('\n'),
    replacements: [
      ['"limit": 12', '"limit": 24'],
      ['original line available', 'original line readable'],
      ['"legacy": true', '"syntax": true,\n  "wrap": true'],
    ],
  },
  {
    name: '.hvir-smoke-diff.md',
    language: 'markdown',
    base: [
      '# Reviewing changes',
      '',
      'The limit is 12 lines.',
      ...Array.from(
        { length: 24 },
        (_, index) => `Unchanged context paragraph ${index + 1}.`,
      ),
      'Keep café e\u0301 漢字 🚀 \t the complete original line available when the viewer shares space with a terminal and both sides have limited room.',
      'Legacy controls are available.',
      '',
    ].join('\n'),
    replacements: [
      ['limit is 12', 'limit is 24'],
      ['original line available', 'original line readable'],
      [
        'Legacy controls are available.',
        'Syntax colors are available.\nLong lines can wrap.',
      ],
    ],
  },
] as const

export async function createDiffReadabilityFixtures(
  host: Pick<ProjectHost, 'exec' | 'writeFile'>,
  root: HostPath,
  cleanup: SmokeCleanup,
) {
  const fixtures = []
  for (const sample of diffReadabilitySamples) {
    const path = joinHostPath(root, sample.name)
    cleanup.defer(`diff readability file ${sample.language}`, async () => {
      const removal = await host.exec('git', [
        '-C',
        root.path,
        'update-index',
        '--force-remove',
        '--',
        sample.name,
      ])
      if (removal.code !== 0) throw new Error('Diff readability index cleanup failed')
      const file = await host.exec('rm', ['-f', '--', path.path])
      if (file.code !== 0) throw new Error('Diff readability file cleanup failed')
    })
    await host.writeFile(path, sample.base)
    const staged = await host.exec('git', ['-C', root.path, 'add', '--', sample.name])
    if (staged.code !== 0) throw new Error('Diff readability fixture indexing failed')
    const current = sample.replacements.reduce<string>(
      (content, [before, after]) => content.replace(before, after),
      sample.base,
    )
    await host.writeFile(path, current)
    fixtures.push({ path, language: sample.language, base: sample.base, current })
  }
  return fixtures
}
