import {
  agentFailure,
  agentOutput,
  type AgentResponse,
} from '../../shared/agent/contract'
import type { ParsedAgentCommand } from '../../shared/agent/commands'
import { EXTENSION_CONTRACT } from '../../shared/extensions/contract'
import {
  localPath,
  joinHostPath,
  LOCAL_HOST_ID,
  type HostPath,
} from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { ExtensionPackageStore } from './package-store'

/** Local authoring consumes ordinary package policy; it owns no activation or guest authority. */
export class ExtensionAuthoring {
  constructor(
    private readonly host: ProjectHost,
    private readonly assets: HostPath,
  ) {}
  async command(command: ParsedAgentCommand): Promise<AgentResponse> {
    if (!['scaffold', 'validate', 'skill'].includes(command.name))
      throw new Error('Not a local authoring command')
    if (this.host.hostId !== LOCAL_HOST_ID || command.instance)
      return agentFailure(
        'local-authoring',
        'Run authoring on the local machine without --instance',
        64,
      )
    try {
      if (command.name === 'skill' && !command.flags['output']) {
        const read = await this.host.readTextFilePrefix(
          joinHostPath(this.assets, 'SKILL.md'),
          16 * 1024,
        )
        if (!read.complete || read.validUtf8 === false)
          throw new Error('Installed skill is invalid')
        return agentOutput({ skill: read.content, extensionContract: EXTENSION_CONTRACT })
      }
      const selected = command.flags[command.name === 'validate' ? 'path' : 'output']
      if (
        !selected ||
        !selected.startsWith('/') ||
        selected.includes('\0') ||
        selected.length > 4096
      )
        throw new Error(
          'Select an explicit absolute local --path or --output destination',
        )
      const destination = localPath(selected)
      const store = new ExtensionPackageStore(this.host, this.assets)
      if (command.name === 'validate') {
        const revision = await store.captureSource(destination)
        return agentOutput({
          validation: {
            id: revision.manifest.id,
            contract: revision.manifest.contract,
            revision: revision.hash,
            kind: revision.kind,
            warnings: revision.warnings,
          },
          extensionContract: EXTENSION_CONTRACT,
        })
      }
      if (!this.host.extensionStorage)
        throw new Error('Local extension storage is unavailable')
      const files =
        command.name === 'scaffold'
          ? (await store.captureSource(joinHostPath(this.assets, 'clock'))).files
          : new Map([
              [
                'SKILL.md',
                await this.host.readFile(joinHostPath(this.assets, 'SKILL.md')),
              ],
            ])
      await this.host.extensionStorage.materializeAuthoring(
        destination,
        files,
        command.name === 'scaffold' ? 'directory' : 'file',
      )
      return agentOutput({
        authoring: { destination, kind: command.name, enabled: false },
        extensionContract: EXTENSION_CONTRACT,
      })
    } catch (reason) {
      return agentFailure(
        'authoring-refused',
        reason instanceof Error ? reason.message : 'Local authoring was refused',
        64,
      )
    }
  }
}
