import { GitHubClient } from './github-client.ts'
import {
  CANONICAL_PROJECT_CONFIGURATION,
  configuredProjectSchema,
  type CanonicalProjectConfiguration,
} from './canonical-project-config.ts'
import {
  requireCanonicalSingleSelectField,
  setCanonicalSingleSelect,
  type CanonicalProjectField,
  type CanonicalProjectSchema,
} from './canonical-project-fields.ts'
import {
  type AgentWorkProjectFieldName,
  type AgentWorkProjectValue,
  type AgentWorkProjectValues,
} from './agent-work-project-fields.ts'
import {
  readAgentWorkProjectValues,
  setAgentWorkProjectValue,
} from './github-agent-work-project.ts'
import { nextPageCursor, type PageInfo } from './github-pagination.ts'
import { KIND_DEFINITIONS, type KindOption } from './kind-policy.ts'
import { PROJECT_STATUS_OPTIONS, type ProjectStatus } from './planning-fields.ts'

export interface CanonicalProjectItem {
  id: string
  archived: boolean
  repository: string
  issueNumber: number
  kind: string | null
  status: string | null
}

export interface GitHubCanonicalProjectOptions {
  owner: string
  number: number
  repositoryOwner: string
  repositoryName: string
  client: GitHubClient
  configuration?: CanonicalProjectConfiguration
  itemLookup?: 'direct' | 'enumerated'
}

interface ProjectContext extends CanonicalProjectSchema {
  items: Map<string, CanonicalProjectItem>
}

interface ProjectItemNode {
  id: string
  isArchived: boolean
  content: null | {
    __typename: string
    number?: number
    repository?: { nameWithOwner: string }
  }
  kind: null | { __typename: string; name?: string }
  status: null | { __typename: string; name?: string }
}

interface IssueProjectItemNode extends ProjectItemNode {
  project: null | { id: string }
}

export interface CanonicalProjectAuditReport {
  outcome: 'valid' | 'drift'
  project: { owner: string; number: number }
  diagnostics: string[]
}

const PROJECT_ITEM_FIELDS = `
  id isArchived
  content {
    __typename
    ... on Issue { number repository { nameWithOwner } }
  }
  kind: fieldValueByName(name: "Kind") {
    __typename
    ... on ProjectV2ItemFieldSingleSelectValue { name }
  }
  status: fieldValueByName(name: "Status") {
    __typename
    ... on ProjectV2ItemFieldSingleSelectValue { name }
  }
`

export class GitHubCanonicalProject {
  readonly #owner: string
  readonly #number: number
  readonly #repositoryOwner: string
  readonly #repositoryName: string
  readonly #client: GitHubClient
  readonly #configuration: CanonicalProjectConfiguration
  readonly #itemLookup: 'direct' | 'enumerated'
  readonly #schemaContext: CanonicalProjectSchema
  #items?: Promise<Map<string, CanonicalProjectItem>>
  #loadedItems?: Map<string, CanonicalProjectItem>
  readonly #issueItems = new Map<number, Promise<CanonicalProjectItem | undefined>>()

  constructor(options: GitHubCanonicalProjectOptions) {
    this.#owner = options.owner
    this.#number = options.number
    this.#repositoryOwner = options.repositoryOwner
    this.#repositoryName = options.repositoryName
    this.#client = options.client
    this.#configuration = options.configuration ?? CANONICAL_PROJECT_CONFIGURATION
    this.#itemLookup = options.itemLookup ?? 'direct'
    this.#schemaContext = configuredProjectSchema(this.#configuration)
    if (
      `${this.#repositoryOwner}/${this.#repositoryName}` !==
        this.#configuration.repository ||
      this.#owner !== this.#configuration.owner ||
      this.#number !== this.#configuration.number
    ) {
      throw new Error(
        'The requested repository or Project coordinates do not match the stored canonical Project configuration.',
      )
    }
  }

  async getIssueItem(issueNumber: number): Promise<CanonicalProjectItem | undefined> {
    return this.#getIssueItem(issueNumber)
  }

  async refreshIssueItem(issueNumber: number): Promise<CanonicalProjectItem | undefined> {
    const key = projectItemKey(this.#repositoryOwner, this.#repositoryName, issueNumber)
    const current = await this.#getIssueItem(issueNumber)
    if (current === undefined) return undefined

    const data: {
      node: ({ __typename: string } & Partial<ProjectItemNode>) | null
    } = await this.#client.graphql(
      `query ProjectItemById($itemId: ID!) {
        node(id: $itemId) {
          __typename
          ... on ProjectV2Item { ${PROJECT_ITEM_FIELDS} }
        }
      }`,
      { itemId: current.id },
    )
    if (data.node?.__typename !== 'ProjectV2Item') {
      this.#cacheIssueItem(issueNumber, undefined)
      return undefined
    }
    const refreshed = canonicalProjectItem(data.node)
    if (refreshed === undefined) {
      this.#cacheIssueItem(issueNumber, undefined)
      return undefined
    }
    const refreshedKey = projectItemKeyFromName(
      refreshed.repository,
      refreshed.issueNumber,
    )
    if (refreshedKey !== key) {
      throw new Error(
        `The refreshed Project item no longer refers to the expected issue #${issueNumber} in ${this.#repositoryOwner}/${this.#repositoryName}.`,
      )
    }
    this.#cacheIssueItem(issueNumber, refreshed)
    return refreshed
  }

  validatePlanningSchema(): Promise<void> {
    return Promise.resolve().then(() => {
      const context = this.#getSchemaContext()
      this.#requireKindField(context)
      this.#requireField(context, 'Status', PROJECT_STATUS_OPTIONS)
    })
  }

  validateKindSchema(): Promise<void> {
    return Promise.resolve().then(() => {
      this.#requireKindField(this.#getSchemaContext())
    })
  }

  async auditConfiguration(): Promise<CanonicalProjectAuditReport> {
    const live = await this.#loadLiveSchemaContext()
    const diagnostics = auditConfiguredSchema(this.#schemaContext, live)
    return {
      outcome: diagnostics.length === 0 ? 'valid' : 'drift',
      project: { owner: this.#owner, number: this.#number },
      diagnostics,
    }
  }

  async readAgentWorkProjection(issueNumber: number): Promise<AgentWorkProjectValues> {
    const context = this.#getSchemaContext()
    return readAgentWorkProjectValues({
      client: this.#client,
      schema: context,
      item: await this.#getIssueItem(issueNumber),
      issueNumber,
    })
  }

  async setAgentWorkProjectionField(
    issueNumber: number,
    name: AgentWorkProjectFieldName,
    value: AgentWorkProjectValue | undefined,
  ): Promise<void> {
    const context = this.#getSchemaContext()
    await setAgentWorkProjectValue({
      client: this.#client,
      schema: context,
      item: await this.#getIssueItem(issueNumber),
      issueNumber,
      name,
      value,
    })
  }

  async addIssue(issue: {
    id: string
    number: number
    state: 'OPEN' | 'CLOSED'
  }): Promise<CanonicalProjectItem> {
    if (issue.state !== 'OPEN') {
      throw new Error(
        `Closed issue #${issue.number} is not eligible to be added to the Project.`,
      )
    }
    const context = this.#getSchemaContext()
    const existing = await this.#getIssueItem(issue.number)
    if (existing !== undefined) return existing

    const data: {
      addProjectV2ItemById: { item: { id: string; isArchived: boolean } | null }
    } = await this.#client.graphql(
      `mutation AddProjectItem($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
          item { id isArchived }
        }
      }`,
      { projectId: context.id, contentId: issue.id },
    )
    const added = data.addProjectV2ItemById.item
    if (added === null) {
      throw new Error(
        `GitHub did not return the Project item added for issue #${issue.number}.`,
      )
    }
    const item: CanonicalProjectItem = {
      id: added.id,
      archived: added.isArchived,
      repository: `${this.#repositoryOwner}/${this.#repositoryName}`,
      issueNumber: issue.number,
      kind: null,
      status: null,
    }
    this.#cacheIssueItem(issue.number, item)
    return item
  }

  async unarchiveIssue(
    issue: { number: number; state: 'OPEN' | 'CLOSED' },
    item: CanonicalProjectItem,
  ): Promise<CanonicalProjectItem> {
    if (!item.archived) return item
    if (issue.state !== 'OPEN') {
      throw new Error(
        `Closed issue #${issue.number} is not eligible to be restored to the Project.`,
      )
    }
    const context = this.#getSchemaContext()
    const data: {
      unarchiveProjectV2Item: { item: { id: string; isArchived: boolean } | null }
    } = await this.#client.graphql(
      `mutation RestoreProjectItem($projectId: ID!, $itemId: ID!) {
        unarchiveProjectV2Item(input: {projectId: $projectId, itemId: $itemId}) {
          item { id isArchived }
        }
      }`,
      { projectId: context.id, itemId: item.id },
    )
    const restored = data.unarchiveProjectV2Item.item
    if (restored === null || restored.isArchived) {
      throw new Error(
        `GitHub did not confirm restoration of issue #${issue.number} in the Project.`,
      )
    }
    item.archived = false
    return item
  }

  async setKind(item: CanonicalProjectItem, option: KindOption): Promise<boolean> {
    const context = this.#getSchemaContext()
    const field = this.#requireKindField(context)
    if (item.kind === option) return false
    await setCanonicalSingleSelect(this.#client, context.id, item.id, field, option)
    item.kind = option
    return true
  }

  async setStatus(item: CanonicalProjectItem, status: ProjectStatus): Promise<void> {
    const context = this.#getSchemaContext()
    const field = this.#requireField(context, 'Status', PROJECT_STATUS_OPTIONS)
    if (item.status === status) return
    await setCanonicalSingleSelect(this.#client, context.id, item.id, field, status)
    item.status = status
  }

  async #getContext(): Promise<ProjectContext> {
    const schema = this.#getSchemaContext()
    const items = await (this.#items ??= this.#loadItems(schema.id))
    this.#loadedItems = items
    return {
      ...schema,
      items,
    }
  }

  #getSchemaContext(): CanonicalProjectSchema {
    return this.#schemaContext
  }

  async #loadLiveSchemaContext(): Promise<CanonicalProjectSchema> {
    const projectData: {
      user: { projectV2: { id: string } | null } | null
    } = await this.#client.graphql(
      `query ProjectIdentity($owner: String!, $number: Int!) {
        user(login: $owner) { projectV2(number: $number) { id } }
      }`,
      { owner: this.#owner, number: this.#number },
    )
    const project = projectData.user?.projectV2
    if (project === null || project === undefined) {
      throw new Error(
        `User Project ${this.#owner}#${this.#number} was not found or the Project token cannot read it.`,
      )
    }
    return { id: project.id, fields: await this.#loadFields(project.id) }
  }

  async #getIssueItem(issueNumber: number): Promise<CanonicalProjectItem | undefined> {
    if (this.#itemLookup === 'enumerated') {
      const context = await this.#getContext()
      return context.items.get(
        projectItemKey(this.#repositoryOwner, this.#repositoryName, issueNumber),
      )
    }
    let pending = this.#issueItems.get(issueNumber)
    if (pending === undefined) {
      pending = this.#loadIssueItem(issueNumber)
      this.#issueItems.set(issueNumber, pending)
    }
    return pending
  }

  #cacheIssueItem(issueNumber: number, item: CanonicalProjectItem | undefined): void {
    if (this.#itemLookup === 'enumerated' && this.#loadedItems !== undefined) {
      const key = projectItemKey(this.#repositoryOwner, this.#repositoryName, issueNumber)
      if (item === undefined) this.#loadedItems.delete(key)
      else this.#loadedItems.set(key, item)
      return
    }
    this.#issueItems.set(issueNumber, Promise.resolve(item))
  }

  async #loadIssueItem(issueNumber: number): Promise<CanonicalProjectItem | undefined> {
    let cursor: string | null = null
    let result: CanonicalProjectItem | undefined
    do {
      const data: {
        repository: {
          issue: {
            projectItems: {
              nodes: IssueProjectItemNode[]
              pageInfo: PageInfo
            }
          } | null
        } | null
      } = await this.#client.graphql(
        `query IssueProjectItems($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              projectItems(first: 100, after: $after, includeArchived: true) {
                nodes {
                  project { id }
                  ${PROJECT_ITEM_FIELDS}
                }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }`,
        {
          owner: this.#repositoryOwner,
          name: this.#repositoryName,
          number: issueNumber,
          after: cursor,
        },
      )
      if (data.repository === null) {
        throw new Error(
          `The configured repository ${this.#repositoryOwner}/${this.#repositoryName} was not found or the Project token cannot read it.`,
        )
      }
      const issue = data.repository.issue
      if (issue === null) {
        throw new Error(
          `Issue #${issueNumber} was not found in ${this.#repositoryOwner}/${this.#repositoryName}.`,
        )
      }
      const connection = issue.projectItems
      for (const node of connection.nodes) {
        if (node.project?.id !== this.#configuration.id) continue
        const item = canonicalProjectItem(node)
        if (
          item === undefined ||
          projectItemKeyFromName(item.repository, item.issueNumber) !==
            projectItemKey(this.#repositoryOwner, this.#repositoryName, issueNumber)
        ) {
          continue
        }
        if (result !== undefined) {
          throw new Error(
            `The canonical Project contains more than one item for ${item.repository}#${item.issueNumber}.`,
          )
        }
        result = item
      }
      cursor = nextPageCursor(connection.pageInfo)
    } while (cursor !== null)
    return result
  }

  async #loadFields(projectId: string): Promise<CanonicalProjectField[]> {
    let cursor: string | null = null
    const fields: CanonicalProjectField[] = []
    do {
      const data: {
        node: {
          fields: {
            nodes: Array<{
              __typename: string
              id?: string
              name?: string
              dataType?: string
              options?: Array<{ id: string; name: string }>
            }>
            pageInfo: PageInfo
          }
        } | null
      } = await this.#client.graphql(
        `query ProjectFields($projectId: ID!, $after: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              fields(first: 100, after: $after) {
                nodes {
                  __typename
                  ... on ProjectV2Field { id name dataType }
                  ... on ProjectV2SingleSelectField { id name options { id name } }
                }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }`,
        { projectId, after: cursor },
      )
      const connection = data.node?.fields
      if (connection === undefined) {
        throw new Error('The canonical Project fields could not be read.')
      }
      fields.push(
        ...connection.nodes.map((field) => ({
          typename: field.__typename,
          ...(field.id === undefined ? {} : { id: field.id }),
          ...(field.name === undefined ? {} : { name: field.name }),
          ...(field.dataType === undefined ? {} : { dataType: field.dataType }),
          ...(field.options === undefined ? {} : { options: field.options }),
        })),
      )
      cursor = nextPageCursor(connection.pageInfo)
    } while (cursor !== null)
    return fields
  }

  async #loadItems(projectId: string): Promise<Map<string, CanonicalProjectItem>> {
    let cursor: string | null = null
    const items = new Map<string, CanonicalProjectItem>()
    do {
      const data: {
        node: {
          items: {
            nodes: ProjectItemNode[]
            pageInfo: PageInfo
          }
        } | null
      } = await this.#client.graphql(
        `query ProjectItems($projectId: ID!, $after: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: 100, after: $after) {
                nodes {
                  ${PROJECT_ITEM_FIELDS}
                }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }`,
        { projectId, after: cursor },
      )
      const connection = data.node?.items
      if (connection === undefined) {
        throw new Error('The canonical Project items could not be read.')
      }
      for (const item of connection.nodes) {
        const canonical = canonicalProjectItem(item)
        if (canonical === undefined) continue
        const key = projectItemKeyFromName(canonical.repository, canonical.issueNumber)
        if (items.has(key)) {
          throw new Error(
            `The canonical Project contains more than one item for ${canonical.repository}#${canonical.issueNumber}.`,
          )
        }
        items.set(key, canonical)
      }
      cursor = nextPageCursor(connection.pageInfo)
    } while (cursor !== null)
    return items
  }

  #requireField(
    context: CanonicalProjectSchema,
    name: string,
    expectedOptions: readonly string[],
  ): { id: string; options: Array<{ id: string; name: string }> } {
    return requireCanonicalSingleSelectField(
      context,
      name,
      expectedOptions,
      'single-select',
    )
  }

  #requireKindField(context: CanonicalProjectSchema): {
    id: string
    options: Array<{ id: string; name: string }>
  } {
    return this.#requireField(
      context,
      'Kind',
      KIND_DEFINITIONS.map((definition) => definition.option),
    )
  }
}

function auditConfiguredSchema(
  configured: CanonicalProjectSchema,
  live: CanonicalProjectSchema,
): string[] {
  const diagnostics: string[] = []
  if (live.id !== configured.id) {
    diagnostics.push(
      'The stored canonical Project node ID no longer matches the configured owner and number. Update canonical-project-config.ts before running Project mutations.',
    )
    return diagnostics
  }

  for (const expected of configured.fields) {
    if (expected.id === undefined || expected.name === undefined) continue
    const sameName = live.fields.filter((field) => field.name === expected.name)
    if (sameName.length > 1) {
      diagnostics.push(
        `The live canonical Project has more than one field named "${expected.name}". Remove the duplicate before updating stored configuration.`,
      )
      continue
    }
    const actual = live.fields.find((field) => field.id === expected.id)
    if (actual === undefined) {
      diagnostics.push(
        `The stored node ID for Project field "${expected.name}" is no longer present. Update canonical-project-config.ts from the provisioned field.`,
      )
      continue
    }
    if (actual.name !== expected.name) {
      diagnostics.push(
        `Project field "${expected.name}" was renamed to "${actual.name ?? 'an unreadable name'}". Restore the canonical name or update the stored contract deliberately.`,
      )
    }
    if (actual.typename !== expected.typename || actual.dataType !== expected.dataType) {
      diagnostics.push(
        `Project field "${expected.name}" no longer has its configured type. Restore the documented schema before running Project mutations.`,
      )
      continue
    }
    if (expected.typename !== 'ProjectV2SingleSelectField') continue
    const expectedOptions = expected.options ?? []
    const actualOptions = actual.options ?? []
    for (const expectedOption of expectedOptions) {
      const actualOption = actualOptions.find((option) => option.id === expectedOption.id)
      if (actualOption === undefined) {
        diagnostics.push(
          `The stored node ID for Project option "${expected.name} / ${expectedOption.name}" is no longer present. Update canonical-project-config.ts from the provisioned option.`,
        )
      } else if (actualOption.name !== expectedOption.name) {
        diagnostics.push(
          `Project option "${expected.name} / ${expectedOption.name}" was renamed to "${actualOption.name}". Restore the canonical name or update the stored contract deliberately.`,
        )
      }
    }
    const expectedOptionIds = new Set(expectedOptions.map((option) => option.id))
    for (const unexpected of actualOptions.filter(
      (option) => !expectedOptionIds.has(option.id),
    )) {
      diagnostics.push(
        `Project field "${expected.name}" has an unconfigured option named "${unexpected.name}". Remove it or add it to the stored contract deliberately.`,
      )
    }
  }
  return diagnostics
}

function canonicalProjectItem(
  item: Partial<ProjectItemNode>,
): CanonicalProjectItem | undefined {
  if (
    item.id === undefined ||
    item.isArchived === undefined ||
    item.content?.__typename !== 'Issue' ||
    item.content.number === undefined ||
    item.content.repository === undefined
  ) {
    return undefined
  }
  return {
    id: item.id,
    archived: item.isArchived,
    repository: item.content.repository.nameWithOwner,
    issueNumber: item.content.number,
    kind: singleSelectName(item.kind ?? null),
    status: singleSelectName(item.status ?? null),
  }
}

function singleSelectName(
  value: {
    __typename: string
    name?: string
  } | null,
): string | null {
  return value?.__typename === 'ProjectV2ItemFieldSingleSelectValue' &&
    value.name !== undefined
    ? value.name
    : null
}

function projectItemKey(owner: string, name: string, issueNumber: number): string {
  return projectItemKeyFromName(`${owner}/${name}`, issueNumber)
}

function projectItemKeyFromName(repository: string, issueNumber: number): string {
  const parts = repository.split('/')
  if (parts.length !== 2 || parts.some((part) => part === '')) {
    throw new Error('GitHub returned a Project item with an invalid repository name.')
  }
  return `${repository.toLowerCase()}#${issueNumber}`
}
