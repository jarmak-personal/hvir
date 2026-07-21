export const PROJECT_STATUS_OPTIONS = ['Todo', 'In Progress', 'Done'] as const
export type ProjectStatus = (typeof PROJECT_STATUS_OPTIONS)[number]
