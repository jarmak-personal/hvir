import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import type {
  AgentAccessState,
  AgentForwardGrant,
  AgentSettings,
  AgentReport,
  AgentReportSummary,
  AgentDocumentPresentation,
} from '../agent/contract'
/** Trusted workbench presentation/settings only. The public socket never invokes these channels. */
export const agentIpc = {
  invoke: {
    'agent:access': invoke<void, AgentAccessState>(),
    'agent:configure': invoke<AgentSettings, AgentAccessState>(),
    'agent:extension-configure': invoke<
      { readonly installation: string; readonly enabled: boolean },
      AgentAccessState
    >(),
    'agent:forward-grant': invoke<
      { readonly grant: AgentForwardGrant; readonly enabled: boolean },
      AgentAccessState
    >(),
    'agent:decide': invoke<{ readonly id: string; readonly accept: boolean }, void>(),
    'agent:reports': invoke<void, readonly AgentReportSummary[]>(),
    'agent:report-read': invoke<{ readonly id: string }, AgentReport>(),
    'agent:report-viewed': invoke<
      { readonly id: string; readonly version: number },
      void
    >(),
    'agent:report-close': invoke<{ readonly id: string }, void>(),
  },
  send: {},
  event: {
    'agent:access-changed': payload<AgentAccessState>(),
    'agent:reports-changed': payload<readonly AgentReportSummary[]>(),
    'agent:document-opened': payload<AgentDocumentPresentation>(),
  },
} satisfies IpcFeatureContract
