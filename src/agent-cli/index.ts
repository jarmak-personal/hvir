import { createConnection } from 'node:net'
import {
  listAgentEndpoints,
  validateSelectedAgentEndpoint,
} from '../agent-transport/endpoint-directory'
import { localPath } from '../shared/host-path'
import {
  readAgentGuide,
  installedAuthoringAssets,
} from '../agent-transport/reference-assets'
import {
  AGENT_CONTRACT,
  AGENT_LIMITS,
  agentFailure,
  agentOutput,
  type AgentRequest,
  type AgentResponse,
} from '../shared/agent/contract'
import { parseAgentCommand, staticAgentReference } from '../shared/agent/commands'

async function invoke(endpoint: string, request: AgentRequest): Promise<AgentResponse> {
  const frame = `${JSON.stringify(request)}\n`
  if (Buffer.byteLength(frame) > AGENT_LIMITS.frameBytes)
    throw new Error('Command frame exceeds its bound')
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let data = Buffer.alloc(0),
      settled = false
    const finish = (reason?: Error, response?: AgentResponse): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (reason) reject(reason)
      else resolve(response!)
    }
    socket.setTimeout(AGENT_LIMITS.deadlineMs + 1000, () =>
      finish(new Error('Agent request timed out')),
    )
    socket.once('connect', () => socket.write(frame))
    socket.once('error', () =>
      finish(
        new Error(
          'Selected instance is unavailable; stale endpoints never select another instance',
        ),
      ),
    )
    socket.once('close', () => {
      if (!settled) finish(new Error('Agent connection ended before a result'))
    })
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk])
      if (data.length > AGENT_LIMITS.frameBytes) {
        finish(new Error('Agent response exceeds its bound'))
        return
      }
      const newline = data.indexOf(10)
      if (newline < 0) return
      try {
        const value: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, newline)),
        )
        if (!value || typeof value !== 'object') throw new Error('Invalid response')
        const response = value as AgentResponse
        if (
          response.contract !== AGENT_CONTRACT ||
          typeof response.stdout !== 'string' ||
          typeof response.stderr !== 'string' ||
          !Number.isInteger(response.exitStatus) ||
          response.exitStatus < 0 ||
          response.exitStatus > 255
        )
          throw new Error('Invalid response')
        finish(undefined, response)
      } catch {
        finish(new Error('Selected instance returned an invalid agent contract'))
      }
    })
  })
}
async function command(): Promise<AgentResponse> {
  let parsed
  try {
    parsed = parseAgentCommand(process.argv.slice(2))
  } catch (reason) {
    return agentFailure(
      'invalid-command',
      reason instanceof Error ? reason.message : 'Invalid command',
      64,
    )
  }
  const reference = staticAgentReference(parsed, readAgentGuide)
  if (reference) return reference
  if (['scaffold', 'validate', 'skill'].includes(parsed.name)) {
    const [{ LocalHost }, { ExtensionAuthoring }] = await Promise.all([
      import('../main/project-host/local-host'),
      import('../main/extensions/extension-authoring'),
    ])
    const host = new LocalHost()
    try {
      const assets = localPath(installedAuthoringAssets())
      return await new ExtensionAuthoring(host, assets).command(parsed)
    } finally {
      await host.dispose()
    }
  }
  const explicit = parsed.instance,
    inherited = process.env['HVIR_AGENT_ENDPOINT']
  let endpoint = explicit ?? inherited
  if (parsed.name === 'instances')
    return agentOutput({ endpoints: await listAgentEndpoints() })
  if (!endpoint) {
    const endpoints = await listAgentEndpoints()
    if (endpoints.length !== 1)
      return agentFailure(
        endpoints.length ? 'ambiguous-instance' : 'missing-instance',
        'Use hvir-agent instances and select --instance ENDPOINT',
      )
    endpoint = endpoints[0]!
  }
  if (
    !endpoint.startsWith('/') ||
    Buffer.byteLength(endpoint) >= 104 ||
    endpoint.includes('\0')
  )
    return agentFailure(
      'invalid-instance',
      'Instance selection must be an absolute socket endpoint',
      64,
    )
  await validateSelectedAgentEndpoint(endpoint)
  let stdin = ''
  if (parsed.flags['stdin']) {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      bytes += data.length
      if (bytes > AGENT_LIMITS.stdinBytes)
        return agentFailure('input-limit', 'Command stdin exceeds its bound', 64)
      chunks.push(data)
    }
    try {
      stdin = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } catch {
      return agentFailure('invalid-input', 'Command stdin must be UTF-8', 64)
    }
  }
  // Explicit instance selection does not silently inherit a different instance's terminal defaults.
  const useDefaults = !explicit || explicit === inherited
  return invoke(endpoint, {
    contract: AGENT_CONTRACT,
    argv: process.argv.slice(2),
    stdin,
    defaults: {
      ...(useDefaults && process.env['HVIR_AGENT_WORKSPACE']
        ? { workspace: process.env['HVIR_AGENT_WORKSPACE'] }
        : {}),
      ...(useDefaults && process.env['HVIR_AGENT_SESSION']
        ? { session: process.env['HVIR_AGENT_SESSION'] }
        : {}),
    },
  })
}
void command()
  .catch((reason: unknown) =>
    agentFailure(
      'unavailable',
      reason instanceof Error ? reason.message : 'Agent command unavailable',
    ),
  )
  .then((response) => {
    process.stdout.write(response.stdout)
    process.stderr.write(response.stderr)
    process.exitCode = response.exitStatus
  })
