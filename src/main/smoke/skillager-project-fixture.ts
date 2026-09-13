import { joinHostPath, localPath, type HostPath } from '../../shared/host-path'
import { SKILLAGER_AGENTS, type SkillagerMetadata } from '../../shared/skillager'
import type { SkillagerProjectCliPort } from '../skillager/skillager-project-commands'
import type { SkillagerCliSelection } from '../skillager/skillager-port'
import type { ProjectHost } from '../project-host'
import type { SmokeCleanup } from './cleanup'

/** Deterministic interaction fixture only; installed CLI contracts run separately. */
export function skillagerProjectFixture(
  host: ProjectHost,
  root: HostPath,
  cleanup: SmokeCleanup,
) {
  let executable: Promise<HostPath> | undefined
  const prepare = (): Promise<HostPath> =>
    (executable ??= (async () => {
      const result = await host.exec(
        '/usr/bin/mktemp',
        ['-d', '/tmp/hvir-project-setup-smoke.XXXXXX'],
        { signal: AbortSignal.timeout(5000), maxBuffer: 1024 },
      )
      if (
        result.code !== 0 ||
        !result.stdout.trim().startsWith('/tmp/hvir-project-setup-smoke.')
      )
        throw Error('Setup fixture directory unavailable')
      const directory = await host.realpath(localPath(result.stdout.trim()))
      cleanup.defer('Skillager project script', async () => {
        const removed = await host.exec('/bin/rm', ['-rf', '--', directory.path], {
          signal: AbortSignal.timeout(5000),
          maxBuffer: 1024,
        })
        if (removed.code !== 0) throw Error('Setup fixture cleanup failed')
      })
      const script = joinHostPath(directory, 'skillager')
      await host.writeFile(
        script,
        `#!/bin/sh
[ "$PWD" = "$HVIR_SETUP_FIXTURE_ROOT" ] || exit 66
[ "$1" = '--catalog-state-dir' ] && [ "$3" = 'setup' ] && [ "$4" = '--agent' ] || exit 67
agent="$5"
case "$agent" in codex|claude) ;; *) exit 68 ;; esac
printf '\\033]2;Skillager setup fixture ready\\007'
printf '%s' 'Deterministic setup fixture: p pauses; r completes: '
IFS= read -r choice
case "$choice" in r) : > "$0.$agent.ready" ;; p) ;; *) exit 69 ;; esac
exit 0
`,
      )
      const mode = await host.exec('/bin/chmod', ['700', script.path], {
        signal: AbortSignal.timeout(5000),
        maxBuffer: 1024,
      })
      if (mode.code !== 0) throw Error('Setup fixture executable unavailable')
      return script
    })())
  const projectStatus: SkillagerProjectCliPort['projectStatus'] = async (
    _selection,
    projectRoot,
    agent,
  ) => {
    const script = await prepare()
    let ready = false
    try {
      ready =
        (await host.stat(localPath(script.path + '.' + agent + '.ready'))).type === 'file'
    } catch {
      /* Not completed by the fixture user. */
    }
    return {
      projectRoot,
      agent,
      status: ready ? 'ready' : 'review-needed',
      canProceed: ready,
      reviewNeeded: ready ? 0 : 2,
      lintBlocked: ready ? 0 : 1,
      working: ready ? 'present' : 'missing',
    }
  }
  return {
    async selection(base: SkillagerCliSelection): Promise<SkillagerCliSelection> {
      return {
        ...base,
        executable: await prepare(),
        environment: {
          PATH: '/usr/bin:/bin',
          HOME: root.path,
          HVIR_SETUP_FIXTURE_ROOT: root.path,
        },
      }
    },
    cli: {
      projectStatus,
      async projectMetadata(selection, projectRoot, agent, signal) {
        const status = await projectStatus(selection, projectRoot, agent, signal)
        const rows: SkillagerMetadata[] = (
          ['discovered', 'blocked', 'lint_blocked'] as const
        ).map((trust, index) => ({
          id: `project/fixture-${index}`,
          name: `Project fixture ${index}`,
          description: 'Deterministic project metadata fixture',
          trust: status.canProceed ? 'reviewed' : trust,
          source: { type: 'project', ownership: 'external' },
          tags: [],
          matchReasons: [],
          exposure: 'unknown',
          projectSkill: {
            path: joinHostPath(projectRoot, `.agents/skills/fixture-${index}`),
            agent: SKILLAGER_AGENTS[0].id,
            managed: false,
          },
        }))
        return { rows, status }
      },
    } satisfies SkillagerProjectCliPort,
  }
}
