import type { SkillagerResult } from '../../shared/skillager'
import { SkillagerError } from './skillager-port'

export async function result<T>(
  operation: () => Promise<T>,
): Promise<SkillagerResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (error instanceof SkillagerError)
      return { ok: false, reason: error.reason, message: error.message }
    return {
      ok: false,
      reason: 'command-failed',
      message: 'Skillager request failed. Try again.',
    }
  }
}
