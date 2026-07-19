#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

export function collectArchitectureHotspots(root = repositoryRoot) {
  const policy = JSON.parse(
    readFileSync(join(root, 'scripts', 'architecture-hotspots.json'), 'utf8'),
  )
  const extensions = new Set(policy.extensions)
  const scanRoots = [...policy.productionRoots, ...policy.testRoots]
    .map((path) => join(root, path))
    .filter((path) => existsSync(path))
  const files = [...new Set(scanRoots.flatMap((path) => walk(path)))]
    .filter((path) => extensions.has(extname(path)))
    .map((path) => relative(root, path).split(sep).join('/'))
    .sort()
  const hotspotByPath = new Map(policy.legacyHotspots.map((entry) => [entry.path, entry]))
  const generated = new Set(policy.generatedFiles)
  const rows = files.map((path) => {
    const lines = lineCount(readFileSync(join(root, path), 'utf8'))
    const hotspot = hotspotByPath.get(path)
    const category = generated.has(path)
      ? 'generated'
      : policy.testRoots.some(
            (testRoot) => path === testRoot || path.startsWith(`${testRoot}/`),
          )
        ? 'test'
        : 'production'
    const existedAtBaseline = gitPathExists(root, policy.baselineCommit, path)
    const limit =
      hotspot?.maxLines ??
      (category === 'generated'
        ? policy.limits.generatedModule
        : category === 'test'
          ? policy.limits.testModule
          : !existedAtBaseline
            ? policy.limits.newProductionModule
            : undefined)
    return {
      path,
      lines,
      category,
      baseline: existedAtBaseline ? 'existing' : 'new',
      limit,
      status: limit !== undefined && lines > limit ? 'over' : 'ok',
      exception: hotspot
        ? {
            owner: hotspot.owner,
            rationale: hotspot.rationale,
            removalIssue: hotspot.removalIssue,
            expiresOn: hotspot.expiresOn,
          }
        : undefined,
    }
  })
  return {
    version: policy.version,
    baselineCommit: policy.baselineCommit,
    mode: process.argv.includes('--enforce') ? 'enforce' : 'report',
    limits: policy.limits,
    rows,
    violations: rows.filter((row) => row.status === 'over'),
  }
}

function walk(path) {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name)
    return entry.isDirectory() ? walk(child) : [child]
  })
}

function lineCount(source) {
  if (source.length === 0) return 0
  const newlines = source.match(/\n/g)?.length ?? 0
  return newlines + (source.endsWith('\n') ? 0 : 1)
}

function gitPathExists(root, revision, path) {
  try {
    execFileSync('git', ['cat-file', '-e', `${revision}:${path}`], {
      cwd: root,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function printReport(report) {
  const named = report.rows.filter((row) => row.exception)
  console.log(`architecture hotspot report (baseline ${report.baselineCommit})`)
  for (const row of named) {
    const marker = row.status === 'over' ? '!' : '·'
    console.log(`${marker} ${row.path}: ${row.lines}/${row.limit} lines`)
  }
  const newModules = report.rows.filter(
    (row) => row.baseline === 'new' && !row.exception && row.lines > 0,
  )
  if (newModules.length > 0) {
    console.log(`new modules since baseline: ${newModules.length}`)
    for (const row of newModules.filter((candidate) => candidate.status === 'over')) {
      console.log(`! ${row.path}: ${row.lines}/${row.limit} lines (${row.category})`)
    }
  }
  if (report.violations.length === 0) {
    console.log('architecture hotspot policy has no violations')
  } else {
    console.log(
      `${report.violations.length} architecture hotspot violation(s) ${report.mode === 'enforce' ? 'block verification' : 'reported only'}`,
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = collectArchitectureHotspots()
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else printReport(report)
  if (process.argv.includes('--enforce') && report.violations.length > 0) {
    process.exitCode = 1
  }
}
