/** Ephemeral domain records preserve unknown completion, never an automatic replay journal. */
export function pendingManagement() {
  const records = new Map()
  function sameRoot(a, b) {
    return a?.hostId === b?.hostId && a?.path === b?.path
  }
  return {
    ids() {
      return [...records.keys()]
    },
    get(id) {
      const value = records.get(id)
      if (!value)
        throw new Error(
          'The ephemeral operation record is unavailable; observe public current state before a new explicit operation. Original completion is unknown.',
        )
      return value
    },
    assertAvailable(descriptor) {
      for (const value of records.values()) {
        const previous = value.operation
        if (
          [descriptor.target, ...(descriptor.targets ?? [])]
            .filter(Boolean)
            .some((target) =>
              [previous.target, ...(previous.targets ?? [])]
                .filter(Boolean)
                .some((existing) => sameRoot(target, existing)),
            ) ||
          (descriptor.action === 'initialize-library' &&
            previous.action === descriptor.action &&
            (descriptor.selection.location === 'default' ||
              previous.selection.location === 'default' ||
              sameRoot(descriptor.selection.root, previous.selection.root))) ||
          (descriptor.action === 'sync-library' &&
            previous.action === descriptor.action &&
            descriptor.library.id === previous.library.id &&
            sameRoot(descriptor.library.root, previous.library.root)) ||
          (descriptor.action === 'accept-version' &&
            previous.action === descriptor.action &&
            descriptor.library.id === previous.library.id &&
            sameRoot(descriptor.source.root, previous.source.root))
        )
          throw new Error(
            `Reconcile exact unknown operation ${value.id} before repeating work on that destination`,
          )
      }
      if (records.size >= 32)
        throw new Error(
          'Pending operation capacity is full. Reconcile a named operation before another mutation.',
        )
    },
    observe(id, operation) {
      if (!operation) {
        records.delete(id)
        return
      }
      if (!records.has(id) && records.size >= 32)
        throw new Error('Pending operation capacity is full')
      records.set(id, { id, operation: JSON.parse(JSON.stringify(operation)) })
    },
    retainOutput(id, output) {
      const value = records.get(id)
      if (value) value.output = output
    },
    report(id, offset = 0) {
      const value = JSON.stringify(this.get(id))
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length)
        throw new Error('Invalid operation report offset')
      const data = value.slice(offset, offset + 2048),
        next = offset + data.length
      return { data, nextOffset: next === value.length ? null : next }
    },
    release(id) {
      records.delete(id)
    },
  }
}
