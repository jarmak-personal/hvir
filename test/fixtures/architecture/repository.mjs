import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  POLICY_PATH,
  SOURCE_EXTENSIONS,
  SOURCE_ROOTS,
} from '../../../scripts/architecture-policy.mjs'
import { authorizeCandidate } from '../../../scripts/architecture-authorization.mjs'

export function ordinaryPolicy() {
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
export function budget(kind = 'transitional', maxLines = 1400, path = 'src/owner.ts') {
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
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Architecture fixture')
  git('config', 'user.email', 'architecture@example.invalid')
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const commit = () => {
    git('add', '-A')
    git('commit', '-m', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  const policy = (value) => write(POLICY_PATH, JSON.stringify(value))
  policy(ordinaryPolicy())
  const initial = commit()
  const evidence = new Map()
  return {
    root,
    git,
    write,
    policy,
    commit,
    initial,
    evidence,
    read: (path) => readFileSync(join(root, path)),
    source: (lines, path = 'src/owner.ts') => write(path, '// fixture\n'.repeat(lines)),
    remove: (path) => rmSync(join(root, path)),
    integrate: (branch, base) => {
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
    check: (base, kind = 'ordinary', overrides = {}) =>
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
