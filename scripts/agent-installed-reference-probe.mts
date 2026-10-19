import { execFile } from 'node:child_process'
import {
  mkdtemp,
  realpath,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify, parseArgs } from 'node:util'
import { AGENT_CONTRACT } from '../src/shared/agent/contract.ts'
import { extensionPackageArchive } from './extension-package-archive.mts'
import { AGENT_GUIDE_TOPICS } from '../src/shared/agent/reference-catalog.ts'
import { EXTENSION_CAPABILITIES } from '../src/shared/extensions/contract.ts'

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
    result.stderr
  )
    throw new Error(`Installed agent reference failed: ${argv.join(' ')}`)
  return response
}
try {
  const guides: string[] = []
  for (const argv of [
    [],
    ['commands'],
    ['help', 'report'],
    ['guide'],
    ...Object.keys(AGENT_GUIDE_TOPICS).map((topic) => ['guide', topic]),
    ['help', 'scaffold'],
    ['help', 'validate'],
    ['help', 'skill'],
  ]) {
    const response = await invoke(argv)
    if (argv[0] === 'guide' && argv.length === 2) {
      const guide = response['guide'] as { content?: unknown } | undefined
      if (typeof guide?.content !== 'string')
        throw new Error(`Installed guide content is missing: ${argv[1]}`)
      guides.push(guide.content)
    }
  }
  const documented = guides.flatMap((guide) =>
    [...guide.matchAll(/^### ([a-z]+\.[a-z-]+)$/gm)].map((match) => match[1]!),
  )
  if (
    JSON.stringify(documented.sort()) !==
    JSON.stringify([...EXTENSION_CAPABILITIES].sort())
  )
    throw new Error(
      'Installed guides omit, duplicate or retain stale capability contracts',
    )
  const skill = (await invoke(['skill']))['skill']
  for (const name of ['scaffold', 'validate', 'skill']) {
    const focused = await invoke(['help', name])
    for (const flag of ['--help', '-h'])
      if (JSON.stringify(await invoke([name, flag])) !== JSON.stringify(focused))
        throw new Error('Conventional authoring help differs from focused reference')
  }
  const output = join(directory, 'clock'),
    exported = join(directory, 'SKILL.md')
  await invoke(['scaffold', '--output', output])
  const index = join(output, 'index.html')
  const original = await readFile(index, 'utf8')
  const customized = original.replace('<h1>Clock</h1>', '<h1>My clock</h1>')
  if (customized === original) throw new Error('Current starter customization is stale')
  await writeFile(index, customized)
  const validated = await invoke(['validate', '--path', output])
  const archive = join(directory, 'clock.zip')
  const files = new Map<string, Uint8Array>()
  for (const name of await readdir(output))
    files.set(name, await readFile(join(output, name)))
  await writeFile(archive, await extensionPackageArchive(files))
  const zipped = await invoke(['validate', '--path', archive])
  if (
    (validated['validation'] as { revision: string }).revision !==
    (zipped['validation'] as { revision: string }).revision
  )
    throw new Error('Customized directory and ZIP differ')
  await invoke(['skill', '--output', exported])
  if ((await readFile(exported, 'utf8')) !== skill)
    throw new Error('Exported skill differs from inspected bytes')
  await invoke(['scaffold', '--output', output], 64)
  await invoke(['skill', '--output', exported], 64)
  if (
    (await readFile(index, 'utf8')) !== customized ||
    (await readFile(exported, 'utf8')) !== skill
  )
    throw new Error('Occupied-output refusal changed user bytes')
  await invoke(
    ['scaffold', '--output', join(directory, 'other'), '--instance', '/not-an-instance'],
    64,
  )
  const linked = join(directory, 'linked-parent')
  await symlink(directory, linked)
  await invoke(['scaffold', '--output', join(linked, 'escape')], 64)
  const invalid = join(directory, 'invalid.zip')
  await writeFile(invalid, 'not an extension archive')
  await invoke(['validate', '--path', invalid], 64)
  for (const argv of [
    ['scaffold'],
    ['scaffold', '--output', 'relative'],
    ['scaffold', '--output'],
    ['scaffold', '--output', output, '--output', output],
    ['validate', '--help', '--path', output],
    ['skill', '--' + 'x'.repeat(5000)],
  ]) {
    const failed = await invoke(argv, 64)
    const error = failed['error'] as { message: string }
    if (!error.message.includes(`help ${argv[0]}`) || error.message.length > 240)
      throw new Error('Argument refusal omitted bounded focused help')
  }
  if ((await readdir(directory)).some((name) => name.startsWith('.hvir-authoring-')))
    throw new Error('Known occupied-output refusal left a stage')
  console.log(
    `HVIR_AGENT_INSTALLED_REFERENCE_OK topics=${Object.keys(AGENT_GUIDE_TOPICS).length} capabilities=${documented.length} authoring-help=6 customized-scaffold=1 directory-validate=1 zip-validate=1 exact-skill=1 preserved-output=1 expected-refusals=11`,
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
