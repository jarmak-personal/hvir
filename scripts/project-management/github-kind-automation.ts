import type {
  IssueSnapshot,
  KindAutomationPort,
  ProjectKindSyncResult,
} from './kind-reconciler.ts'
import { KIND_DEFINITIONS } from './kind-policy.ts'

const GRAPHQL_URL = 'https://api.github.com/graphql'
const REST_URL = 'https://api.github.com'
const MAX_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 15_000

type FetchImplementation = typeof fetch

export interface GitHubKindAutomationOptions {
  repositoryOwner: string
  repositoryName: string
  projectOwner: string
  projectNumber: number
  repositoryToken: string
  projectToken: string
  fetchImplementation?: FetchImplementation
  wait?: (milliseconds: number) => Promise<void>
}

interface GraphqlEnvelope<T> {
  data?: T
  errors?: Array<{ message?: string; type?: string }>
}

interface PageInfo {
  endCursor: string | null
  hasNextPage: boolean
}

interface ProjectItemState {
  id: string
  archived: boolean
  currentOption?: string
}

interface ProjectContext {
  id: string
  fieldId: string
  optionIds: Map<string, string>
  items: Map<string, ProjectItemState>
}

export class GitHubKindAutomation implements KindAutomationPort {
  readonly #repositoryOwner: string
  readonly #repositoryName: string
  readonly #projectOwner: string
  readonly #projectNumber: number
  readonly #repositoryToken: string
  readonly #projectToken: string
  readonly #fetch: FetchImplementation
  readonly #wait: (milliseconds: number) => Promise<void>
  #projectContext?: Promise<ProjectContext>

  constructor(options: GitHubKindAutomationOptions) {
    this.#repositoryOwner = options.repositoryOwner
    this.#repositoryName = options.repositoryName
    this.#projectOwner = options.projectOwner
    this.#projectNumber = options.projectNumber
    this.#repositoryToken = requireToken(options.repositoryToken, 'repository')
    this.#projectToken = requireToken(options.projectToken, 'Project')
    this.#fetch = options.fetchImplementation ?? fetch
    this.#wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  async getIssue(issueNumber: number): Promise<IssueSnapshot> {
    let cursor: string | null = null
    let snapshot: Omit<IssueSnapshot, 'labels'> | undefined
    const labels: string[] = []

    do {
      const data: {
        repository: {
          issue: {
            id: string
            number: number
            state: 'OPEN' | 'CLOSED'
            updatedAt: string
            labels: { nodes: Array<{ name: string }>; pageInfo: PageInfo }
          } | null
        } | null
      } = await this.#graphql(
        this.#repositoryToken,
        `query IssueKind($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              id number state updatedAt
              labels(first: 100, after: $after) {
                nodes { name }
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
      const issue = data.repository?.issue
      if (issue === null || issue === undefined) {
        throw new Error(
          `Issue #${issueNumber} was not found in the configured repository.`,
        )
      }
      snapshot ??= {
        id: issue.id,
        number: issue.number,
        state: issue.state,
        updatedAt: issue.updatedAt,
      }
      labels.push(...issue.labels.nodes.map((label) => label.name))
      cursor = issue.labels.pageInfo.hasNextPage ? issue.labels.pageInfo.endCursor : null
    } while (cursor !== null)

    if (snapshot === undefined) {
      throw new Error(`Issue #${issueNumber} could not be loaded.`)
    }
    return { ...snapshot, labels }
  }

  async listOpenIssues(): Promise<IssueSnapshot[]> {
    let cursor: string | null = null
    const issues: IssueSnapshot[] = []

    do {
      const data: {
        repository: {
          issues: {
            nodes: Array<{
              id: string
              number: number
              state: 'OPEN'
              updatedAt: string
              labels: { nodes: Array<{ name: string }>; pageInfo: PageInfo }
            }>
            pageInfo: PageInfo
          }
        } | null
      } = await this.#graphql(
        this.#repositoryToken,
        `query OpenIssueKinds($owner: String!, $name: String!, $after: String) {
          repository(owner: $owner, name: $name) {
            issues(first: 100, after: $after, states: OPEN, orderBy: {field: CREATED_AT, direction: ASC}) {
              nodes {
                id number state updatedAt
                labels(first: 100) {
                  nodes { name }
                  pageInfo { endCursor hasNextPage }
                }
              }
              pageInfo { endCursor hasNextPage }
            }
          }
        }`,
        { owner: this.#repositoryOwner, name: this.#repositoryName, after: cursor },
      )
      const connection = data.repository?.issues
      if (connection === undefined) {
        throw new Error('The configured repository was not found or is not readable.')
      }
      for (const issue of connection.nodes) {
        if (issue.labels.pageInfo.hasNextPage) {
          issues.push(await this.getIssue(issue.number))
        } else {
          issues.push({
            id: issue.id,
            number: issue.number,
            state: issue.state,
            updatedAt: issue.updatedAt,
            labels: issue.labels.nodes.map((label) => label.name),
          })
        }
      }
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null
    } while (cursor !== null)

    return issues
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return
    await this.#rest(
      this.#repositoryToken,
      `/repos/${encodeURIComponent(this.#repositoryOwner)}/${encodeURIComponent(this.#repositoryName)}/issues/${issueNumber}/labels`,
      { method: 'POST', body: JSON.stringify({ labels }) },
    )
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const response = await this.#request(
      this.#repositoryToken,
      `${REST_URL}/repos/${encodeURIComponent(this.#repositoryOwner)}/${encodeURIComponent(this.#repositoryName)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE' },
    )
    if (!response.ok && response.status !== 404) {
      throw new Error(`GitHub rejected a label removal with HTTP ${response.status}.`)
    }
  }

  async syncProjectKind(
    issue: IssueSnapshot,
    option: string,
    apply: boolean,
  ): Promise<ProjectKindSyncResult> {
    const context = await (this.#projectContext ??= this.#loadProjectContext())
    const optionId = context.optionIds.get(option)
    if (optionId === undefined) {
      throw new Error(
        `Project field "Kind" is missing the expected "${option}" option. Reconcile the documented schema before retrying.`,
      )
    }

    const key = projectItemKey(this.#repositoryOwner, this.#repositoryName, issue.number)
    let item = context.items.get(key)
    if (item?.archived === true) {
      throw new Error(
        `Issue #${issue.number} has an archived item in the canonical Project.`,
      )
    }
    if (item?.currentOption === option) {
      return { action: 'unchanged', issueAdded: false }
    }
    if (!apply) {
      return {
        action: item === undefined ? 'would-add-item' : 'would-update',
        issueAdded: false,
      }
    }

    let issueAdded = false
    if (item === undefined) {
      const data: {
        addProjectV2ItemById: { item: { id: string; isArchived: boolean } | null }
      } = await this.#graphql(
        this.#projectToken,
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
      item = { id: added.id, archived: added.isArchived }
      context.items.set(key, item)
      issueAdded = true
    }

    await this.#graphql(
      this.#projectToken,
      `mutation SetProjectKind($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: {singleSelectOptionId: $optionId}
        }) { projectV2Item { id } }
      }`,
      {
        projectId: context.id,
        itemId: item.id,
        fieldId: context.fieldId,
        optionId,
      },
    )
    item.currentOption = option
    return {
      action: issueAdded ? 'added-and-updated' : 'updated',
      issueAdded,
    }
  }

  async #loadProjectContext(): Promise<ProjectContext> {
    const projectData: {
      user: { projectV2: { id: string } | null } | null
    } = await this.#graphql(
      this.#projectToken,
      `query ProjectIdentity($owner: String!, $number: Int!) {
        user(login: $owner) { projectV2(number: $number) { id } }
      }`,
      { owner: this.#projectOwner, number: this.#projectNumber },
    )
    const project = projectData.user?.projectV2
    if (project === null || project === undefined) {
      throw new Error(
        `User Project ${this.#projectOwner}#${this.#projectNumber} was not found or the Project token cannot read it.`,
      )
    }

    const field = await this.#loadKindField(project.id)
    const optionIds = new Map(field.options.map((option) => [option.name, option.id]))
    for (const definition of KIND_DEFINITIONS) {
      if (!optionIds.has(definition.option)) {
        throw new Error(
          `Project field "Kind" is missing the expected "${definition.option}" option. Reconcile the documented schema before retrying.`,
        )
      }
    }

    return {
      id: project.id,
      fieldId: field.id,
      optionIds,
      items: await this.#loadProjectItems(project.id),
    }
  }

  async #loadKindField(
    projectId: string,
  ): Promise<{ id: string; options: Array<{ id: string; name: string }> }> {
    let cursor: string | null = null
    let match: { id: string; options: Array<{ id: string; name: string }> } | undefined

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
      } = await this.#graphql(
        this.#projectToken,
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
      for (const field of connection.nodes) {
        if (field.name !== 'Kind') continue
        if (
          field.__typename !== 'ProjectV2SingleSelectField' ||
          field.id === undefined ||
          field.options === undefined
        ) {
          throw new Error('Project field "Kind" exists but is not a single-select field.')
        }
        if (match !== undefined) {
          throw new Error('The canonical Project has more than one field named "Kind".')
        }
        match = { id: field.id, options: field.options }
      }
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null
    } while (cursor !== null)

    if (match === undefined) {
      throw new Error(
        'Project field "Kind" is missing. Create the documented single-select schema before retrying.',
      )
    }
    return match
  }

  async #loadProjectItems(projectId: string): Promise<Map<string, ProjectItemState>> {
    let cursor: string | null = null
    const items = new Map<string, ProjectItemState>()

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
              fieldValueByName: null | {
                __typename: string
                name?: string
                optionId?: string
              }
            }>
            pageInfo: PageInfo
          }
        } | null
      } = await this.#graphql(
        this.#projectToken,
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
                  fieldValueByName(name: "Kind") {
                    __typename
                    ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
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
        const [owner, name] = item.content.repository.nameWithOwner.split('/')
        if (owner === undefined || name === undefined) {
          throw new Error(
            'GitHub returned a Project item with an invalid repository name.',
          )
        }
        items.set(projectItemKey(owner, name, item.content.number), {
          id: item.id,
          archived: item.isArchived,
          currentOption:
            item.fieldValueByName?.__typename === 'ProjectV2ItemFieldSingleSelectValue'
              ? item.fieldValueByName.name
              : undefined,
        })
      }
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null
    } while (cursor !== null)

    return items
  }

  async #graphql<T>(token: string, query: string, variables: object): Promise<T> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await this.#request(token, GRAPHQL_URL, {
        method: 'POST',
        body: JSON.stringify({ query, variables }),
      })
      if (!response.ok) {
        throw new Error(`GitHub GraphQL request failed with HTTP ${response.status}.`)
      }
      const envelope = (await response.json()) as GraphqlEnvelope<T>
      if (envelope.errors !== undefined && envelope.errors.length > 0) {
        if (hasRateLimitError(envelope.errors) && attempt < MAX_ATTEMPTS) {
          await this.#wait(250 * 2 ** (attempt - 1))
          continue
        }
        const messages = envelope.errors.map(
          (error) => error.message ?? error.type ?? 'unknown error',
        )
        throw new Error(`GitHub GraphQL request failed: ${messages.join('; ')}`)
      }
      if (envelope.data === undefined) {
        throw new Error('GitHub GraphQL returned no data.')
      }
      return envelope.data
    }
    throw new Error(`GitHub GraphQL rate limit persisted after ${MAX_ATTEMPTS} attempts.`)
  }

  async #rest(token: string, path: string, init: RequestInit): Promise<unknown> {
    const response = await this.#request(token, `${REST_URL}${path}`, init)
    if (!response.ok) {
      throw new Error(`GitHub REST request failed with HTTP ${response.status}.`)
    }
    if (response.status === 204) return undefined
    return response.json()
  }

  async #request(token: string, url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await this.#fetch(url, {
          ...init,
          signal: controller.signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...init.headers,
          },
        })
        if (!shouldRetry(response) || attempt === MAX_ATTEMPTS) {
          return response
        }
        lastError = new Error(`GitHub temporarily returned HTTP ${response.status}.`)
      } catch (error) {
        lastError = error
        if (attempt === MAX_ATTEMPTS) break
      } finally {
        clearTimeout(timeout)
      }
      await this.#wait(250 * 2 ** (attempt - 1))
    }

    const reason =
      lastError instanceof Error && lastError.name === 'AbortError'
        ? 'timed out'
        : 'failed'
    throw new Error(`GitHub request ${reason} after ${MAX_ATTEMPTS} bounded attempts.`)
  }
}

function hasRateLimitError(errors: Array<{ message?: string; type?: string }>): boolean {
  return errors.some(
    (error) =>
      error.type === 'RATE_LIMITED' ||
      error.message?.toLowerCase().includes('rate limit') === true,
  )
}

function shouldRetry(response: Response): boolean {
  return (
    response.status === 429 ||
    response.status >= 500 ||
    (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
  )
}

function requireToken(value: string, purpose: string): string {
  if (value.trim() === '') {
    throw new Error(`A ${purpose} token is required.`)
  }
  return value
}

function projectItemKey(owner: string, name: string, issueNumber: number): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}#${issueNumber}`
}
