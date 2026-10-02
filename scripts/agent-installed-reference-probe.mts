import { execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { AGENT_CONTRACT } from '../src/shared/agent/contract'

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
for (const argv of [
  [],
  ['commands'],
  ['help', 'report'],
  ['guide'],
  ['guide', 'targeting'],
  ['guide', 'access'],
  ['guide', 'reports'],
  ['guide', 'walkthrough'],
]) {
  const result = await exec(values.command, argv, {
    env: environment,
    timeout: 10000,
    maxBuffer: 256 * 1024,
  })
  const response = JSON.parse(result.stdout) as { contract?: string; ok?: boolean }
  if (response.contract !== AGENT_CONTRACT || response.ok !== true || result.stderr)
    throw new Error(`Installed agent reference failed: ${argv.join(' ')}`)
}
console.log('HVIR_AGENT_INSTALLED_REFERENCE_OK')
