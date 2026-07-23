export function sortClosedIssues(issues) {
  return [...issues].sort((first, second) => {
    const firstClosedAt = first.closedAt ?? '\uffff'
    const secondClosedAt = second.closedAt ?? '\uffff'
    return firstClosedAt.localeCompare(secondClosedAt) || first.number - second.number
  })
}
