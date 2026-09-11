import type { SkillagerExposureCliPort } from '../skillager/skillager-exposure-port'
import type { SkillagerReviewCliPort } from '../skillager/skillager-review-port'
import { randomUUID } from 'node:crypto'
import { joinHostPath, localPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host'
import { SkillagerCli } from '../skillager/skillager-cli'
import type { SkillagerCliPort } from '../skillager/skillager-port'
import type { SmokeCleanup } from './cleanup'
import { skillagerFixtureEnvironment } from './skillager-fixture-environment'

/** Opt-in real CLI load over an explicitly supplied disposable acceptance fixture. */
export function realSkillagerSmokePort(
  host: ProjectHost,
  cleanup: SmokeCleanup,
): (SkillagerCliPort & SkillagerReviewCliPort & SkillagerExposureCliPort) | undefined {
  const fixture = process.env.HVIR_SKILLAGER_SMOKE_FIXTURE
  const release = process.env.HVIR_SKILLAGER_RELEASE
  if (!fixture || !release) return undefined
  const root = localPath(fixture)
  // Public CLI cache selection makes the first search build its own index, even
  // when the retained acceptance catalog has already been searched by another run.
  const { env: environment, unsetEnv } = skillagerFixtureEnvironment(
    root,
    process.env,
    joinHostPath(root, `electron-cache-${randomUUID()}`),
  )
  const cli = new SkillagerCli(
    {
      hostId: host.hostId,
      defaultShell: () => Promise.resolve('/bin/sh'),
      realpath: (value) => host.realpath(value),
      stat: (value) => host.stat(value),
      readdir: (value) => host.readdir(value),
      fileTransfer: host.fileTransfer,
      createDirectoryExclusive: (value, options) =>
        host.createDirectoryExclusive(value, options),
      exec: (command, args, options) =>
        host.exec(command, args, {
          ...options,
          unsetEnv,
          env: { ...environment, ...options?.env },
        }),
    },
    joinHostPath(root, 'scratch'),
  )
  cleanup.defer('real Skillager CLI', () => cli.dispose())
  return {
    updateSourceHash: (selection, snapshot, signal) =>
      cli.updateSourceHash(selection, snapshot, signal),
    previewExposure: (selection, request, signal) =>
      cli.previewExposure(selection, request, signal),
    applyExposure: (selection, snapshot, signal) =>
      cli.applyExposure(selection, snapshot, signal),
    review: (selection, skillId, signal) => cli.review(selection, skillId, signal),
    history: (selection, skillId, signal) => cli.history(selection, skillId, signal),
    diff: (selection, snapshot, fromHash, signal) =>
      cli.diff(selection, snapshot, fromHash, signal),
    accept: (selection, snapshot, signal) => cli.accept(selection, snapshot, signal),
    probe: (executable, signal) =>
      cli.probe(
        executable ?? joinHostPath(localPath(release), '.venv/bin/skillager'),
        signal,
      ),
    validate: (selection, signal) => cli.validate(selection, signal),
    inventory: (selection, signal) => cli.inventory(selection, signal),
    search: (selection, request, signal) => cli.search(selection, request, signal),
    exposures: (selection, request, signal) => cli.exposures(selection, request, signal),
  }
}
