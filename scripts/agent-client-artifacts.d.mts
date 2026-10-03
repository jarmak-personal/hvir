export const AGENT_CLIENT_TARGETS: readonly string[]
export interface AgentClientManifest {
  readonly contract: string
  readonly source: string
  readonly clients: Readonly<
    Record<
      string,
      { sha256: string; bytes: number; buildSha256: string; signed: boolean }
    >
  >
}
export function agentClientManifest(
  directory: string,
  source: string,
  signed?: boolean,
): Promise<AgentClientManifest>
