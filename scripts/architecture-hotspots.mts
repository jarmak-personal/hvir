#!/usr/bin/env node
import console from 'node:console'
import process from 'node:process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import {
  POLICY_PATH,
  evaluateInventory,
  validatePolicy,
  type ArchitectureRow,
} from './architecture-policy.mts'
import { createArchitectureInventory, fullCommit } from './architecture-inventory.mts'
import {
  authorizeCandidate,
  type ArchitectureContext,
} from './architecture-authorization.mts'
import {
  githubAdapter,
  loadArchitectureIntegration,
  requireCurrentRemovalIssues,
  resolveArchitectureContext,
} from './architecture-github.mts'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

export function collectArchitectureHotspots(root = repositoryRoot) {
  const source = createArchitectureInventory(root)
  const policy = validatePolicy(JSON.parse(readFileSync(join(root, POLICY_PATH), 'utf8')))
  const inventory = source.collectInventory(policy)
  const head = fullCommit(root, 'HEAD')
  const rows = evaluateInventory(
    policy,
    inventory,
    source.comparisonCounts(inventory, [head]),
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

export function formatReport(report: {
  mode: string
  rows: ArchitectureRow[]
  violations: ArchitectureRow[]
  context?: ArchitectureContext
  admission?: { kind: string }
  evidence?: string
}): string {
  const lines = [
    `architecture budgets (${report.mode})`,
    `${report.rows.length} maintained source files; every file has one governing rule`,
  ]
  if (report.context)
    lines.push(
      `candidate ${report.context.head}; ${report.context.target} base ${report.context.base}; ${report.admission?.kind ?? 'unavailable'}`,
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

export async function runArchitectureCommand(): Promise<void> {
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
    console.error(
      `Architecture verification failed: ${error instanceof Error ? error.message : 'Unknown failure'}`,
    )
    process.exitCode = 1
  }
}
