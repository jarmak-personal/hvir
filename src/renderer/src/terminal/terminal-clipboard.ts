export function readApplicationClipboard(): Promise<string> {
  if (!navigator.clipboard?.readText) {
    return Promise.reject(new Error('Clipboard reading is unavailable'))
  }
  return navigator.clipboard.readText()
}

export function writeApplicationClipboard(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    return Promise.reject(new Error('Clipboard writing is unavailable'))
  }
  return navigator.clipboard.writeText(value)
}
