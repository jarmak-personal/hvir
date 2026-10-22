import { cp, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { agentClientManifest, AGENT_CLIENT_TARGETS } from './agent-client-artifacts.mjs'

const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  output = resolve('out/agent-clients')
await mkdir(output, { recursive: true })
for (const target of AGENT_CLIENT_TARGETS) {
  await cp(
    resolve('out/agent-client-downloads', `agent-client-${target}`),
    join(output, target),
    { recursive: true, errorOnExist: true, force: false },
  )
}
await agentClientManifest(output, source)
console.log(`HVIR_AGENT_CLIENT_SET_OK source=${source}`)
