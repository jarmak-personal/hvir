import { EXTENSION_LIMITS } from '../../shared/extensions/contract'

/** One in-flight engine transition and one latest target, private to the guest surface. */
export class ExtensionGuestLifecycle {
  private visible = false
  private applied?: boolean
  private revision = 0
  private appliedRevision = -1
  private running = false
  private disposed = false
  private cancel?: () => void

  constructor(
    private readonly apply: (state: 'active' | 'frozen') => Promise<void>,
    private readonly active: () => void,
    private readonly failed: () => void,
  ) {}

  get isActive(): boolean {
    return (
      !this.disposed &&
      this.visible &&
      this.applied === true &&
      this.appliedRevision === this.revision
    )
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return
    this.visible = visible
    this.revision++
    if (this.running) return
    this.running = true
    void this.transition()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel?.()
  }

  private async transition(): Promise<void> {
    try {
      while (!this.disposed && this.appliedRevision !== this.revision) {
        const target = this.visible
        const revision = this.revision
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await new Promise<void>((resolve, reject) => {
            this.cancel = () => reject(new Error('Guest lifecycle closed'))
            timer = setTimeout(
              () => reject(new Error('Guest lifecycle timed out')),
              EXTENSION_LIMITS.requestTimeoutMs,
            )
            void this.apply(target ? 'active' : 'frozen').then(resolve, reject)
          })
        } finally {
          clearTimeout(timer)
          this.cancel = undefined
        }
        if (this.disposed) return
        this.applied = target
        this.appliedRevision = revision
        if (target && this.visible) this.active()
      }
    } catch {
      if (!this.disposed) {
        this.dispose()
        this.failed()
      }
    } finally {
      this.running = false
    }
  }
}
