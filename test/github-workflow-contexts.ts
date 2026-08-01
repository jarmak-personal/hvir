import { parse } from 'yaml'

const workflowContextNames = [
  'env',
  'github',
  'inputs',
  'job',
  'matrix',
  'needs',
  'runner',
  'secrets',
  'steps',
  'strategy',
  'vars',
] as const

const workflowEnvContexts = new Set(['github', 'inputs', 'secrets', 'vars'])
const jobEnvContexts = new Set([
  'github',
  'inputs',
  'matrix',
  'needs',
  'secrets',
  'strategy',
  'vars',
])

interface WorkflowDocument {
  env?: Record<string, unknown>
  jobs?: Record<string, { env?: Record<string, unknown> }>
}

function referencedContexts(value: unknown): string[] {
  if (typeof value !== 'string') return []

  const contexts = new Set<string>()
  for (const expression of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    const contents = expression[1] ?? ''
    for (const context of workflowContextNames) {
      const reference = new RegExp(`\\b${context}(?:\\.|\\[)`, 'u')
      if (reference.test(contents)) contexts.add(context)
    }
  }
  return [...contexts].sort()
}

function validateEnv(
  env: Record<string, unknown> | undefined,
  allowed: ReadonlySet<string>,
  location: string,
): string[] {
  if (!env) return []

  return Object.entries(env).flatMap(([name, value]) =>
    referencedContexts(value)
      .filter((context) => !allowed.has(context))
      .map(
        (context) =>
          `${location}.${name} uses the unavailable ${context} context`,
      ),
  )
}

export function validateWorkflowEnvironmentContexts(source: string): string[] {
  const workflow = parse(source) as WorkflowDocument
  const errors = validateEnv(workflow.env, workflowEnvContexts, 'env')

  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    errors.push(
      ...validateEnv(job.env, jobEnvContexts, `jobs.${jobId}.env`),
    )
  }

  return errors
}
