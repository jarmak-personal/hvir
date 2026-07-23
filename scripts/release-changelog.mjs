export function sortClosedIssues(issues) {
  for (const issue of issues) {
    if (
      !Number.isSafeInteger(issue.number) ||
      issue.number < 1 ||
      typeof issue.title !== 'string' ||
      issue.title.length === 0 ||
      typeof issue.url !== 'string' ||
      issue.url.length === 0 ||
      (issue.closedAt !== null && typeof issue.closedAt !== 'string')
    ) {
      throw new Error(
        'GitHub returned an invalid closed issue record; verify the workflow has issues: read.',
      )
    }
  }

  return [...issues].sort((first, second) => {
    const firstClosedAt = first.closedAt ?? '\uffff'
    const secondClosedAt = second.closedAt ?? '\uffff'
    return firstClosedAt.localeCompare(secondClosedAt) || first.number - second.number
  })
}
