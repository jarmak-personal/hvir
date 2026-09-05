#!/usr/bin/env node
import console from 'node:console'
import process from 'node:process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { POLICY_PATH, evaluateInventory, validatePolicy } from './architecture-policy.mjs'
import {
  collectInventory,
  comparisonCounts,
  fullCommit,
} from './architecture-inventory.mjs'
import { authorizeCandidate } from './architecture-authorization.mjs'
import {
  githubAdapter,
  loadArchitectureIntegration,
  requireCurrentRemovalIssues,
  resolveArchitectureContext,
} from './architecture-github.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

export function collectArchitectureHotspots(root = repositoryRoot) {
  const policy = validatePolicy(JSON.parse(readFileSync(join(root, POLICY_PATH), 'utf8')))
  const inventory = collectInventory(root, policy)
  const head = fullCommit(root, 'HEAD')
  const rows = evaluateInventory(
    policy,
    inventory,
    comparisonCounts(root, inventory, [head]),
  )
  return {
    version: 2,
    mode: 'provisional-report',
    head,
    evidence:
      'No authorization claimed; architecture:check resolves the current target and acceptance evidence.',
    rows,
    violations: rows.filter((row) => row.status === 'over'),
  }
}

export function formatReport(report) {
  const lines = [
    `architecture budgets (${report.mode})`,
    `${report.rows.length} maintained source files; every file has one governing rule`,
  ]
  if (report.context)
    lines.push(
      `candidate ${report.context.head}; ${report.context.target} base ${report.context.base}; ${report.admission.kind}`,
    )
  if (report.evidence) lines.push(report.evidence)
  for (const row of report.rows.filter(
    (row) => row.aboveComfort || row.exception || row.status === 'over',
  )) {
    lines.push(
      `${row.status === 'over' ? '!' : '·'} ${row.path}: ${row.lines}/${row.effectiveLimit} lines (${row.category}, ${row.governingRule}${row.aboveComfort ? ', above comfort' : ''})`,
    )
  }
  lines.push(`${report.violations.length} budget violation(s)`)
  return lines.join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const enforce = process.argv.includes('--enforce')
    let report
    if (enforce) {
      const api = githubAdapter(process.env.HVIR_REPO_TOKEN)
      const context = await resolveArchitectureContext(repositoryRoot, api)
      report = await authorizeCandidate({
        root: repositoryRoot,
        context,
        loadIntegration: (merge, epic) =>
          loadArchitectureIntegration(repositoryRoot, api, merge, epic),
      })
      await requireCurrentRemovalIssues(
        api,
        validatePolicy(
          JSON.parse(readFileSync(join(repositoryRoot, POLICY_PATH), 'utf8')),
        ),
      )
      const current = await resolveArchitectureContext(repositoryRoot, api)
      if (current.base !== context.base || current.head !== context.head)
        throw new Error('Architecture target changed during verification; reverify')
    } else report = collectArchitectureHotspots()
    console.log(
      process.argv.includes('--json')
        ? JSON.stringify(report, null, 2)
        : formatReport(report),
    )
    if (enforce && report.violations.length) process.exitCode = 1
  } catch (error) {
    console.error(`Architecture verification failed: ${error.message}`)
    process.exitCode = 1
  }
}
