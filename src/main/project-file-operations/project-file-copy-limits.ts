export interface ProjectFileCopyLimits {
  readonly maxEntries: number
  readonly maxDepth: number
}

export const PROJECT_FILE_COPY_LIMITS: ProjectFileCopyLimits = {
  maxEntries: 4_096,
  maxDepth: 32,
}
