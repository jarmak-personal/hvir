export interface ProjectFileCopyLimits {
  readonly maxEntries: number
  readonly maxDepth: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

export const PROJECT_FILE_COPY_LIMITS: ProjectFileCopyLimits = {
  maxEntries: 4_096,
  maxDepth: 32,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
}
