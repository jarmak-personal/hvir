import { randomUUID } from 'node:crypto'
import { type HostPath } from '../../shared/host-path'
import { EXTENSION_LIMITS } from '../../shared/extensions/contract'
import {
  extensionId,
  extensionObject,
  extensionText,
} from '../../shared/extensions/validation'
import {
  CONNECTOR_LIMITS,
  connectorArguments,
  type ExtensionConnectorApproval,
  type ExtensionConnectorResult,
  type ExtensionConnectorOutput,
} from '../../shared/extensions/connectors'
import type { ExtensionActivation } from './activation'
import type { AdmittedExtensionContext } from './context-owner'
import {
  canonicalExecutablePath,
  type ExtensionConnectorApprovalOwner,
} from './connector-approval'

export interface ConnectorCaller {
  readonly activation: ExtensionActivation
  readonly view: string
  readonly action?: string
  readonly signal: AbortSignal
  readonly current: () => void
  readonly context: (
    workspace: string | undefined,
  ) => AdmittedExtensionContext | undefined
  readonly demand: (workspace: string | undefined) => boolean
}
interface Consumer {
  readonly caller: ConnectorCaller
  readonly approval: ExtensionConnectorApproval
  readonly workspace?: string
  readonly context?: AdmittedExtensionContext
  readonly resolve: (value: ExtensionConnectorResult) => void
  readonly aborted: () => void
}
interface Execution {
  readonly activation: ExtensionActivation
  readonly approval: ExtensionConnectorApproval
  readonly controller: AbortController
  readonly consumers: Set<Consumer>
  readonly host: string
  readonly source?: string
  readonly deadline: ReturnType<typeof setTimeout>
  reason?: ExtensionConnectorResult['reason']
}
interface Admission {
  readonly caller: ConnectorCaller
  readonly approval: ExtensionConnectorApproval
  readonly controller: AbortController
  readonly workspace?: string
}
interface OutputReceipt {
  readonly consumer: Consumer
  readonly result: ExtensionConnectorResult
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly timer: ReturnType<typeof setTimeout>
}

/** Finite native admission and truthful outcomes; ProjectHost owns process/transport mechanics. */
export class ExtensionConnectorExecutionOwner {
  private readonly admissions = new Set<Admission>()
  private readonly executions = new Set<Execution>()
  private readonly receipts = new Map<string, OutputReceipt>()
  private readonly sources = new Map<string, { started: number; execution?: Execution }>()
  private disposed = false
  private readonly stopHosts: () => void
  constructor(
    readonly approvals: ExtensionConnectorApprovalOwner,
    private readonly scratch: HostPath,
    private readonly writable: () => Promise<void>,
  ) {
    this.stopHosts = approvals.hosts.onHostStateChange(() => this.revalidate())
  }

  async execute(
    caller: ConnectorCaller,
    value: unknown,
  ): Promise<ExtensionConnectorResult> {
    const input = extensionObject(value),
      connector = extensionId(input['connector'])
    const hostId = extensionText(input['host'], 'connector host', 128)
    const args = connectorArguments(input['args'])
    const workspace =
      input['workspace'] === undefined
        ? undefined
        : extensionText(input['workspace'], 'workspace identity', 128)
    const approval = this.approvals.get(caller.activation, connector)
    const unavailable = (
      reason: ExtensionConnectorResult['reason'],
      host = approval?.host ?? '',
    ) => emptyResult(host, 'not-started', reason)
    if (!approval) return unavailable('unapproved')
    if (hostId !== approval.host) return unavailable('unavailable')
    const host = this.approvals.hosts.hostById(approval.host)
    if (!host || host.connectionState !== 'connected') return unavailable('disconnected')
    if (!host.finiteExec) return unavailable('unavailable')
    if (!this.consumerCapacity(caller.activation, approval.declaration.outputBytes))
      return unavailable('capacity')
    let context: AdmittedExtensionContext | undefined
    const prepared = await this.admit(caller, approval, workspace, async (signal) => {
      try {
        await this.writable()
        caller.current()
        signal.throwIfAborted()
        if (this.disposed || !this.approvals.current(caller.activation, approval))
          return unavailable('unapproved')
        if (approval.declaration.context === 'application') {
          if (workspace || approval.host !== this.scratch.hostId)
            return unavailable('unavailable')
        } else {
          context = caller.context(workspace)
          if (
            !workspace ||
            !context?.root ||
            context.root.hostId !== approval.host ||
            !context.current()
          )
            return unavailable('unavailable')
        }
        if (!caller.action && !caller.demand(workspace))
          return unavailable('context-ended')
        if (
          (await canonicalExecutablePath(host, approval.executable)) !==
          approval.canonicalExecutable
        )
          return unavailable('unapproved')
        caller.current()
        signal.throwIfAborted()
        if (
          !this.approvals.current(caller.activation, approval) ||
          (context && !context.current()) ||
          (!caller.action && !caller.demand(workspace))
        )
          return unavailable('context-ended')
      } catch {
        return unavailable('context-ended')
      }
      return undefined
    })
    if (prepared) return prepared
    const cwd = context?.root ?? this.scratch
    const source = caller.action
      ? undefined
      : JSON.stringify([caller.activation.generation, approval, cwd, args])
    this.pruneSources()
    const existing = source ? this.sources.get(source) : undefined
    if (!this.consumerCapacity(caller.activation, approval.declaration.outputBytes))
      return unavailable('capacity')
    if (existing?.execution)
      return this.join(existing.execution, caller, workspace, context)
    if (existing && Date.now() - existing.started < CONNECTOR_LIMITS.refreshIntervalMs)
      return unavailable('frequency')
    if (source && !existing && this.sources.size >= CONNECTOR_LIMITS.sources)
      return unavailable('capacity')
    if (
      this.executions.size >= CONNECTOR_LIMITS.concurrent ||
      [...this.executions].filter(
        (entry) => entry.activation.installationId === caller.activation.installationId,
      ).length >= CONNECTOR_LIMITS.perExtension
    )
      return unavailable('capacity')
    const controller = new AbortController()
    const task = host.finiteExec.tryExec(
      approval.canonicalExecutable,
      [...approval.configuration.args, ...args],
      {
        cwd,
        env: { ...approval.configuration.env },
        signal: controller.signal,
        maxBuffer: approval.declaration.outputBytes,
        allowTruncatedOutput: true,
      },
    )
    if (!task) return unavailable('capacity')
    const execution: Execution = {
      activation: caller.activation,
      approval,
      controller,
      consumers: new Set(),
      host: host.hostId,
      ...(source ? { source } : {}),
      deadline: setTimeout(
        () => this.interrupt(execution, 'deadline'),
        approval.declaration.timeoutMs,
      ),
    }
    this.executions.add(execution)
    if (source) this.sources.set(source, { started: Date.now(), execution })
    const result = this.join(execution, caller, workspace, context)
    // Dispatch is the conservative boundary: even a rejected exec can have native effects.
    void task
      .then(
        (value) => {
          const limit = approval.declaration.outputBytes
          const stdout = boundedBytes(value.stdout, limit)
          const stderr = boundedBytes(value.stderr, limit - stdout.length)
          const truncated =
            value.outputTruncated === true ||
            Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) > limit
          const outcome =
            controller.signal.aborted ||
            truncated ||
            value.code === null ||
            value.signal !== null
              ? 'interrupted-uncertain'
              : 'completed'
          this.complete(
            execution,
            {
              outcome,
              host: host.hostId,
              code: value.code,
              signal: value.signal,
              truncated,
              ...(truncated ? { reason: 'output-limit' as const } : {}),
              stdoutBytes: stdout.length,
              stderrBytes: stderr.length,
            },
            stdout,
            stderr,
          )
        },
        () =>
          this.complete(
            execution,
            emptyResult(
              host.hostId,
              'interrupted-uncertain',
              execution.reason ?? 'transport',
            ),
            Buffer.alloc(0),
            Buffer.alloc(0),
          ),
      )
      .finally(() => {
        clearTimeout(execution.deadline)
        this.executions.delete(execution)
        if (source && this.sources.get(source)?.execution === execution)
          this.sources.set(source, { started: this.sources.get(source)!.started })
      })
    return result
  }

  output(caller: ConnectorCaller, value: unknown): ExtensionConnectorOutput | null {
    const input = extensionObject(value)
    if (typeof input['receipt'] !== 'string')
      throw new Error('Invalid connector output receipt')
    const receipt = this.receipts.get(input['receipt'])
    if (
      !receipt ||
      receipt.consumer.caller.view !== caller.view ||
      receipt.consumer.caller.activation !== caller.activation ||
      receipt.consumer.caller.action !== caller.action
    )
      throw new Error('Connector output receipt is stale or belongs to another caller')
    caller.current()
    caller.signal.throwIfAborted()
    if (!this.valid(receipt.consumer)) {
      this.release(input['receipt'])
      throw new Error('Connector output context ended')
    }
    if (input['release'] === true) {
      this.release(input['receipt'])
      return null
    }
    if (
      !['stdout', 'stderr'].includes(input['stream'] as string) ||
      !Number.isSafeInteger(input['offset']) ||
      (input['offset'] as number) < 0
    )
      throw new Error('Invalid connector output page')
    const buffer = input['stream'] === 'stdout' ? receipt.stdout : receipt.stderr
    const offset = input['offset'] as number
    if (
      offset > buffer.length ||
      (offset < buffer.length && (buffer[offset]! & 0xc0) === 0x80)
    )
      throw new Error('Invalid UTF-8 output offset')
    let end = Math.min(buffer.length, offset + CONNECTOR_LIMITS.pageBytes)
    while (end > offset && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--
    let output: ExtensionConnectorOutput
    do {
      output = {
        data: buffer.subarray(offset, end).toString('utf8'),
        nextOffset: end < buffer.length ? end : null,
        result: receipt.result,
      }
      if (
        Buffer.byteLength(
          JSON.stringify({
            kind: 'result',
            id: 'x'.repeat(80),
            ok: true,
            value: output,
            warnings: Array(EXTENSION_LIMITS.warnings).fill(
              'Ignored unknown field: ' + 'x'.repeat(80),
            ),
          }),
        ) <= EXTENSION_LIMITS.messageBytes
      )
        break
      end = offset + Math.floor((end - offset) / 2)
      while (end > offset && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--
    } while (end > offset)
    return output
  }

  revalidate(): void {
    for (const admission of this.admissions) {
      try {
        admission.caller.current()
        if (
          !this.approvals.current(admission.caller.activation, admission.approval) ||
          (!admission.caller.action && !admission.caller.demand(admission.workspace))
        )
          admission.controller.abort()
      } catch {
        admission.controller.abort()
      }
    }
    for (const execution of this.executions) {
      for (const consumer of execution.consumers)
        if (!this.valid(consumer)) this.endConsumer(execution, consumer, 'context-ended')
      if (!execution.consumers.size) this.interrupt(execution, 'context-ended')
    }
    for (const [id, receipt] of this.receipts)
      if (!this.valid(receipt.consumer)) this.release(id)
  }
  revoke(installation: string, connector?: string): void {
    for (const admission of this.admissions)
      if (
        admission.caller.activation.installationId === installation &&
        (!connector || admission.approval.connector === connector)
      )
        admission.controller.abort()
    for (const execution of this.executions)
      if (
        execution.activation.installationId === installation &&
        (!connector || execution.approval.connector === connector)
      )
        this.interrupt(execution, 'context-ended')
    for (const [id, receipt] of this.receipts)
      if (
        receipt.consumer.caller.activation.installationId === installation &&
        (!connector || receipt.consumer.approval.connector === connector)
      )
        this.release(id)
  }
  dispose(): void {
    this.disposed = true
    this.stopHosts()
    for (const admission of this.admissions) admission.controller.abort()
    for (const execution of this.executions) this.interrupt(execution, 'interrupted')
    for (const id of this.receipts.keys()) this.release(id)
    this.sources.clear()
  }
  private async admit(
    caller: ConnectorCaller,
    approval: ExtensionConnectorApproval,
    workspace: string | undefined,
    operation: (signal: AbortSignal) => Promise<ExtensionConnectorResult | undefined>,
  ): Promise<ExtensionConnectorResult | undefined> {
    const controller = new AbortController()
    const admission: Admission = {
      caller,
      approval,
      controller,
      ...(workspace ? { workspace } : {}),
    }
    this.admissions.add(admission)
    const signal = AbortSignal.any([caller.signal, controller.signal])
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, EXTENSION_LIMITS.requestTimeoutMs)
    let stop!: () => void
    const cancelled = new Promise<ExtensionConnectorResult>((resolve) => {
      stop = () =>
        resolve(
          emptyResult(
            approval.host,
            'not-started',
            timedOut ? 'deadline' : 'context-ended',
          ),
        )
      signal.addEventListener('abort', stop, { once: true })
      if (signal.aborted) stop()
    })
    const task = operation(signal).finally(() => this.admissions.delete(admission))
    try {
      return await Promise.race([task, cancelled])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
    }
  }

  private join(
    execution: Execution,
    caller: ConnectorCaller,
    workspace?: string,
    context?: AdmittedExtensionContext,
  ): Promise<ExtensionConnectorResult> {
    return new Promise((resolve) => {
      const consumer: Consumer = {
        caller,
        approval: execution.approval,
        ...(workspace ? { workspace } : {}),
        ...(context ? { context } : {}),
        resolve,
        aborted: () => this.endConsumer(execution, consumer, 'interrupted'),
      }
      execution.consumers.add(consumer)
      caller.signal.addEventListener('abort', consumer.aborted, { once: true })
      if (caller.signal.aborted) consumer.aborted()
    })
  }
  private valid(consumer: Consumer): boolean {
    try {
      consumer.caller.current()
      return (
        !this.disposed &&
        !consumer.caller.signal.aborted &&
        this.approvals.current(consumer.caller.activation, consumer.approval) &&
        (!consumer.context || consumer.context.current()) &&
        (!!consumer.caller.action || consumer.caller.demand(consumer.workspace))
      )
    } catch {
      return false
    }
  }
  private complete(
    execution: Execution,
    result: ExtensionConnectorResult,
    stdout: Buffer,
    stderr: Buffer,
  ): void {
    for (const consumer of [...execution.consumers]) {
      if (!this.valid(consumer)) {
        this.endConsumer(execution, consumer, 'context-ended')
        continue
      }
      execution.consumers.delete(consumer)
      consumer.caller.signal.removeEventListener('abort', consumer.aborted)
      const id = randomUUID(),
        value = { ...result, receipt: id }
      const receipt: OutputReceipt = {
        consumer,
        result: value,
        stdout,
        stderr,
        timer: setTimeout(() => this.release(id), CONNECTOR_LIMITS.retentionMs),
      }
      this.receipts.set(id, receipt)
      consumer.resolve(value)
    }
  }
  private endConsumer(
    execution: Execution,
    consumer: Consumer,
    reason: ExtensionConnectorResult['reason'],
  ): void {
    if (!execution.consumers.delete(consumer)) return
    consumer.caller.signal.removeEventListener('abort', consumer.aborted)
    consumer.resolve(emptyResult(execution.host, 'interrupted-uncertain', reason))
    if (!execution.consumers.size) {
      execution.reason = reason
      clearTimeout(execution.deadline)
      execution.controller.abort()
    }
  }
  private interrupt(
    execution: Execution,
    reason: ExtensionConnectorResult['reason'],
  ): void {
    execution.reason = reason
    clearTimeout(execution.deadline)
    for (const consumer of [...execution.consumers])
      this.endConsumer(execution, consumer, reason)
    execution.controller.abort()
  }
  private release(id: string): void {
    const receipt = this.receipts.get(id)
    if (receipt) clearTimeout(receipt.timer)
    this.receipts.delete(id)
  }
  private consumerCapacity(activation: ExtensionActivation, bytes: number): boolean {
    const admitted = [...this.admissions]
    const pending = [...this.executions].flatMap((entry) => [...entry.consumers])
    const retained = [...this.receipts.values()]
    const count =
      pending.filter(
        (entry) => entry.caller.activation.installationId === activation.installationId,
      ).length +
      admitted.filter(
        (entry) => entry.caller.activation.installationId === activation.installationId,
      ).length +
      retained.filter(
        (entry) =>
          entry.consumer.caller.activation.installationId === activation.installationId,
      ).length
    const reserved =
      admitted.reduce((sum, entry) => sum + entry.approval.declaration.outputBytes, 0) +
      [...this.executions].reduce(
        (sum, entry) =>
          sum +
          entry.approval.declaration.outputBytes * Math.max(1, entry.consumers.size),
        0,
      ) +
      retained.reduce((sum, entry) => sum + entry.stdout.length + entry.stderr.length, 0)
    return (
      count < CONNECTOR_LIMITS.perExtension &&
      admitted.length + pending.length + retained.length < CONNECTOR_LIMITS.receipts &&
      reserved + bytes <= CONNECTOR_LIMITS.receiptBytes
    )
  }
  private pruneSources(): void {
    for (const [key, value] of this.sources)
      if (
        !value.execution &&
        Date.now() - value.started >= CONNECTOR_LIMITS.refreshIntervalMs
      )
        this.sources.delete(key)
  }
}
function emptyResult(
  host: string,
  outcome: ExtensionConnectorResult['outcome'],
  reason?: ExtensionConnectorResult['reason'],
): ExtensionConnectorResult {
  return {
    outcome,
    host,
    code: null,
    signal: null,
    truncated: false,
    ...(reason ? { reason } : {}),
    stdoutBytes: 0,
    stderrBytes: 0,
  }
}
function boundedBytes(value: string, maximum: number): Buffer {
  const prefix = value.slice(0, maximum)
  const buffer = Buffer.from(prefix, 'utf8')
  let end = Math.min(buffer.length, maximum)
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--
  return buffer.subarray(0, end)
}
