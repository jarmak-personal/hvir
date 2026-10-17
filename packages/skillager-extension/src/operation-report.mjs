/** Read complete public operation records without caching recovery decisions. */
export async function readOperationReport(client, operationId) {
  let report = '',
    offset = 0
  for (;;) {
    const page = await client.request('actions.invoke', {
      action: 'operation-state',
      input: { mode: 'report', operationId, offset },
    })
    report += page.data
    if (report.length > 2 * 256 * 1024 + 8192)
      throw new Error('Complete operation report exceeds its bounded lifetime storage')
    if (page.nextOffset === null) return JSON.parse(report)
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)
      throw new Error('Operation report page did not advance')
    offset = page.nextOffset
  }
}

/** Presentation matching only; pendingManagement remains the mutation admission owner. */
export async function selectedPendingOperations(client, selection) {
  const value = await client.request('actions.invoke', {
    action: 'operation-state',
    input: { mode: 'list' },
  })
  const matches = []
  const same = (a, b) => a?.hostId === b?.hostId && a?.path === b?.path
  for (const id of value.ids ?? []) {
    const report = await readOperationReport(client, id),
      operation = report.operation
    if (
      operation.library?.id !== selection.library.id ||
      !same(operation.library.root, selection.library.root) ||
      (operation.source?.id ?? operation.skillId) !== selection.skillId
    )
      continue
    if (
      operation.action !== 'accept-version' &&
      (operation.workspace?.id !== selection.workspace?.id ||
        operation.workspace?.host !== selection.workspace?.host ||
        !same(operation.workspace?.root, selection.workspace?.root) ||
        operation.agent !== selection.agent ||
        !operation.target ||
        (selection.target && !same(operation.target, selection.target)))
    )
      continue
    matches.push(report)
  }
  return matches
}
