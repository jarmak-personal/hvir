import { execFile } from 'node:child_process'
import { mkdtemp, realpath, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify, parseArgs } from 'node:util'
import { AGENT_CONTRACT } from '../src/shared/agent/contract.ts'
import { AGENT_GUIDE_TOPICS } from '../src/shared/agent/reference-catalog.ts'

const exec = promisify(execFile)
const { values } = parseArgs({ options: { command: { type: 'string' } }, strict: true })
if (!values.command?.startsWith('/'))
  throw new Error('Select the exact installed hvir-agent command')
const environment = { ...process.env }
for (const key of [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'HVIR_AGENT_ENDPOINT',
  'HVIR_AGENT_WORKSPACE',
  'HVIR_AGENT_SESSION',
])
  delete environment[key]
// Unrelated working directory: no checkout, display, instance or live authority is needed.
const temporary = await mkdtemp(join(tmpdir(), 'hvir-installed-authoring-'))
const directory = await realpath(temporary)
async function invoke(
  argv: readonly string[],
  status = 0,
): Promise<Record<string, unknown>> {
  let result: { stdout: string; stderr: string }
  try {
    result = await exec(values.command!, argv, {
      env: environment,
      cwd: directory,
      timeout: 10000,
      maxBuffer: 256 * 1024,
    })
  } catch (reason) {
    const failure = reason as { code?: number; stdout?: string; stderr?: string }
    if (failure.code !== status || status === 0) throw reason
    result = { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
  const response = JSON.parse(result.stdout) as Record<string, unknown>
  if (
    response['contract'] !== AGENT_CONTRACT ||
    response['ok'] !== (status === 0) ||
    (status === 0 && result.stderr)
  )
    throw new Error(`Installed agent reference failed: ${argv.join(' ')}`)
  return response
}
try {
  for (const argv of [
    [],
    ['commands'],
    ['help', 'report'],
    ['guide'],
    ...Object.keys(AGENT_GUIDE_TOPICS).map((topic) => ['guide', topic]),
    ['help', 'scaffold'],
    ['help', 'validate'],
    ['help', 'skill'],
  ])
    await invoke(argv)
  const skill = (await invoke(['skill']))['skill']
  const output = join(directory, 'clock'),
    exported = join(directory, 'SKILL.md')
  await invoke(['scaffold', '--output', output])
  await invoke(['validate', '--path', output])
  await invoke(['skill', '--output', exported])
  if ((await readFile(exported, 'utf8')) !== skill)
    throw new Error('Exported skill differs from inspected bytes')
  await invoke(['scaffold', '--output', output], 64)
  await invoke(['skill', '--output', exported], 64)
  await invoke(['scaffold'], 64)
  await invoke(['scaffold', '--output', 'relative'], 64)
  await invoke(
    ['scaffold', '--output', join(directory, 'other'), '--instance', '/not-an-instance'],
    64,
  )
  if ((await readdir(directory)).some((name) => name.startsWith('.hvir-authoring-')))
    throw new Error('Known occupied-output refusal left a stage')
  console.log(
    `HVIR_AGENT_INSTALLED_REFERENCE_OK topics=${Object.keys(AGENT_GUIDE_TOPICS).length} scaffold=1 validate=1 exact-skill=1 expected-refusals=5`,
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
