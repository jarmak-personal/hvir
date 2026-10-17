import { expect, it, vi } from 'vitest'
import type { ExecResult } from '../src/shared/fs-types'
import { FiniteExecAdmission } from '../src/main/project-host/finite-exec-admission'

it('refuses excess local finite work without queuing and waits for the owning execution to settle', async () => {
  const pending: Array<(value: ExecResult) => void> = []
  const execute = vi.fn(
    () =>
      new Promise<ExecResult>((resolve) => {
        pending.push(resolve)
      }),
  )
  const admission = new FiniteExecAdmission(execute)
  const callers = Array.from({ length: 4 }, () => admission.tryExec('tool', []))
  expect(admission.tryExec('excess', [])).toBeUndefined()
  await Promise.resolve()
  expect(execute).toHaveBeenCalledTimes(4)
  expect(admission.tryExec('still-excess', [])).toBeUndefined()
  const result = { code: null, signal: 'SIGTERM', stdout: '', stderr: '' }
  pending[0]!(result)
  await expect(callers[0]).resolves.toEqual(result)
  const replacement = admission.tryExec('replacement', [])
  expect(replacement).toBeDefined()
  await Promise.resolve()
  expect(execute).toHaveBeenCalledTimes(5)
  for (const resolve of pending) resolve(result)
  await Promise.all([...callers, replacement])
})

it('releases local finite admission after a failed native execution settles', async () => {
  const admission = new FiniteExecAdmission(() =>
    Promise.reject(new Error('spawn failed')),
  )
  for (let index = 0; index < 5; index++)
    await expect(admission.tryExec('missing-tool', [])).rejects.toThrow('spawn failed')
})
