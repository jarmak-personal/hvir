import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import type { HostConnectionState, HostWatchTier } from '../src/shared/index.ts'
import type { SshTransportDiagnostic } from '../src/main/project-host/ssh-host.ts'

export const REAL_HOST_SSH_ENVIRONMENT_KEYS = [
  'HVIR_REAL_SSH_HOST',
  'HVIR_REAL_SSH_PORT',
  'HVIR_REAL_SSH_USER',
  'HVIR_REAL_SSH_HOST_KEY',
  'HVIR_REAL_SSH_ROOT_PARENT',
  'HVIR_REAL_SSH_PRIVATE_KEY',
  'HVIR_REAL_SSH_IDENTITY_FILE',
  'HVIR_REAL_SSH_PASSPHRASE',
] as const

export const REAL_HOST_SSH_PHASES = [
  'configuration',
  'credentials-loaded',
  'connected',
  'root-registered',
  'exec',
  'sftp',
  'watch',
  'pty-provider-observation',
  'loopback-stream',
  'transport-capacity',
  'reconnected',
  'cleanup',
] as const

export type RealHostSshPhase = (typeof REAL_HOST_SSH_PHASES)[number]

export interface RealHostSshConfiguration {
  readonly alias: 'real-host-acceptance'
  readonly hostname: string
  readonly port: number
  readonly user: string
  readonly trustedHostKey: string
  readonly rootParent: string
  readonly credential:
    { readonly kind: 'inline' } | { readonly kind: 'file'; readonly path: string }
  readonly hasPassphrase: boolean
}

export type RealHostSshConfigurationResult =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'invalid'; readonly fields: readonly string[] }
  | { readonly kind: 'configured'; readonly value: RealHostSshConfiguration }

export interface RealHostSshResourceEvidence {
  readonly rootRegistered: boolean
  readonly watcherActive: boolean
  readonly ptyCount: number
  readonly providerObserverActive: boolean
  readonly loopbackActive: boolean
  readonly streamCount: number
}

export interface RealHostSshFailureEvidence {
  readonly schema: 1
  readonly status: 'failed'
  readonly phase: RealHostSshPhase
  readonly durationMs: number
  readonly connection: {
    readonly state: HostConnectionState
    readonly watchTier: HostWatchTier
  }
  readonly resources: RealHostSshResourceEvidence
  readonly transports: readonly {
    readonly role: SshTransportDiagnostic['role']
    readonly primary: boolean
    readonly channels: number
    readonly pendingChannels: number
    readonly channelBudget: number
    readonly refusedChannels: number
  }[]
}

const HOST_KEY = /^SHA256:[A-Za-z0-9+/]{43}$/
const MAX_ARTIFACT_BYTES = 4_096

export function readRealHostSshConfiguration(
  environment: NodeJS.ProcessEnv,
): RealHostSshConfigurationResult {
  const present = REAL_HOST_SSH_ENVIRONMENT_KEYS.filter((key) =>
    hasValue(environment[key]),
  )
  if (present.length === 0) return { kind: 'unavailable' }

  const fields: string[] = []
  const hostname = trimmed(environment.HVIR_REAL_SSH_HOST)
  const rawPort = trimmed(environment.HVIR_REAL_SSH_PORT)
  const user = trimmed(environment.HVIR_REAL_SSH_USER)
  const trustedHostKey = trimmed(environment.HVIR_REAL_SSH_HOST_KEY)
  const rootParent = trimmed(environment.HVIR_REAL_SSH_ROOT_PARENT)
  const inlineKey = hasValue(environment.HVIR_REAL_SSH_PRIVATE_KEY)
  const identityFile = trimmed(environment.HVIR_REAL_SSH_IDENTITY_FILE)

  if (!validName(hostname, 253)) fields.push('HVIR_REAL_SSH_HOST')
  const port = Number(rawPort)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    fields.push('HVIR_REAL_SSH_PORT')
  }
  if (!validName(user, 128)) fields.push('HVIR_REAL_SSH_USER')
  if (!HOST_KEY.test(trustedHostKey)) fields.push('HVIR_REAL_SSH_HOST_KEY')
  if (!validRemoteRootParent(rootParent)) {
    fields.push('HVIR_REAL_SSH_ROOT_PARENT')
  }
  if (inlineKey === Boolean(identityFile)) {
    fields.push('HVIR_REAL_SSH_PRIVATE_KEY|HVIR_REAL_SSH_IDENTITY_FILE')
  } else if (identityFile && (!isAbsolute(identityFile) || hasControl(identityFile))) {
    fields.push('HVIR_REAL_SSH_IDENTITY_FILE')
  }

  if (fields.length > 0) return { kind: 'invalid', fields }
  return {
    kind: 'configured',
    value: {
      alias: 'real-host-acceptance',
      hostname,
      port,
      user,
      trustedHostKey,
      rootParent,
      credential: inlineKey ? { kind: 'inline' } : { kind: 'file', path: identityFile },
      hasPassphrase: hasValue(environment.HVIR_REAL_SSH_PASSPHRASE),
    },
  }
}

export function createRealHostSshFailureEvidence(options: {
  readonly phase: RealHostSshPhase
  readonly durationMs: number
  readonly connectionState: HostConnectionState
  readonly watchTier: HostWatchTier
  readonly resources: RealHostSshResourceEvidence
  readonly transports: readonly SshTransportDiagnostic[]
}): RealHostSshFailureEvidence {
  return {
    schema: 1,
    status: 'failed',
    phase: options.phase,
    durationMs: boundedDuration(options.durationMs),
    connection: {
      state: options.connectionState,
      watchTier: options.watchTier,
    },
    resources: {
      rootRegistered: options.resources.rootRegistered,
      watcherActive: options.resources.watcherActive,
      ptyCount: boundedCount(options.resources.ptyCount),
      providerObserverActive: options.resources.providerObserverActive,
      loopbackActive: options.resources.loopbackActive,
      streamCount: boundedCount(options.resources.streamCount),
    },
    transports: options.transports.slice(0, 8).map((transport) => ({
      role: transport.role,
      primary: transport.primary,
      channels: boundedCount(transport.channels),
      pendingChannels: boundedCount(transport.pendingChannels),
      channelBudget: boundedCount(transport.channelBudget),
      refusedChannels: boundedCount(transport.refusedChannels),
    })),
  }
}

export async function writeRealHostSshFailureEvidence(
  directory: string | undefined,
  evidence: RealHostSshFailureEvidence,
): Promise<boolean> {
  if (!directory) return false
  await mkdir(directory, { recursive: true })
  const contents = `${JSON.stringify(evidence, null, 2)}\n`
  if (Buffer.byteLength(contents) > MAX_ARTIFACT_BYTES) {
    throw new Error('Real-host SSH evidence exceeded its closed-schema byte bound')
  }
  await writeFile(join(directory, 'real-host-ssh-failure.json'), contents, 'utf8')
  return true
}

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? ''
}

function validName(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && !hasControl(value)
}

function hasControl(value: string): boolean {
  return /[\0\r\n\t]/.test(value)
}

function validRemoteRootParent(value: string): boolean {
  if (!value.startsWith('/') || value === '/' || hasControl(value)) return false
  if (value.endsWith('/') || value.includes('//')) return false
  return value
    .split('/')
    .slice(1)
    .every((segment) => segment !== '.' && segment !== '..')
}

function boundedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0
  return Math.min(value, 1_000)
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(Math.round(value), 86_400_000)
}
