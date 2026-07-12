import { describe, expect, it } from 'vitest'

import {
  asHostId,
  basenameHostPath,
  dirnameHostPath,
  displayHostPath,
  hostPath,
  hostPathEquals,
  isLocal,
  joinHostPath,
  localPath,
  LOCAL_HOST_ID,
} from '../src/shared'

describe('HostPath', () => {
  it('normalizes the path component', () => {
    expect(localPath('/a/b/../c//d/./').path).toBe('/a/c/d')
    expect(localPath('/a/b/../../..').path).toBe('/')
    expect(hostPath(asHostId('h'), 'a//b/./c').path).toBe('a/b/c')
  })

  it('carries the host id', () => {
    const p = localPath('/x')
    expect(p.hostId).toBe(LOCAL_HOST_ID)
    expect(isLocal(p)).toBe(true)
    expect(isLocal(hostPath(asHostId('remote'), '/x'))).toBe(false)
  })

  it('joins, dirnames, and basenames on the same host', () => {
    const base = hostPath(asHostId('remote'), '/srv/app')
    const joined = joinHostPath(base, 'src', 'index.ts')
    expect(joined.path).toBe('/srv/app/src/index.ts')
    expect(joined.hostId).toBe(asHostId('remote'))
    expect(dirnameHostPath(joined).path).toBe('/srv/app/src')
    expect(basenameHostPath(joined)).toBe('index.ts')
  })

  it('compares by host and path', () => {
    expect(hostPathEquals(localPath('/a'), localPath('/a'))).toBe(true)
    expect(hostPathEquals(localPath('/a'), localPath('/b'))).toBe(false)
    expect(hostPathEquals(localPath('/a'), hostPath(asHostId('remote'), '/a'))).toBe(
      false,
    )
  })

  it('renders a human-readable form', () => {
    expect(displayHostPath(hostPath(asHostId('web1'), '/srv'))).toBe('web1:/srv')
  })
})
