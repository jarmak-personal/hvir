#!/usr/bin/env node

import console from 'node:console'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  applyCandidateBundle,
  assertDeliveryStateUnchanged,
  assertValidatedReleaseUnchanged,
  readCandidateBundle,
  writeCandidateBundle,
} from './candidate-bundle.mts'
import { prepareGhosttyWebUpdate } from './coordinator.mts'
import { BoundedGitHubClient } from './github-client.mts'
import { GitHubGhosttyWebDelivery } from './github-delivery.mts'
import { GitHubGhosttyWebReleaseSource } from './github-release-source.mts'
import { selectNewestPublishedRelease } from './policy.mts'
import { RepositoryGhosttyWebCandidate } from './repository-candidate.mts'

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

async function main(): Promise<void> {
  const mode = process.argv[2]
  const bundleRoot = process.argv[3]
  if (
    (mode !== 'prepare' && mode !== 'publish') ||
    !bundleRoot ||
    process.argv.length !== 4
  ) {
    throw new Error('Usage: update:ghostty-web -- <prepare|publish> <bundle-directory>')
  }
  const repository = requiredEnvironment('HVIR_REPOSITORY')
  const defaultBranch = requiredEnvironment('HVIR_DEFAULT_BRANCH')
  if (mode === 'prepare') {
    await prepare(resolve(bundleRoot), repository, defaultBranch)
  } else {
    await publish(resolve(bundleRoot), repository, defaultBranch)
  }
}

async function prepare(
  bundleRoot: string,
  repository: string,
  defaultBranch: string,
): Promise<void> {
  const result = await prepareGhosttyWebUpdate({
    candidate: new RepositoryGhosttyWebCandidate(repositoryRoot),
    delivery: new GitHubGhosttyWebDelivery({
      appSlug: 'unprivileged-prepare',
      client: new BoundedGitHubClient(),
      defaultBranch,
      repository,
      root: repositoryRoot,
      runUrl: `https://github.com/${repository}/actions`,
    }),
    releases: new GitHubGhosttyWebReleaseSource(),
  })
  switch (result.outcome) {
    case 'no-op':
      console.log(
        `ghostty-web update no-op: ${result.selectedTag} is already represented by ${result.reason === 'main-current' ? 'main' : 'the open update pull request'}.`,
      )
      break
    case 'suppressed':
      console.log(
        `ghostty-web update suppressed: ${result.selectedTag} was already declined by closing ${result.rejectedTag}.`,
      )
      break
    case 'prepared': {
      const bundle = await writeCandidateBundle(bundleRoot, repositoryRoot, result)
      await writeOutputs({
        outcome: 'prepared',
        selected_tag: bundle.release.tag,
      })
      console.log(`ghostty-web update prepared: ${bundle.release.tag}.`)
      break
    }
  }
  if (result.outcome !== 'prepared') {
    await writeOutputs({ outcome: result.outcome, selected_tag: result.selectedTag })
  }
}

async function publish(
  bundleRoot: string,
  repository: string,
  defaultBranch: string,
): Promise<void> {
  const token = requiredEnvironment('HVIR_GITHUB_TOKEN')
  const delivery = new GitHubGhosttyWebDelivery({
    appSlug: requiredEnvironment('HVIR_UPDATE_APP_SLUG'),
    client: new BoundedGitHubClient({ token }),
    defaultBranch,
    repository,
    root: repositoryRoot,
    runUrl: requiredEnvironment('HVIR_UPDATE_RUN_URL'),
  })
  const bundle = await readCandidateBundle(bundleRoot)
  const releases = new GitHubGhosttyWebReleaseSource()
  const selected = selectNewestPublishedRelease(await releases.listReleases())
  if (selected.tag.name !== bundle.release.tag) {
    throw new Error('A newer ghostty-web release appeared before publication.')
  }
  assertValidatedReleaseUnchanged(
    bundle.release,
    await releases.validateRelease(selected),
  )
  const observedDelivery = await delivery.inspect()
  assertDeliveryStateUnchanged(bundle.delivery, observedDelivery)
  await applyCandidateBundle(bundleRoot, repositoryRoot, bundle)
  const published = await delivery.publish(
    bundle.current,
    { changedFiles: bundle.changedFiles, release: bundle.release },
    observedDelivery,
  )
  console.log(
    `ghostty-web update pull request #${published.pullRequestNumber}: ${published.url}`,
  )
}

async function writeOutputs(values: Readonly<Record<string, string>>): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) return
  const lines = Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')
  await appendFile(outputPath, `${lines}\n`)
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'ghostty-web update failed.')
    process.exitCode = 1
  }
}
