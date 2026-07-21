import { GitHubClient } from './github-client.ts'
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

interface ProjectField {
  typename: string
  id?: string
  name?: string
  options?: Array<{ id: string; name: string }>
}

interface ProjectSchemaContext {
  id: string
  fields: ProjectField[]
}

interface ProjectContext extends ProjectSchemaContext {
  items: Map<string, CanonicalProjectItem>
}

export class GitHubCanonicalProject {
  readonly #owner: string
  readonly #number: number
  readonly #repositoryOwner: string
  readonly #repositoryName: string
  readonly #client: GitHubClient
  #schemaContext?: Promise<ProjectSchemaContext>
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
    const schema = await this.#getSchemaContext()
    const items = await (this.#items = this.#loadItems(schema.id))
    return items.get(
      projectItemKey(this.#repositoryOwner, this.#repositoryName, issueNumber),
    )
  }

  async validatePlanningSchema(): Promise<void> {
    const context = await this.#getSchemaContext()
    this.#requireKindField(context)
    this.#requireField(context, 'Status', PROJECT_STATUS_OPTIONS)
  }

  async validateKindSchema(): Promise<void> {
    this.#requireKindField(await this.#getSchemaContext())
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
    await this.#setSingleSelect(context.id, item.id, field.id, field.options, option)
    item.kind = option
    return true
  }

  async setStatus(item: CanonicalProjectItem, status: ProjectStatus): Promise<boolean> {
    const context = await this.#getContext()
    const field = this.#requireField(context, 'Status', PROJECT_STATUS_OPTIONS)
    if (item.status === status) return false
    await this.#setSingleSelect(context.id, item.id, field.id, field.options, status)
    item.status = status
    return true
  }

  async #getContext(): Promise<ProjectContext> {
    const schema = await this.#getSchemaContext()
    return {
      ...schema,
      items: await (this.#items ??= this.#loadItems(schema.id)),
    }
  }

  async #getSchemaContext(): Promise<ProjectSchemaContext> {
    return (this.#schemaContext ??= this.#loadSchemaContext())
  }

  async #loadSchemaContext(): Promise<ProjectSchemaContext> {
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

  async #loadFields(projectId: string): Promise<ProjectField[]> {
    let cursor: string | null = null
    const fields: ProjectField[] = []
    do {
      const data: {
        node: {
          fields: {
            nodes: Array<{
              __typename: string
              id?: string
              name?: string
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
                  ... on ProjectV2Field { id name }
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
            nodes: Array<{
              id: string
              isArchived: boolean
              content: null | {
                __typename: string
                number?: number
                repository?: { nameWithOwner: string }
              }
              kind: null | { __typename: string; name?: string }
              status: null | { __typename: string; name?: string }
            }>
            pageInfo: PageInfo
          }
        } | null
      } = await this.#client.graphql(
        `query ProjectItems($projectId: ID!, $after: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: 100, after: $after) {
                nodes {
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
        if (
          item.content?.__typename !== 'Issue' ||
          item.content.number === undefined ||
          item.content.repository === undefined
        ) {
          continue
        }
        const repository = item.content.repository.nameWithOwner
        const key = projectItemKeyFromName(repository, item.content.number)
        if (items.has(key)) {
          throw new Error(
            `The canonical Project contains more than one item for ${repository}#${item.content.number}.`,
          )
        }
        items.set(key, {
          id: item.id,
          archived: item.isArchived,
          repository,
          issueNumber: item.content.number,
          kind: singleSelectName(item.kind),
          status: singleSelectName(item.status),
        })
      }
      cursor = nextPageCursor(connection.pageInfo)
    } while (cursor !== null)
    return items
  }

  #requireField(
    context: ProjectSchemaContext,
    name: string,
    expectedOptions: readonly string[],
  ): { id: string; options: Array<{ id: string; name: string }> } {
    const matches = context.fields.filter((field) => field.name === name)
    if (matches.length === 0) {
      throw new Error(
        `Project field "${name}" is missing. Reconcile the documented single-select schema before retrying.`,
      )
    }
    if (matches.length > 1) {
      throw new Error(`The canonical Project has more than one field named "${name}".`)
    }
    const field = matches[0]!
    if (
      field.typename !== 'ProjectV2SingleSelectField' ||
      field.id === undefined ||
      field.options === undefined
    ) {
      throw new Error(`Project field "${name}" exists but is not a single-select field.`)
    }
    const available = new Set(field.options.map((option) => option.name))
    for (const option of expectedOptions) {
      if (!available.has(option)) {
        throw new Error(
          `Project field "${name}" is missing the expected "${option}" option. Reconcile the documented schema before retrying.`,
        )
      }
    }
    return { id: field.id, options: field.options }
  }

  #requireKindField(context: ProjectSchemaContext): {
    id: string
    options: Array<{ id: string; name: string }>
  } {
    return this.#requireField(
      context,
      'Kind',
      KIND_DEFINITIONS.map((definition) => definition.option),
    )
  }

  async #setSingleSelect(
    projectId: string,
    itemId: string,
    fieldId: string,
    options: Array<{ id: string; name: string }>,
    value: string,
  ): Promise<void> {
    const optionId = options.find((option) => option.name === value)?.id
    if (optionId === undefined) {
      throw new Error(`Unexpected Project option after schema validation: "${value}".`)
    }
    await this.#client.graphql(
      `mutation SetProjectSingleSelect($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: {singleSelectOptionId: $optionId}
        }) { projectV2Item { id } }
      }`,
      { projectId, itemId, fieldId, optionId },
    )
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
