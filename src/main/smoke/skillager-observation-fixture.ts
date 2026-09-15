import { SkillagerError } from '../skillager/skillager-port'

export interface SkillagerObservationHold {
  readonly entered: Promise<boolean>
  release(failed?: boolean): void
}
type Observation = 'library' | 'project'
interface HeldRead extends SkillagerObservationHold {
  readonly result: Promise<boolean>
  start(): void
}

/** One bounded held CLI read per existing observation lane, confined to smoke fixtures. */
export function skillagerObservationFixture() {
  const held = new Map<Observation, HeldRead>()
  return {
    holdNext(this: void, kind: Observation): SkillagerObservationHold {
      if (held.has(kind)) throw Error('A fixture observation is already held')
      let settle!: (failed: boolean) => void, acknowledge!: (entered: boolean) => void
      const result = new Promise<boolean>((resolve) => {
        settle = resolve
      })
      const entered = new Promise<boolean>((resolve) => {
        acknowledge = resolve
      })
      const read: HeldRead = {
        entered,
        result,
        start: () => acknowledge(true),
        release(failed = false) {
          clearTimeout(timer)
          if (held.get(kind) === read) held.delete(kind)
          acknowledge(false)
          settle(failed)
        },
      }
      const timer = setTimeout(() => read.release(true), 15_000)
      held.set(kind, read)
      return read
    },
    async wait(kind: Observation, signal: AbortSignal): Promise<void> {
      const read = held.get(kind)
      if (!read) return
      let reject!: (error: SkillagerError) => void
      const cancelled = new Promise<never>((_, fail) => {
        reject = fail
      })
      const cancel = () =>
        reject(new SkillagerError('cancelled', 'Fixture observation cancelled.'))
      signal.addEventListener('abort', cancel, { once: true })
      try {
        if (signal.aborted) cancel()
        else read.start()
        const failed = await Promise.race([read.result, cancelled])
        if (signal.aborted)
          throw new SkillagerError('cancelled', 'Fixture observation cancelled.')
        if (failed)
          throw new SkillagerError(
            'unavailable',
            'Fixture metadata temporarily unavailable.',
          )
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    dispose() {
      for (const read of held.values()) read.release()
    },
  }
}
