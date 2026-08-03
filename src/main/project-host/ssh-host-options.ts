import type { Client } from 'ssh2'

import type { SshAuthPrompter } from './ssh-auth'
import type { SshAliasConfig } from './ssh-config'

export interface SshIdentity {
  readonly path: string
  readonly privateKey: Buffer | string
}

export interface SshHostOptions {
  readonly config: SshAliasConfig
  readonly identities?: readonly SshIdentity[]
  readonly agentSocket?: string
  readonly prompter: SshAuthPrompter
  readonly pollIntervalMs?: number
  /** Slower snapshot safety net when inotify stays alive but emits no usable events. */
  readonly watchdogIntervalMs?: number
  /** Lightweight cache/tree refresh cadence, independent of recursive snapshots. */
  readonly refreshPulseIntervalMs?: number
  /** Idle delay between bounded recursive safety-scan cycles. */
  readonly slowScanIntervalMs?: number
  /** Maximum adaptive idle delay between unchanged safety-scan cycles. */
  readonly maxSlowScanIntervalMs?: number
  /** Maximum directories enumerated in one polling tick. */
  readonly pollDirectoryBatchSize?: number
  /** Local window for catching multiple writes hidden by SFTP's second-level mtime. */
  readonly fingerprintObservationWindowMs?: number
  /**
   * Maximum short-lived buffered exec channels. Long-lived PTY, watcher, and
   * telemetry channels plus SFTP share the control transport budget. The
   * default admits bounded parallel Git/filesystem reads while pool admission
   * still protects every transport's reserved capacity.
   */
  readonly maxConcurrentExecs?: number
  readonly trustedHostKey?: () => string | undefined
  readonly rememberHostKey?: (fingerprint: string) => Promise<void>
  /** Test seam for transport lifecycle races; production always constructs ssh2.Client. */
  readonly clientFactory?: () => Client
}
