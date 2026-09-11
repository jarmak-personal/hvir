import { Buffer } from 'node:buffer'
import process from 'node:process'
import console from 'node:console'
// Opt-in real CLI contract probe. Only the newly created disposable roots are mutated.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const release = resolve(process.argv[2] || '')
if (!process.argv[2])
  throw new Error(
    'Pass the isolated Skillager v0.9.0 release checkout with its uv .venv prepared.',
  )
const python = join(release, '.venv/bin/python')
const root = mkdtempSync(join(tmpdir(), 'hvir-skillager-contract-'))
const reports = []
const checks = []
function fixture(name, git) {
  const path = join(root, name)
  const project = join(path, 'project')
  const library = join(path, 'library')
  mkdirSync(project, { recursive: true })
  mkdirSync(join(path, 'home'))
  const env = {
    PATH: process.env.PATH,
    HOME: join(path, 'home'),
    NO_COLOR: '1',
    XDG_CONFIG_HOME: join(path, 'config'),
    XDG_DATA_HOME: join(path, 'data'),
    XDG_CACHE_HOME: join(path, 'cache'),
    XDG_STATE_HOME: join(path, 'xdg-state'),
    CODEX_HOME: join(path, 'codex'),
    CLAUDE_CONFIG_DIR: join(path, 'claude'),
    PYTHONPATH: join(release, 'src'),
    SKILLAGER_NO_UPDATE_CHECK: '1',
    SKILLAGER_STATE_DIR: join(path, 'state/project'),
    SKILLAGER_CATALOG_STATE_DIR: join(path, 'state/catalog'),
    SKILLAGER_CACHE_DIR: join(path, 'cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(path, 'gitconfig'),
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
  const run = (...args) => {
    let text,
      code = 0,
      error = ''
    try {
      text = execFileSync(python, ['-m', 'skillager', ...args], {
        cwd: project,
        env,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      if (typeof e.status !== 'number') throw e
      code = e.status
      text = e.stdout || ''
      error = e.stderr || ''
    }
    const value =
      text.trim().startsWith('{') || text.trim().startsWith('[') ? JSON.parse(text) : null
    reports.push({
      fixture: name,
      command: args.map((arg, i) =>
        args[i - 1] === '--confirmation-token' ? '<opaque token>' : arg,
      ),
      code,
      schema: value?.schema || value?.[0]?.schema || null,
      status: value?.status || value?.[0]?.status || null,
      keys: value && !Array.isArray(value) ? Object.keys(value).sort() : null,
      stderrBytes: Buffer.byteLength(error),
    })
    return { code, text, value, error }
  }
  assert.match(run('--version').text, /skillager 0\.9\.0/)
  assert.equal(
    run('library', 'init', '--path', library, ...(git ? [] : ['--no-git']), '--json')
      .code,
    0,
  )
  assert.equal(run('library', 'new', 'probe', '--json').code, 0)
  const file = join(library, 'skills/probe/SKILL.md')
  const content = (suffix) =>
    `---\nname: Probe Review\ndescription: Review examples and compare expected behavior.\n---\n# Probe Review\n\nRead the examples. Describe observed behavior ${suffix}.\n`
  writeFileSync(file, content('before'))
  return { run, file, project, content }
}
const tokenFrom = (result) => {
  assert.equal(result.code, 0)
  const argv =
    result.value.next_command_argv || result.value.results?.[0]?.next_command_argv
  assert.ok(Array.isArray(argv))
  const index = argv.indexOf('--confirmation-token')
  assert.ok(index > 0 && typeof argv[index + 1] === 'string')
  return argv[index + 1]
}
try {
  for (const git of [false, true]) {
    const f = fixture(git ? 'git-library' : 'no-git-library', git)
    const status = f.run('library', 'status', '--json')
    assert.equal(status.value.schema, 'skillager.library-status.v1')
    assert.equal(status.value.counts.skills, 1)
    assert.equal(status.value.skill, null)
    const inventory = f.run(
      'review',
      '--collection',
      'lib',
      '--include-blocked',
      '--include-lint-blocked',
      '--json',
    )
    assert.equal(inventory.value.selected[0].id, 'lib/probe')
    assert.equal(inventory.value.selected[0].approval, 'unreviewed')
    assert.ok(!inventory.text.includes('Describe observed behavior'))
    assert.deepEqual(
      f.run(
        'search',
        'behavior',
        '--scope',
        'library',
        '--limit',
        '50',
        '--json',
        '--no-session-record',
      ).value,
      [],
    )
    const pending = f.run('show', 'lib/probe', '--content', '--json')
    assert.notEqual(pending.code, 0)
    const first = f.run('library', 'accept', 'lib/probe', '--json')
    assert.equal(first.value.schema, 'skillager.library-accept.v1')
    const oldToken = tokenFrom(first)
    writeFileSync(f.file, f.content('after'))
    assert.notEqual(
      f.run(
        'library',
        'accept',
        'lib/probe',
        '--yes',
        '--confirmation-token',
        oldToken,
        '--json',
      ).code,
      0,
    )
    const preview = f.run('library', 'accept', 'lib/probe', '--json')
    const accepted = f.run(
      'library',
      'accept',
      'lib/probe',
      '--yes',
      '--confirmation-token',
      tokenFrom(preview),
      '--json',
    )
    assert.equal(accepted.value.status, 'accepted')
    assert.equal(accepted.value.skill.working_hash, preview.value.skill.working_hash)
    assert.equal(f.run('show', 'lib/probe', '--content', '--json').code, 0)
    const history = f.run('library', 'history', 'lib/probe', '--json')
    assert.equal(history.value.available, git)
    writeFileSync(f.file, f.content('next'))
    const diff = f.run('library', 'diff', 'lib/probe', '--json')
    if (git) {
      assert.equal(diff.value.schema, 'skillager.library-diff.v1')
      assert.equal(diff.value.content_bearing, true)
      assert.equal(
        diff.value.to.content_hash,
        f.run('library', 'accept', 'lib/probe', '--json').value.skill.working_hash,
      )
      assert.match(diff.value.diff, /next/)
      const stat = f.run('library', 'diff', 'lib/probe', '--stat', '--json')
      assert.equal(stat.value.content_bearing, false)
      assert.equal(stat.value.diff, null)
    } else assert.notEqual(diff.code, 0)
    const next = f.run('library', 'accept', 'lib/probe', '--json')
    assert.equal(
      f.run(
        'library',
        'accept',
        'lib/probe',
        '--yes',
        '--confirmation-token',
        tokenFrom(next),
        '--json',
      ).value.status,
      'accepted',
    )
    const expose = f.run(
      'expose',
      'lib/probe',
      '--agent',
      'codex',
      '--mode',
      'native',
      '--dry-run',
      '--json',
    )
    assert.equal(expose.value[0].status, 'would_expose')
    assert.ok(!('next_command_argv' in expose.value[0]))
    assert.ok(!('files' in expose.value[0]))
    assert.equal(
      f.run('expose', 'lib/probe', '--agent', 'codex', '--mode', 'native', '--json')
        .value[0].status,
      'exposed',
    )
    const list = f.run('expose', '--list', '--agent', 'codex', '--json')
    assert.equal(list.value.schema, 'skillager.exposures.v1')
    assert.equal(list.value.exposures.length, 1)
    const target = join(f.project, '.agents/skills/lib-probe/SKILL.md')
    const unchanged = readFileSync(target, 'utf8')
    writeFileSync(f.file, f.content('latest'))
    const finalPreview = f.run('library', 'accept', 'lib/probe', '--json')
    assert.equal(
      f.run(
        'library',
        'accept',
        'lib/probe',
        '--yes',
        '--confirmation-token',
        tokenFrom(finalPreview),
        '--json',
      ).value.status,
      'accepted',
    )
    assert.equal(readFileSync(target, 'utf8'), unchanged)
    const removal = f.run('expose', '--remove', 'lib-probe', '--agent', 'codex', '--json')
    const removalToken = tokenFrom(removal)
    writeFileSync(target, unchanged + '\nLocal modification.\n')
    assert.notEqual(
      f.run(
        'expose',
        '--remove',
        'lib-probe',
        '--agent',
        'codex',
        '--yes',
        '--confirmation-token',
        removalToken,
        '--json',
      ).code,
      0,
    )
    assert.match(readFileSync(target, 'utf8'), /Local modification/)
    writeFileSync(target, unchanged)
    const freshRemoval = f.run(
      'expose',
      '--remove',
      'lib-probe',
      '--agent',
      'codex',
      '--json',
    )
    const removed = f.run(
      'expose',
      '--remove',
      'lib-probe',
      '--agent',
      'codex',
      '--yes',
      '--confirmation-token',
      tokenFrom(freshRemoval),
      '--json',
    )
    assert.equal(removed.value.results[0].status, 'removed')
    assert.match(readFileSync(f.file, 'utf8'), /latest/)
    checks.push(
      `${git ? 'Git' : 'No-Git'}: metadata/status, pending exclusion, content refusal, stale/exact acceptance, history/diff, exposure dry-run/list, acceptance preserves exposure, stale removal protection and library-preserving removal`,
    )
  }
  console.log(
    JSON.stringify(
      {
        baseline: 'Skillager v0.9.0 / fda8f4da442b8165cc34ac62e626b76920a90838',
        checks,
        reports,
        scope:
          'Isolated CLI contracts only; no application or remote transport evidence.',
      },
      null,
      2,
    ),
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
