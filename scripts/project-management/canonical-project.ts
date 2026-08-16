import { GitHubClient } from './github-client.ts'
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
  #schemaContext?: Promise<CanonicalProjectSchema>
  #items?: Promise<Map<string, CanonicalProjectItem>>

  constructor(options: GitHubCanonicalProjectOptions) {
    this.#owner = options.owner
    this.#number = options.number
    this.#repositoryOwner = options.repositoryOwner
    this.#repositoryName = options.repositoryName
    this.#client = options.client
  }

  async getIssueItem(issueNumber: number): Promise<CanonicalProjectItem | undefined> {
    const context = await this.#getContext()
    return context.items.get(
      projectItemKey(this.#repositoryOwner, this.#repositoryName, issueNumber),
    )
  }

  async refreshIssueItem(issueNumber: number): Promise<CanonicalProjectItem | undefined> {
    const context = await this.#getContext()
    const key = projectItemKey(this.#repositoryOwner, this.#repositoryName, issueNumber)
    const current = context.items.get(key)
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
      context.items.delete(key)
      return undefined
    }
    const refreshed = canonicalProjectItem(data.node)
    if (refreshed === undefined) {
      context.items.delete(key)
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
    context.items.set(key, refreshed)
    return refreshed
  }

  async validatePlanningSchema(): Promise<void> {
    const context = await this.#getSchemaContext()
    this.#requireKindField(context)
    this.#requireField(context, 'Status', PROJECT_STATUS_OPTIONS)
  }

  async validateKindSchema(): Promise<void> {
    this.#requireKindField(await this.#getSchemaContext())
  }

  async readAgentWorkProjection(issueNumber: number): Promise<AgentWorkProjectValues> {
    const context = await this.#getContext()
    return readAgentWorkProjectValues({
      client: this.#client,
      schema: context,
      item: context.items.get(
        projectItemKey(this.#repositoryOwner, this.#repositoryName, issueNumber),
      ),
      issueNumber,
    })
  }

  async setAgentWorkProjectionField(
    issueNumber: number,
    name: AgentWorkProjectFieldName,
    value: AgentWorkProjectValue | undefined,
  ): Promise<void> {
    const context = await this.#getContext()
    await setAgentWorkProjectValue({
      client: this.#client,
      schema: context,
      item: context.items.get(
        projectItemKey(this.#repositoryOwner, this.#repositoryName, issueNumber),
      ),
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
    const context = await this.#getContext()
    const key = projectItemKey(this.#repositoryOwner, this.#repositoryName, issue.number)
    const existing = context.items.get(key)
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
    context.items.set(key, item)
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
    const context = await this.#getContext()
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
    const context = await this.#getContext()
    const field = this.#requireKindField(context)
    if (item.kind === option) return false
    await setCanonicalSingleSelect(this.#client, context.id, item.id, field, option)
    item.kind = option
    return true
  }

  async setStatus(item: CanonicalProjectItem, status: ProjectStatus): Promise<void> {
    const context = await this.#getContext()
    const field = this.#requireField(context, 'Status', PROJECT_STATUS_OPTIONS)
    if (item.status === status) return
    await setCanonicalSingleSelect(this.#client, context.id, item.id, field, status)
    item.status = status
  }

  async #getContext(): Promise<ProjectContext> {
    const schema = await this.#getSchemaContext()
    return {
      ...schema,
      items: await (this.#items ??= this.#loadItems(schema.id)),
    }
  }

  async #getSchemaContext(): Promise<CanonicalProjectSchema> {
    return (this.#schemaContext ??= this.#loadSchemaContext())
  }

  async #loadSchemaContext(): Promise<CanonicalProjectSchema> {
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
