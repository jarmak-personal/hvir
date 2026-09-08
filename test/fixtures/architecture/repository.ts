import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  POLICY_PATH,
  SOURCE_EXTENSIONS,
  SOURCE_ROOTS,
  type ArchitecturePolicy,
  type ArchitectureBudget,
} from '../../../scripts/architecture-policy.mts'
import {
  authorizeCandidate,
  type ArchitectureContext,
  type ArchitectureIntegration,
} from '../../../scripts/architecture-authorization.mts'

export function ordinaryPolicy(): ArchitecturePolicy {
  return {
    version: 2,
    comfortLines: 500,
    defaultMaximum: 1000,
    roots: [...SOURCE_ROOTS],
    extensions: [...SOURCE_EXTENSIONS],
    budgets: [],
    generated: [],
  }
}
export function budget(
  kind: ArchitectureBudget['kind'] = 'transitional',
  maxLines = 1400,
  path = 'src/owner.ts',
): ArchitectureBudget {
  return {
    path,
    kind,
    maxLines,
    owner: 'fixture owner',
    rationale: 'One fixture capability and lifetime.',
    reconsiderWhen: 'The capability gains an independent lifetime.',
    ...(kind === 'transitional' ? { removalIssue: '#435' } : {}),
  }
}
export function repository() {
  const root = mkdtempSync(join(tmpdir(), 'hvir-architecture-'))
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Architecture fixture')
  git('config', 'user.email', 'architecture@example.invalid')
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const commit = () => {
    git('add', '-A')
    git('commit', '-m', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  const policy = (value: unknown) => write(POLICY_PATH, JSON.stringify(value))
  policy(ordinaryPolicy())
  const initial = commit()
  const evidence = new Map<string, ArchitectureIntegration>()
  return {
    root,
    git,
    write,
    policy,
    commit,
    initial,
    evidence,
    read: (path: string) => readFileSync(join(root, path)),
    source: (lines: number, path = 'src/owner.ts') =>
      write(path, '// fixture\n'.repeat(lines)),
    remove: (path: string) => rmSync(join(root, path)),
    integrate: (branch: string, base: string) => {
      const head = git('rev-parse', branch)
      git('switch', 'epic/733-fixture')
      git('merge', '--no-ff', branch, '-m', 'accepted fixture')
      const merge = git('rev-parse', 'HEAD')
      evidence.set(merge, {
        epic: 'epic/733-fixture',
        pullRequest: evidence.size + 1,
        base,
        head,
        merge,
      })
      return merge
    },
    check: (
      base: string,
      kind: ArchitectureContext['kind'] = 'ordinary',
      overrides: Partial<Parameters<typeof authorizeCandidate>[0]> = {},
    ) =>
      authorizeCandidate({
        root,
        context: {
          kind,
          target: kind === 'epic-child' ? 'epic/733-fixture' : 'main',
          epic: 'epic/733-fixture',
          base,
          head: git('rev-parse', 'HEAD'),
        },
        loadIntegration: (merge) => {
          const value = evidence.get(merge)
          if (!value) throw new Error('Missing accepted integration evidence')
          return Promise.resolve(value)
        },
        ...overrides,
      }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}
