export interface SplitFileName {
  readonly stem: string
  readonly extension: string
}

export function splitFileName(name: string): SplitFileName {
  const separator = name.lastIndexOf('.')
  if (separator <= 0 || separator === name.length - 1) {
    return { stem: name, extension: '' }
  }
  return {
    stem: name.slice(0, separator),
    extension: name.slice(separator),
  }
}
