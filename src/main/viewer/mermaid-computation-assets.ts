/** Exact application asset roots only; project files and diagram URLs are never admitted. */
export function isMermaidComputationAsset(candidate: string, entry: string): boolean {
  try {
    const url = new URL(candidate)
    const page = new URL(entry)
    if (
      url.protocol !== page.protocol ||
      url.host !== page.host ||
      url.search ||
      url.hash
    )
      return false
    if (url.href === page.href) return true
    const root = new URL('.', page).pathname
    if (page.protocol === 'file:')
      return (
        url.pathname.startsWith(`${root}assets/`) &&
        /^assets\/[a-zA-Z0-9_.-]+\.js$/.test(url.pathname.slice(root.length))
      )
    // Vite serves this entry and its statically imported application/dependency modules.
    return (
      url.pathname === '/@vite/client' ||
      /^\/src\/mermaid-computation\.ts$/.test(url.pathname) ||
      /^\/node_modules\/\.vite\/deps\/[a-zA-Z0-9_.-]+\.js$/.test(url.pathname) ||
      /\/src\/shared\/presentation\/mermaid-(contract|svg)\.ts$/.test(url.pathname)
    )
  } catch {
    return false
  }
}
