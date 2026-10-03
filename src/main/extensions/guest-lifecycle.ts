import { EXTENSION_LIMITS } from '../../shared/extensions/contract'

/** One in-flight engine transition and one latest target, private to the guest surface. */
export class ExtensionGuestLifecycle {
  private visible = false
  private admittedWork = false
  private applied?: boolean
  private revision = 0
  private appliedRevision = -1
  private running = false
  private disposed = false
  private cancel?: () => void
  private supersedeFreeze?: () => void

  constructor(
    private readonly apply: (
      state: 'active' | 'frozen',
      renewed: AbortSignal,
    ) => Promise<'applied' | 'superseded'>,
    private readonly active: () => void,
    private readonly failed: (category: 'timeout' | 'refusal') => void,
  ) {}

  get isActive(): boolean {
    return (
      !this.disposed &&
      (this.visible || this.admittedWork) &&
      this.applied === true &&
      this.appliedRevision === this.revision
    )
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return
    this.visible = visible
    this.revision++
    if (this.running) {
      if (this.visible || this.admittedWork) this.supersedeFreeze?.()
      return
    }
    this.running = true
    void this.transition()
  }

  setAdmittedWork(admitted: boolean): void {
    this.admittedWork = admitted
    this.setVisible(this.visible)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.supersedeFreeze?.()
    this.cancel?.()
  }

  private async transition(): Promise<void> {
    const timeout = new Error('Guest lifecycle timed out')
    try {
      while (!this.disposed && this.appliedRevision !== this.revision) {
        let target = this.visible || this.admittedWork
        let revision = this.revision
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await new Promise<void>((resolve, reject) => {
            this.cancel = () => reject(new Error('Guest lifecycle closed'))
            timer = setTimeout(() => reject(timeout), EXTENSION_LIMITS.requestTimeoutMs)
            // Retire obsolete preparation without restarting this transition's deadline.
            void (async () => {
              while (!this.disposed) {
                const renewed = new AbortController()
                this.supersedeFreeze = target ? undefined : () => renewed.abort()
                let outcome: 'applied' | 'superseded'
                try {
                  outcome = await this.apply(target ? 'active' : 'frozen', renewed.signal)
                } finally {
                  this.supersedeFreeze = undefined
                }
                if (outcome === 'applied') return
                target = this.visible || this.admittedWork
                revision = this.revision
              }
            })().then(resolve, reject)
          })
        } finally {
          clearTimeout(timer)
          this.supersedeFreeze?.()
          this.supersedeFreeze = undefined
          this.cancel = undefined
        }
        if (this.disposed) return
        this.applied = target
        this.appliedRevision = revision
        if (target && (this.visible || this.admittedWork)) this.active()
      }
    } catch (error) {
      if (!this.disposed) {
        this.dispose()
        this.failed(error === timeout ? 'timeout' : 'refusal')
      }
    } finally {
      this.running = false
    }
  }
}
