import type {
  NativeTerminalSelectionAction,
  NativeTerminalSelectionResponse,
} from '../../../shared/native-terminal-selection'
import type {
  NativeTerminalInputCompletion,
  NativeTerminalInputOperation,
} from '../../../shared/native-terminal-input'
import { nativeTerminalPhysicalKey } from './native-terminal-key-map'

interface KeyboardLayoutPort {
  getLayoutMap?: () => Promise<ReadonlyMap<string, string>>
  addEventListener?: EventTarget['addEventListener']
  removeEventListener?: EventTarget['removeEventListener']
}
interface DomInputPort {
  input(operation: NativeTerminalInputOperation): Promise<NativeTerminalInputCompletion>
  clipboardPaste(fallback: string): void
  selection?(
    action: NativeTerminalSelectionAction,
    requestId?: string,
  ): Promise<NativeTerminalSelectionResponse>
  copySelection?(): Promise<void>
  activateLink?(x: number, y: number): Promise<void>
  resolveFilePaste?(
    file: File | undefined,
  ): string | undefined | Promise<string | undefined>
  accepted(text: string): void
  failed(message: string): void
  refused(message: string): void
}
type BrowserOperation =
  | NativeTerminalInputOperation
  | { kind: 'clipboard'; fallback: string }
  | { kind: 'selection'; action: NativeTerminalSelectionAction; requestId?: string }
interface PendingInput {
  operation: BrowserOperation
  revision: number
  text?: string
  capture?: number
  captureRevision?: number
  selection?: {
    signal?: AbortSignal
    resolve: (value: NativeTerminalSelectionResponse) => void
    reject: (error: unknown) => void
    release: () => void
  }
}

/** Browser text/gesture transactions only. Native owns pressed keys and terminal modes. */
export class NativeTerminalDomInput {
  readonly textarea = document.createElement('textarea')
  private enabled = false
  private readOnly = false
  private ready = false
  private disposed = false
  private focused = false
  private composing = false
  private deadKey = false
  private revision = 0
  private active = false
  private needsNativeReset = false
  private settled: Promise<void> = Promise.resolve()
  private readonly pending: PendingInput[] = []
  private readonly pressed = new Set<string>()
  private duplicateText?: string
  private clipboardGesture = false
  private pointerRevision = 0
  private pointerRoute?: AbortController
  private pointer?: number
  private captured?: number
  private gesture?: { button: number; x: number; y: number; modifiers: number }
  private caretPending = false
  private geometryRevision = 0
  private caretSerial = 0
  private layout?: ReadonlyMap<string, string>
  private layoutPending = false
  private layoutAgain = false
  private readonly keyboard = (navigator as Navigator & { keyboard?: KeyboardLayoutPort })
    .keyboard
  private readonly abort = new AbortController()

  constructor(
    private readonly root: HTMLElement,
    private readonly port: DomInputPort,
  ) {
    const text = this.textarea
    text.setAttribute('aria-label', 'Terminal input')
    text.setAttribute('autocapitalize', 'off')
    text.setAttribute('autocomplete', 'off')
    text.spellcheck = false
    text.style.cssText =
      'position:absolute;left:0;top:0;width:1px;height:1em;padding:0;border:0;opacity:0;resize:none;z-index:3'
    root.appendChild(text)
    const options = { signal: this.abort.signal }
    root.addEventListener('keydown', this.keydown, options)
    root.addEventListener('keyup', this.keyup, options)
    text.addEventListener('beforeinput', this.beforeinput, options)
    text.addEventListener('input', this.clearText, options)
    text.addEventListener('compositionstart', this.compositionstart, options)
    text.addEventListener('compositionupdate', this.compositionupdate, options)
    text.addEventListener('compositionend', this.compositionend, options)
    root.addEventListener('paste', this.paste, options)
    root.addEventListener('focusin', this.focusin, options)
    root.addEventListener('focusout', this.focusout, options)
    root.addEventListener('pointerdown', this.pointerdown, options)
    root.addEventListener('pointermove', this.pointermove, options)
    root.addEventListener('pointerup', this.pointerup, options)
    root.addEventListener('pointercancel', this.pointercancel, options)
    root.addEventListener('wheel', this.wheel, { ...options, passive: false })
  }
  setEnabled(enabled: boolean): void {
    if (this.enabled && !enabled) this.revoke()
    const changed = this.enabled !== enabled
    this.enabled = enabled
    if (changed && enabled) {
      if (typeof this.keyboard?.addEventListener === 'function')
        this.keyboard.addEventListener('layoutchange', this.refreshLayout)
      this.refreshLayout()
    } else if (changed) {
      if (typeof this.keyboard?.removeEventListener === 'function')
        this.keyboard.removeEventListener('layoutchange', this.refreshLayout)
      this.layout = undefined
    }
    this.textarea.disabled = !enabled
  }
  setReadonly(): void {
    if (this.readOnly) return
    this.revoke()
    this.readOnly = true
    this.textarea.readOnly = true
    this.textarea.disabled = !this.enabled
  }
  setReady(ready: boolean): void {
    if (!ready) this.geometryRevision++
    this.ready = ready
    if (ready) {
      void this.flush()
      if (this.focused) this.caret()
    }
  }
  focus(): void {
    if (!this.disposed) this.textarea.focus({ preventScroll: true })
  }
  dispose(): Promise<void> {
    if (this.disposed) return this.settled
    this.revoke()
    this.disposed = true
    if (typeof this.keyboard?.removeEventListener === 'function')
      this.keyboard.removeEventListener('layoutchange', this.refreshLayout)
    this.layout = undefined
    this.abort.abort()
    this.textarea.remove()
    return this.flush()
  }
  pasteText(text: string): void {
    if (this.enabled && !this.readOnly && text)
      this.enqueue({ kind: 'paste', text }, text)
  }
  selection(
    action: NativeTerminalSelectionAction,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<NativeTerminalSelectionResponse> {
    if (this.disposed || !this.enabled || signal?.aborted || !this.port.selection)
      return Promise.reject(
        new DOMException('Terminal selection unavailable', 'AbortError'),
      )
    return new Promise((resolve, reject) => {
      if (this.pending.length + Number(this.active) >= 30) {
        reject(new Error('Native terminal selection capacity reached'))
        return
      }
      const cancel = () =>
        reject(new DOMException('Terminal selection cancelled', 'AbortError'))
      signal?.addEventListener('abort', cancel, { once: true })
      this.pending.push({
        operation: { kind: 'selection', action, requestId },
        revision: this.revision,
        selection: {
          signal,
          resolve,
          reject,
          release: () => signal?.removeEventListener('abort', cancel),
        },
      })
      void this.flush()
    })
  }
  private revoke(): void {
    const ownsPointer =
      this.pointer !== undefined ||
      this.captured !== undefined ||
      this.gesture !== undefined
    this.revision++
    this.needsNativeReset = false
    for (const pending of this.pending) {
      pending.selection?.reject(new DOMException('Terminal input revoked', 'AbortError'))
      pending.selection?.release()
    }
    this.pending.length = 0
    this.pressed.clear()
    this.duplicateText = undefined
    this.clipboardGesture = false
    if (this.composing) this.enqueue({ kind: 'preedit', text: null }, undefined, true)
    this.composing = false
    this.deadKey = false
    if (this.focused || ownsPointer)
      this.enqueue({ kind: 'focus', focused: false }, undefined, true)
    this.focused = false
    this.releaseCapture()
    this.clearText()
  }
  private enqueue(
    operation: BrowserOperation,
    text?: string,
    cleanup = false,
    capture?: number,
  ): boolean {
    if (this.disposed || (!cleanup && !this.enabled)) return false
    const previous = this.pending.at(-1)
    if (
      previous?.revision === this.revision &&
      ((operation.kind === 'caret' && previous.operation.kind === 'caret') ||
        (operation.kind === 'pointer' &&
          operation.action === undefined &&
          previous.operation.kind === 'pointer' &&
          previous.operation.action === undefined) ||
        (operation.kind === 'preedit' &&
          operation.text !== null &&
          previous.operation.kind === 'preedit' &&
          previous.operation.text !== null))
    ) {
      previous.operation = operation
      return true
    }
    if (this.pending.length + Number(this.active) >= (cleanup ? 32 : 30)) {
      this.port.refused('Native terminal input capacity reached; retry the gesture')
      if (cleanup) this.needsNativeReset = true
      return false
    }
    this.pending.push({
      operation,
      revision: this.revision,
      text,
      capture,
      captureRevision: capture === undefined ? undefined : this.pointerRevision,
    })
    void this.flush()
    return true
  }
  private flush(): Promise<void> {
    if (this.active) return this.settled
    this.active = true
    this.settled = this.drain()
    return this.settled
  }
  private async drain(): Promise<void> {
    try {
      while (this.pending.length || this.needsNativeReset) {
        if (!this.pending.length) {
          this.needsNativeReset = false
          const revision = this.revision
          try {
            const reset = await this.port.input({ kind: 'focus', focused: false })
            if (reset.refused) throw new Error('native-cleanup-refused')
            this.pressed.clear()
            if (
              this.enabled &&
              !this.disposed &&
              this.focused &&
              revision === this.revision
            )
              if ((await this.port.input({ kind: 'focus', focused: true })).refused)
                throw new Error('native-cleanup-refused')
          } catch {
            if (!this.disposed && revision === this.revision)
              this.port.failed('Native terminal input cleanup unavailable')
          }
          continue
        }
        const next = this.pending[0]!
        const cleanup =
          (next.operation.kind === 'focus' && !next.operation.focused) ||
          (next.operation.kind === 'preedit' && next.operation.text === null)
        if (!this.ready && !cleanup) break
        this.pending.shift()
        if (next.operation.kind === 'selection') {
          const pending = next.selection!
          try {
            if (pending.signal?.aborted)
              throw new DOMException('Terminal selection cancelled', 'AbortError')
            const result = await this.port.selection!(
              next.operation.action,
              next.operation.requestId,
            )
            if (
              this.disposed ||
              next.revision !== this.revision ||
              pending.signal?.aborted
            )
              throw new DOMException('Terminal selection source changed', 'AbortError')
            pending.resolve(result)
          } catch (error) {
            pending.reject(error)
          } finally {
            pending.release()
          }
          continue
        }
        try {
          const geometryRevision = this.geometryRevision
          let result: NativeTerminalInputCompletion
          if (next.operation.kind === 'clipboard') {
            this.port.clipboardPaste(next.operation.fallback)
            result = { requestedMutation: 0 }
          } else result = await this.port.input(next.operation)
          if (this.disposed || next.revision !== this.revision) continue
          if (result.refused === 'capacity') {
            this.port.refused('Native terminal input capacity reached; retry the gesture')
            if (
              (next.operation.kind === 'key' || next.operation.kind === 'pointer') &&
              next.operation.action === 0
            )
              this.needsNativeReset = true
            continue
          }
          if (result.selectionResult !== undefined && result.selectionResult !== 0)
            this.port.refused('Could not update the terminal selection')
          if (next.text !== undefined) this.port.accepted(next.text)
          if (
            result.caret &&
            this.ready &&
            geometryRevision === this.geometryRevision &&
            result.caret.geometrySerial >= this.caretSerial
          ) {
            this.caretSerial = result.caret.geometrySerial
            this.textarea.style.left = `${result.caret.x}px`
            this.textarea.style.top = `${result.caret.y}px`
            this.textarea.style.height = `${Math.max(1, result.caret.height)}px`
          }
          if (
            (result.captured ||
              (next.operation.kind === 'pointer' &&
                next.operation.action === 1 &&
                next.operation.button === 1 &&
                result.selectionResult === 0)) &&
            next.capture !== undefined &&
            next.captureRevision === this.pointerRevision &&
            next.capture === this.pointer
          ) {
            this.root.setPointerCapture?.(next.capture)
            this.captured = next.capture
          }
          if (
            result.linkCandidate &&
            !result.captured &&
            next.operation.kind === 'pointer' &&
            next.operation.action === 0 &&
            next.operation.button === 1
          ) {
            try {
              await this.port.activateLink?.(next.operation.x, next.operation.y)
            } catch {
              this.port.refused('Could not open the terminal link')
            }
          }
        } catch {
          if (!this.disposed && next.revision === this.revision)
            this.port.failed('Native terminal input unavailable')
        }
      }
    } finally {
      this.active = false
    }
  }
  private caret(): void {
    if (this.caretPending || !this.enabled) return
    this.caretPending = true
    queueMicrotask(() => {
      this.caretPending = false
      if (this.enabled && !this.disposed) this.enqueue({ kind: 'caret' })
    })
  }
  private readonly refreshLayout = (): void => {
    const keyboard = this.keyboard
    if (
      typeof keyboard?.getLayoutMap !== 'function' ||
      typeof keyboard.addEventListener !== 'function' ||
      typeof keyboard.removeEventListener !== 'function' ||
      !('onlayoutchange' in keyboard) ||
      !this.enabled ||
      this.disposed
    )
      return
    this.layout = undefined
    if (this.layoutPending) {
      this.layoutAgain = true
      return
    }
    const revision = this.revision
    this.layoutPending = true
    const getLayoutMap = keyboard.getLayoutMap.bind(keyboard)
    void Promise.resolve()
      .then(getLayoutMap)
      .then(
        (layout) => {
          if (
            !this.disposed &&
            this.enabled &&
            !this.layoutAgain &&
            revision === this.revision
          )
            this.layout = layout
        },
        () => {
          /* Optional metadata; an unavailable layout remains unknown. */
        },
      )
      .finally(() => {
        this.layoutPending = false
        if (this.layoutAgain) {
          this.layoutAgain = false
          this.refreshLayout()
        }
      })
  }
  private mods(event: KeyboardEvent | MouseEvent): number {
    return (
      Number(event.shiftKey) |
      (Number(event.ctrlKey) << 1) |
      (Number(event.altKey) << 2) |
      (Number(event.metaKey) << 3) |
      (Number(event.getModifierState('CapsLock')) << 4) |
      (Number(event.getModifierState('NumLock')) << 5)
    )
  }
  private key(event: KeyboardEvent, action: 0 | 1 | 2): boolean {
    const altGraph = event.getModifierState('AltGraph')
    const text = action !== 0 && Array.from(event.key).length === 1 ? event.key : ''
    // Physical code does not identify the unshifted character on non-US layouts.
    const observed =
      !event.altKey && Array.from(event.key).length === 1
        ? event.shiftKey
          ? /^\p{L}$/u.test(event.key)
            ? event.key.toLowerCase()
            : ''
          : event.key
        : ''
    if (
      observed &&
      !event.shiftKey &&
      this.layout?.get(event.code) !== undefined &&
      this.layout.get(event.code) !== observed
    )
      this.layout = undefined
    const unshifted = observed || this.layout?.get(event.code) || ''
    return this.enqueue(
      {
        kind: 'key',
        key: nativeTerminalPhysicalKey(event.code),
        action,
        modifiers: this.mods(event),
        consumedModifiers: (altGraph ? 6 : 0) | (event.shiftKey && text ? 1 : 0),
        text,
        unshiftedCodepoint:
          Array.from(unshifted).length === 1 ? unshifted.codePointAt(0)! : 0,
        composing: false,
        optionAsAlt: false,
      },
      action === 0 ? undefined : event.key === 'Enter' ? '\r' : text,
      action === 0,
    )
  }
  private readonly keydown = (event: KeyboardEvent): void => {
    if (
      this.enabled &&
      !event.defaultPrevented &&
      !event.isComposing &&
      !this.composing &&
      event.code === 'KeyC' &&
      (event.metaKey || (event.ctrlKey && event.shiftKey && !event.altKey))
    ) {
      event.preventDefault()
      event.stopPropagation()
      const revision = this.revision
      void this.port.copySelection?.().catch(() => {
        if (revision === this.revision && !this.disposed)
          this.port.refused('Could not copy the terminal selection')
      })
      return
    }
    if (
      !this.enabled ||
      this.readOnly ||
      event.defaultPrevented ||
      event.isComposing ||
      this.composing ||
      event.key === 'Process'
    )
      return
    if (event.key === 'Dead') {
      this.deadKey = true
      return
    }
    if (this.deadKey) return
    this.duplicateText = undefined
    this.clipboardGesture = false
    if (
      event.code === 'KeyV' &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.getModifierState('AltGraph')
    ) {
      event.preventDefault()
      this.clipboardGesture = true
      setTimeout(() => {
        this.clipboardGesture = false
      }, 0)
      this.enqueue({ kind: 'clipboard', fallback: event.altKey ? '\x1b\x16' : '\x16' })
      return
    }
    // Browser clipboard/menu gestures remain browser-owned; the paste event carries text.
    if (
      (event.code === 'KeyV' && (event.metaKey || (event.ctrlKey && event.shiftKey))) ||
      (event.code === 'Insert' && event.shiftKey)
    )
      return
    if (nativeTerminalPhysicalKey(event.code) === 0 && Array.from(event.key).length !== 1)
      return
    event.preventDefault()
    if (this.key(event, event.repeat ? 2 : 1)) this.pressed.add(event.code)
    this.duplicateText = Array.from(event.key).length === 1 ? event.key : undefined
    this.caret()
  }
  private readonly keyup = (event: KeyboardEvent): void => {
    if (!this.enabled || this.readOnly || !this.pressed.delete(event.code)) return
    event.preventDefault()
    this.key(event, 0)
  }
  private readonly beforeinput = (event: InputEvent): void => {
    if (
      !this.enabled ||
      this.readOnly ||
      this.composing ||
      event.isComposing ||
      event.inputType === 'insertCompositionText'
    )
      return
    event.preventDefault()
    if (!event.data || event.inputType === 'insertFromPaste') return
    if (this.duplicateText === event.data) {
      this.duplicateText = undefined
      return
    }
    this.deadKey = false
    this.commit(event.data)
  }
  private commit(text: string): void {
    this.enqueue(
      {
        kind: 'key',
        key: 0,
        modifiers: 0,
        consumedModifiers: 0,
        action: 1,
        text,
        unshiftedCodepoint: 0,
        composing: false,
        optionAsAlt: false,
      },
      text,
    )
    this.clearText()
    this.caret()
  }
  private readonly compositionstart = (): void => {
    if (!this.enabled || this.readOnly) return
    this.composing = true
    this.deadKey = false
    this.duplicateText = undefined
    this.enqueue({ kind: 'preedit', text: '' })
    this.caret()
  }
  private readonly compositionupdate = (event: CompositionEvent): void => {
    if (this.enabled && !this.readOnly && this.composing)
      this.enqueue({ kind: 'preedit', text: event.data })
    this.caret()
  }
  private readonly compositionend = (event: CompositionEvent): void => {
    if (!this.enabled || this.readOnly || !this.composing) return
    this.composing = false
    this.enqueue({ kind: 'preedit', text: null })
    if (event.data) {
      this.commit(event.data)
      this.duplicateText = event.data
    }
    this.clearText()
  }
  private readonly clearText = (): void => {
    if (!this.composing) this.textarea.value = ''
  }
  private readonly paste = (event: ClipboardEvent): void => {
    if (!this.enabled || this.readOnly || event.defaultPrevented) return
    event.preventDefault()
    if (this.clipboardGesture) {
      this.clipboardGesture = false
      return
    }
    const clipboard = event.clipboardData,
      text = clipboard?.getData('text/plain')
    if (text) this.pasteText(text)
    else if (clipboard && clipboard.files.length <= 1 && this.port.resolveFilePaste) {
      const revision = this.revision,
        file =
          clipboard.files.length === 1
            ? (clipboard.files.item(0) ?? undefined)
            : undefined
      if (clipboard.files.length === 0 || file)
        void Promise.resolve()
          .then(() => this.port.resolveFilePaste!(file))
          .then(
            (value) => {
              if (
                revision === this.revision &&
                !this.disposed &&
                this.enabled &&
                !this.readOnly &&
                value
              )
                this.pasteText(value)
            },
            () => {
              if (revision === this.revision && !this.disposed)
                this.port.refused('Could not paste the clipboard file')
            },
          )
    }
    this.clearText()
  }
  private readonly focusin = (): void => {
    if (!this.enabled || this.readOnly || this.focused) return
    if (document.activeElement !== this.textarea) {
      this.focus()
      return
    }
    this.focused = true
    this.enqueue({ kind: 'focus', focused: true })
    this.caret()
  }
  private readonly focusout = (event: FocusEvent): void => {
    if (
      !this.focused &&
      !this.composing &&
      this.pointer === undefined &&
      this.captured === undefined &&
      !this.gesture
    )
      return
    if (event.relatedTarget instanceof Node && this.root.contains(event.relatedTarget))
      return
    this.revoke()
  }
  private position(event: MouseEvent): { x: number; y: number } {
    const rect = this.root.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  private pointerEvent(event: PointerEvent, action?: 0 | 1): void {
    this.enqueue(
      {
        kind: 'pointer',
        ...this.position(event),
        modifiers: this.mods(event),
        ...(action === undefined
          ? {}
          : {
              action,
              button:
                event.button === 0
                  ? 1
                  : event.button === 1
                    ? 3
                    : event.button === 2
                      ? 2
                      : event.button + 1,
            }),
      },
      undefined,
      action === 0,
      action === 1 ? event.pointerId : undefined,
    )
  }
  private readonly pointerdown = (event: PointerEvent): void => {
    if (!this.enabled || event.defaultPrevented) return
    if (this.pointer !== undefined && event.pointerId !== this.pointer) return
    this.focus()
    this.pointerRevision++
    this.pointer = event.pointerId
    this.routePointer()
    this.gesture = {
      ...this.position(event),
      modifiers: this.mods(event),
      button:
        event.button === 0
          ? 1
          : event.button === 1
            ? 3
            : event.button === 2
              ? 2
              : event.button + 1,
    }
    this.pointerEvent(event, 1)
  }
  private readonly pointermove = (event: PointerEvent): void => {
    if (this.pointer !== undefined && event.pointerId !== this.pointer) return
    if (this.enabled && !event.defaultPrevented) {
      if (event.pointerId === this.pointer && this.gesture)
        Object.assign(this.gesture, this.position(event), { modifiers: this.mods(event) })
      this.pointerEvent(event)
    }
  }
  private readonly pointerup = (event: PointerEvent): void => {
    if (this.pointer !== undefined && event.pointerId !== this.pointer) return
    if (this.enabled && !event.defaultPrevented) this.pointerEvent(event, 0)
    if (this.pointer === undefined || this.pointer === event.pointerId)
      this.releaseCapture()
  }
  private readonly pointercancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointer) return
    if (this.enabled && this.gesture)
      this.enqueue({ kind: 'pointer', ...this.gesture, action: 0 }, undefined, true)
    this.releaseCapture()
  }
  private routePointer(): void {
    this.pointerRoute?.abort()
    const route = new AbortController()
    this.pointerRoute = route
    const forward = (event: PointerEvent) => {
      if (
        event.pointerId !== this.pointer ||
        (event.target instanceof Node && this.root.contains(event.target))
      )
        return
      event.stopPropagation()
      if (event.type === 'pointermove') this.pointermove(event)
      else if (event.type === 'pointerup') this.pointerup(event)
      else this.pointercancel(event)
      event.preventDefault()
    }
    for (const type of ['pointermove', 'pointerup', 'pointercancel'] as const)
      window.addEventListener(type, forward, { capture: true, signal: route.signal })
  }
  private releaseCapture(): void {
    this.pointerRevision++
    this.pointerRoute?.abort()
    this.pointerRoute = undefined
    if (this.captured !== undefined && this.root.hasPointerCapture?.(this.captured))
      this.root.releasePointerCapture(this.captured)
    this.captured = undefined
    this.pointer = undefined
    this.gesture = undefined
  }
  private readonly wheel = (event: WheelEvent): void => {
    if (!this.enabled || event.defaultPrevented) return
    const line = Number.parseFloat(getComputedStyle(this.textarea).lineHeight) || 16
    const rect = this.root.getBoundingClientRect()
    const xUnit = event.deltaMode === 2 ? rect.width : event.deltaMode === 1 ? line : 1
    const yUnit = event.deltaMode === 2 ? rect.height : event.deltaMode === 1 ? line : 1
    event.preventDefault()
    this.enqueue({
      kind: 'wheel',
      ...this.position(event),
      deltaX: event.deltaX * xUnit,
      deltaY: event.deltaY * yUnit,
      precision: true,
      modifiers: this.mods(event),
    })
  }
}
