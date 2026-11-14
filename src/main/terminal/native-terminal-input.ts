import {
  NativeTerminalCaretPending,
  NativeTerminalInputPhysicalFailure,
  NATIVE_INPUT_RESULTS,
  nativeTerminalInputResultCapacity,
  validNativeTerminalInput,
  type NativeTerminalInputCompletion,
  type NativeTerminalInputOperation,
  type NativeTerminalKeyEncodingFallback,
} from '../../shared/native-terminal-input'
import { NativeTerminalInputResultCredits } from '../../shared/native-terminal-input-admission'
import {
  NativeTerminalAdmissionError,
  NATIVE_TERMINAL_LIMITS,
} from '../../shared/native-terminal'
import type { NativeTerminalHost } from './native-terminal-host'
import type { PtyTerminalInputPrefix } from '../pty/pty-contract'
import { PtyWriteConfirmedRevokedError } from '../project-host/project-host'
import {
  providerComposerEncoding,
  type ProviderComposerKeyboardPolicy,
} from '../../shared/composer-submit'

/** Stored in the Application's existing view resource, never a second view registry. */
export interface NativeTerminalInputState {
  active?: Promise<NativeTerminalInputCompletion>
  /** This operation can append no more bytes; not a transport confirmation. */
  appended?: Promise<void>
  cleanup?: Promise<void>
  revoked: boolean
}
export interface NativeTerminalInputContext {
  readonly handle: string
  readonly instanceId: string
  readonly geometrySerial: number
  readonly state: NativeTerminalInputState
  readonly readOnly: boolean
  readonly policy?: ProviderComposerKeyboardPolicy
  readonly selectionContext?: import('../../shared/native-terminal-selection').NativeTerminalSelectionContext
  inputSettled(): Promise<void> | undefined
  retainInput(pending: Promise<unknown>): void
  assertCurrent(): void
  prefix(): PtyTerminalInputPrefix
  writeUser(bytes: Uint8Array): Promise<void>
  writeControl(bytes: Uint8Array): Promise<void>
  blockInput(): void
}

interface InputCompletionOptions {
  captured?: boolean
  fallback?: NativeTerminalKeyEncodingFallback
  retainIndeterminate?: () => void
  appended?: () => void
}
/** Input effects share native state and PTY authority; this owner owns no PTY queue. */
export class NativeTerminalInput {
  private focused?: NativeTerminalInputContext
  private focusRevision = 0
  private readonly resultCredits = new NativeTerminalInputResultCredits()
  constructor(
    private readonly host: Pick<NativeTerminalHost, 'input' | 'inspectProducer'>,
  ) {}

  dispatch(
    context: NativeTerminalInputContext,
    input: NativeTerminalInputOperation,
  ): Promise<NativeTerminalInputCompletion> {
    if (!validNativeTerminalInput(input))
      return Promise.reject(new Error('native-input-invalid'))
    if (
      context.state.revoked &&
      !(context.readOnly && ['wheel', 'pointer', 'caret'].includes(input.kind))
    )
      return Promise.reject(new Error('native-view-stale'))
    if (context.state.active || context.state.cleanup)
      return Promise.reject(new NativeTerminalAdmissionError('native-input-busy'))
    context.assertCurrent()
    const needsFocus =
      input.kind === 'key' || input.kind === 'paste' || input.kind === 'preedit'
    if (needsFocus && this.focused?.state !== context.state)
      throw new Error('native-view-unfocused')
    const prefix = context.prefix()
    const previousInput = context.inputSettled()
    const credit = this.resultCredits.reserve(
      nativeTerminalInputResultCapacity(input, context.readOnly, (text) =>
        Buffer.byteLength(text),
      ),
      input.kind === 'paste',
    )
    let held = false
    const policy =
      input.kind === 'key' && context.policy
        ? providerComposerEncoding(
            {
              code: input.key === 58 ? 'Enter' : input.key === 120 ? 'Escape' : '',
              shiftKey: !!(input.modifiers & 1),
              ctrlKey: !!(input.modifiers & 2),
              altKey: !!(input.modifiers & 4),
              metaKey: !!(input.modifiers & 8),
            },
            context.policy,
          )
        : undefined
    if (input.kind === 'key' && policy?.controlAlias)
      input = { ...input, modifiers: (input.modifiers & ~8) | 2 }
    const focusing = input.kind === 'focus' && input.focused
    const previous = focusing ? this.focused : undefined
    if (focusing) {
      this.focused = context
      this.focusRevision++
    }
    const focusRevision = this.focusRevision
    const assertCurrent = () => {
      context.assertCurrent()
      if (
        needsFocus &&
        (this.focused?.state !== context.state || this.focusRevision !== focusRevision)
      )
        throw new Error('native-view-unfocused')
      if (focusing && this.focused?.state !== context.state)
        throw new Error('native-focus-stale')
    }
    const qualified = { ...context, assertCurrent }
    let appended!: () => void
    const appendDecision = new Promise<void>((resolve) => {
      appended = resolve
    })
    context.state.appended = appendDecision
    const operation = (async () => {
      if (previousInput) await previousInput
      assertCurrent()
      if (previous && previous.state !== context.state) {
        if (
          previous.instanceId === context.instanceId &&
          previous.handle === context.handle
        ) {
          await previous.state.active?.catch(() => undefined)
          assertCurrent()
          await this.blur(previous)
        } else void this.blur(previous).catch(() => undefined)
      }
      assertCurrent()
      const result = await this.perform(
        qualified,
        input,
        {
          parsed: async (signal) => {
            await prefix.parsed(signal)
            assertCurrent()
          },
          replies: async (signal) => {
            await prefix.replies(signal)
            assertCurrent()
          },
        },
        {
          fallback: policy?.fallback,
          retainIndeterminate: () => {
            held = true
            context.state.revoked = true
            context.blockInput()
          },
          appended,
        },
      )
      assertCurrent()
      if (
        input.kind === 'focus' &&
        !input.focused &&
        this.focused?.state === context.state
      )
        this.focused = undefined
      return result
    })()
    context.state.active = operation
    void operation
      .finally(() => {
        appended()
        if (context.state.appended === appendDecision) context.state.appended = undefined
        if (context.state.active === operation) context.state.active = undefined
        if (!held) credit.release()
      })
      .catch(() => undefined)
    context.retainInput(operation)
    return operation
  }

  /** Captured old-instance cleanup remains valid after logical hide/revocation. */
  blur(context: NativeTerminalInputContext): Promise<void> {
    if (context.state.cleanup) return context.state.cleanup
    const prefix = context.prefix()
    const credit = this.resultCredits.reserve(
      NATIVE_INPUT_RESULTS.ordinaryBytes,
      false,
      true,
    )
    let held = false
    const retain = () => {
      held = true
      context.state.revoked = true
      context.blockInput()
    }
    const cleanup = (async () => {
      await context.state.appended
      await this.perform(context, { kind: 'preedit', text: null }, prefix, {
        captured: true,
        retainIndeterminate: retain,
      })
      await this.perform(context, { kind: 'focus', focused: false }, prefix, {
        captured: true,
        retainIndeterminate: retain,
      })
      if (this.focused?.state === context.state) this.focused = undefined
    })()
    context.state.cleanup = cleanup
    void cleanup
      .finally(() => {
        if (context.state.cleanup === cleanup) context.state.cleanup = undefined
        if (!held) credit.release()
      })
      .catch(() => undefined)
    context.retainInput(cleanup)
    return cleanup
  }

  revoke(context: NativeTerminalInputContext): Promise<void> {
    context.state.revoked = true
    return this.blur(context)
  }

  private async perform(
    context: NativeTerminalInputContext,
    input: NativeTerminalInputOperation,
    prefix?: PtyTerminalInputPrefix,
    options: InputCompletionOptions = {},
  ): Promise<NativeTerminalInputCompletion> {
    const deadline = Date.now() + NATIVE_TERMINAL_LIMITS.requestMs
    let result
    for (;;) {
      try {
        result = await this.host.input(
          context.handle,
          context.instanceId,
          input,
          prefix?.parsed,
          context.readOnly,
          options.fallback,
          context.selectionContext,
        )
        break
      } catch (error) {
        if (error instanceof NativeTerminalInputPhysicalFailure)
          options.retainIndeterminate?.()
        if (
          !(
            error instanceof NativeTerminalAdmissionError ||
            error instanceof NativeTerminalCaretPending
          ) ||
          Date.now() >= deadline
        )
          throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
      }
    }
    const admittedCapacity = nativeTerminalInputResultCapacity(
      input,
      context.readOnly,
      (text) => Buffer.byteLength(text),
    )
    if (result.capacity > admittedCapacity)
      throw new Error('native-input-capacity-invalid')
    // Native-applied is independent of renderer occlusion and GPU lease release.
    while (result.requestedMutation) {
      const status = await this.retryInspect(context, deadline)
      if (status.inputFailure && !options.captured && !context.readOnly)
        throw new Error('native-input-unavailable')
      if (status.ioAppliedMutation >= result.requestedMutation) break
      if (Date.now() >= deadline) throw new Error('native-input-apply-timeout')
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    if (prefix) {
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), Math.max(0, deadline - Date.now()))
      try {
        await prefix.replies(abort.signal)
      } finally {
        clearTimeout(timer)
      }
    }
    if (prefix && !options.captured) context.assertCurrent()
    const bytes = result.bytes
    if (bytes.byteLength) {
      if (context.readOnly && result.source === 'user')
        throw new Error('native-readonly-input-emitted')
      if (result.source === 'user') {
        context.assertCurrent()
        try {
          const writing = context.writeUser(bytes)
          options.appended?.()
          await writing
        } catch (error) {
          if (!(error instanceof PtyWriteConfirmedRevokedError))
            options.retainIndeterminate?.()
          throw error
        }
      } else {
        try {
          const writing = context.writeControl(bytes)
          options.appended?.()
          await writing
        } catch (error) {
          if (!(error instanceof PtyWriteConfirmedRevokedError))
            options.retainIndeterminate?.()
          throw error
        }
      }
    }
    options.appended?.()
    const caret =
      result.caret?.geometrySerial === context.geometrySerial ? result.caret : undefined
    return {
      requestedMutation: result.requestedMutation,
      ...(caret ? { caret } : {}),
      ...(result.captured === undefined ? {} : { captured: result.captured }),
      ...(result.hasSelection === undefined
        ? {}
        : { hasSelection: result.hasSelection, selectionSerial: result.selectionSerial }),
      ...(result.selectionResult === undefined
        ? {}
        : { selectionResult: result.selectionResult }),
      ...(result.linkCandidate === undefined
        ? {}
        : { linkCandidate: result.linkCandidate }),
    }
  }
  private async retryInspect(context: NativeTerminalInputContext, deadline: number) {
    for (;;) {
      try {
        return await this.host.inspectProducer(context.handle, context.instanceId)
      } catch (error) {
        if (!(error instanceof NativeTerminalAdmissionError) || Date.now() >= deadline)
          throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
      }
    }
  }
}
