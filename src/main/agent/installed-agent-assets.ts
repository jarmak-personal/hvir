import { basename, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { localPath, joinHostPath } from '../../shared/host-path'
import { AGENT_GUIDE_TOPICS } from '../../shared/agent/reference-catalog'
import {
  staticAgentReference,
  type ParsedAgentCommand,
} from '../../shared/agent/commands'
import { agentFailure, type AgentResponse } from '../../shared/agent/contract'
import type { ProjectHost } from '../project-host/project-host'
import { REMOTE_CLIENT_CACHE_LIMITS, type RemoteClientAsset } from './remote-client-cache'

/** Fixed installed assets, read asynchronously through LocalHost; no live command policy. */
export class InstalledAgentAssets {
  constructor(private readonly host: ProjectHost) {}
  private directory(resource: 'agent-guides' | 'agent-clients') {
    const directory = basename(__dirname) === 'chunks' ? dirname(__dirname) : __dirname
    return {
      packaged: localPath(resolve(directory, '../../../', resource)),
      development: localPath(
        resolve(
          directory,
          resource === 'agent-guides'
            ? '../../build/native/agent-guides'
            : '../agent-clients',
        ),
      ),
    }
  }
  private async root(resource: 'agent-guides' | 'agent-clients') {
    const paths = this.directory(resource)
    try {
      if ((await this.host.stat(paths.packaged)).type === 'dir') return paths.packaged
    } catch {
      /* Development assets have a separate fixed location. */
    }
    return paths.development
  }
  async reference(command: ParsedAgentCommand): Promise<AgentResponse> {
    let guide: unknown
    if (command.name === 'guide') {
      const topic = command.positionals[0]
      if (topic) {
        if (!Object.hasOwn(AGENT_GUIDE_TOPICS, topic))
          return agentFailure(
            'unknown-guide',
            'Use hvir-agent guide to list installed topics',
            64,
          )
        const read = await this.host.readTextFilePrefix(
          joinHostPath(await this.root('agent-guides'), `${topic}.md`),
          64 * 1024,
        )
        if (!read.complete || read.validUtf8 === false)
          throw new Error('Installed guide exceeds its bound or is not UTF-8')
        guide = {
          id: topic,
          title: AGENT_GUIDE_TOPICS[topic as keyof typeof AGENT_GUIDE_TOPICS],
          content: read.content,
        }
      } else
        guide = Object.entries(AGENT_GUIDE_TOPICS).map(([id, title]) => ({ id, title }))
    }
    return (
      staticAgentReference(command, () => guide) ??
      agentFailure('local-authoring', 'Authoring runs on the local machine', 69)
    )
  }
  async client(target: string): Promise<RemoteClientAsset> {
    if (!['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64'].includes(target))
      throw new Error('Unsupported remote client target')
    const root = await this.root('agent-clients'),
      path = joinHostPath(root, target, 'hvir-agent')
    const manifestRead = await this.host.readTextFilePrefix(
      joinHostPath(root, 'manifest.json'),
      8192,
    )
    if (!manifestRead.complete || manifestRead.validUtf8 === false)
      throw new Error('Bundled remote client manifest is invalid')
    const manifest = JSON.parse(manifestRead.content) as {
      contract?: string
      source?: string
      clients?: Record<string, { sha256?: string; bytes?: number }>
    }
    const entry = manifest.clients?.[target],
      stat = await this.host.stat(path)
    if (
      manifest.contract !== '1.0' ||
      !/^[a-f0-9]{40}$/.test(manifest.source ?? '') ||
      !entry ||
      stat.type !== 'file' ||
      stat.size < 1 ||
      stat.size > REMOTE_CLIENT_CACHE_LIMITS.clientBytes ||
      entry.bytes !== stat.size ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')
    )
      throw new Error('Bundled remote client provenance is invalid')
    const bytes = await this.host.readFile(path)
    if (
      bytes.length !== entry.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== entry.sha256
    )
      throw new Error('Bundled remote client integrity failed')
    return { bytes, sha256: entry.sha256, target }
  }
}
