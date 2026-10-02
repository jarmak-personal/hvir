import { useCallback, useEffect, useRef, useState } from 'react'

import type { ProjectHostOption } from '../../../shared/ipc/project'
import type { AddSshHostRequest } from '../../../shared/ssh-configuration'
import type { SshHostChooserPort } from './ssh-configuration-client'

const emptyFields: AddSshHostRequest = { alias: '', hostname: '', username: '', port: 22 }
const message = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason)

/** Owns chooser requests and feedback; configuration and connection effects stay behind ports. */
export function useSshHostChooser(
  port: SshHostChooserPort,
  initialHosts: readonly ProjectHostOption[],
  initialHostId: string,
  active: boolean,
) {
  const [hosts, setHosts] = useState<readonly ProjectHostOption[]>(
    initialHosts.length
      ? initialHosts
      : [
          {
            hostId: 'local',
            label: 'Local',
            kind: 'local',
            connectionState: 'connected',
            watchTier: 'native',
          },
        ],
  )
  const [hostId, setHostId] = useState(
    !initialHosts.length || initialHosts.some((host) => host.hostId === initialHostId)
      ? initialHostId
      : (initialHosts[0]?.hostId ?? 'local'),
  )
  const [adding, setAdding] = useState(false)
  const [fields, setFields] = useState(emptyFields)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [refreshError, setRefreshError] = useState<string>()
  const [feedback, setFeedback] = useState<string>()
  const lifetime = useRef(0)
  const refreshVersion = useRef(0)
  const saving = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const clearFeedback = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    setFeedback(undefined)
  }, [])

  const refresh = useCallback(async () => {
    if (saving.current) return
    const generation = lifetime.current
    const version = ++refreshVersion.current
    try {
      const cached = await port.snapshot()
      if (generation !== lifetime.current || version !== refreshVersion.current) return
      setHosts(cached)
      setHostId((selected) =>
        cached.some(({ hostId }) => hostId === selected)
          ? selected
          : (cached[0]?.hostId ?? 'local'),
      )
      const next = await port.refresh()
      if (generation !== lifetime.current || version !== refreshVersion.current) return
      setHosts(next)
      setHostId((selected) =>
        next.some(({ hostId }) => hostId === selected)
          ? selected
          : (next[0]?.hostId ?? 'local'),
      )
      setRefreshError(undefined)
    } catch (reason) {
      if (generation === lifetime.current && version === refreshVersion.current) {
        setRefreshError(`Could not refresh SSH hosts: ${message(reason)}`)
      }
    }
  }, [port])

  const invalidate = useCallback(() => {
    lifetime.current++
    refreshVersion.current++
    clearTimeout(timer.current)
    setFeedback(undefined)
  }, [])

  useEffect(() => {
    if (!active) return
    void refresh()
    const focus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', focus)
    return () => {
      invalidate()
      window.removeEventListener('focus', focus)
    }
  }, [active, refresh, invalidate])

  const startAdding = async (): Promise<void> => {
    const generation = lifetime.current
    clearFeedback()
    setError(undefined)
    setFields(emptyFields)
    setAdding(true)
    try {
      const defaults = await port.defaults()
      if (generation !== lifetime.current) return
      setFields((current) => ({
        ...current,
        username: current.username || defaults.username,
      }))
    } catch (reason) {
      if (generation === lifetime.current) setError(message(reason))
    }
  }

  const cancelAdding = (): void => {
    lifetime.current++
    setAdding(false)
    setFields(emptyFields)
    setError(undefined)
    setBusy(false)
    saving.current = false
  }

  const save = async (): Promise<void> => {
    if (saving.current) return
    const generation = lifetime.current
    refreshVersion.current++
    saving.current = true
    setBusy(true)
    setError(undefined)
    try {
      const next = await port.save(fields)
      if (generation !== lifetime.current) return
      setHosts(next)
      setHostId(fields.alias)
      setAdding(false)
      setRefreshError(undefined)
      clearFeedback()
      setFeedback('Saved to ~/.ssh/config')
      timer.current = setTimeout(() => {
        if (generation === lifetime.current) setFeedback(undefined)
        timer.current = undefined
      }, 4000)
    } catch (reason) {
      if (generation === lifetime.current) setError(message(reason))
    } finally {
      if (generation === lifetime.current) {
        saving.current = false
        setBusy(false)
      }
    }
  }

  const pickIdentity = async (): Promise<void> => {
    const generation = lifetime.current
    setBusy(true)
    setError(undefined)
    try {
      const identityFile = await port.pickIdentity()
      if (generation === lifetime.current && identityFile) {
        setFields((current) => ({ ...current, identityFile }))
      }
    } catch (reason) {
      if (generation === lifetime.current) setError(message(reason))
    } finally {
      if (generation === lifetime.current) setBusy(false)
    }
  }

  return {
    hosts,
    hostId,
    setHostId,
    adding,
    fields,
    setFields,
    busy,
    error,
    refreshError,
    feedback,
    startAdding,
    cancelAdding,
    save,
    pickIdentity,
  }
}
