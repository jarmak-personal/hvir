import { sumTokenTotals } from './session-token-allocation.ts'
import { GitHubClient } from './github-client.ts'
import { CANONICAL_PROJECT_CONFIGURATION } from './canonical-project-config.ts'
import { nextPageCursor, type PageInfo } from './github-pagination.ts'
import { GitHubSessionTokens } from './github-session-tokens.ts'
import { serializeTokenMigration } from './contributor-token-migration.ts'
import { clearCanonicalField, setCanonicalNumber } from './canonical-project-fields.ts'
import {
  planTokenMigration,
  TOKEN_DELETION_TARGETS,
  TOKEN_FIELD_TARGETS,
  type TokenMigrationSnapshot,
} from './token-migration-plan.ts'
import { migratedTokenHistory } from './session-token-receipts.ts'

/** Full Project inventory includes archived items explicitly; no state filter drops closed issues. */
export async function readTokenMigrationSnapshot(
  project: GitHubClient,
  repository: GitHubClient,
): Promise<TokenMigrationSnapshot> {
  const snapshot: TokenMigrationSnapshot = {
    schema: 1,
    project: CANONICAL_PROJECT_CONFIGURATION.id,
    fields: [],
    items: [],
    corrections: [],
  }
  let after: string | null = null
  do {
    const data: {
      node: {
        fields: {
          nodes: { id: string; name: string; dataType: string }[]
          pageInfo: PageInfo
        }
      } | null
    } = await project.graphql(
      `query TokenMigrationFields($id:ID!,$after:String) { node(id:$id) { ... on ProjectV2 {
        fields(first:100,after:$after) { nodes { ... on ProjectV2FieldCommon { id name dataType } } pageInfo { endCursor hasNextPage } }
      } } }`,
      { id: snapshot.project, after },
    )
    if (!data.node) throw new Error('Project migration schema unavailable.')
    snapshot.fields.push(...data.node.fields.nodes)
    after = nextPageCursor(data.node.fields.pageInfo)
  } while (after !== null)
  const retainedIds = new Set(
    [...TOKEN_DELETION_TARGETS, ...TOKEN_FIELD_TARGETS].map((row) => row.id!),
  )
  const tokens = new GitHubSessionTokens(repository, 'jarmak-personal', 'hvir')
  do {
    type Node = {
      id: string
      isArchived: boolean
      content: {
        __typename: string
        number?: number
        repository?: { nameWithOwner: string }
        parent?: { number: number } | null
        subIssues?: { nodes: { number: number }[]; pageInfo: PageInfo }
        labels?: { nodes: { name: string }[]; pageInfo: PageInfo }
      } | null
      fieldValues: {
        nodes: { field?: { id: string }; number?: number; text?: string; name?: string }[]
        pageInfo: PageInfo
      }
    }
    const data: { node: { items: { nodes: Node[]; pageInfo: PageInfo } } | null } =
      await project.graphql(
        `query TokenMigrationItems($id:ID!,$after:String) { node(id:$id) { ... on ProjectV2 {
        items(first:100,after:$after,archivedStates:[ARCHIVED,NOT_ARCHIVED]) { nodes { id isArchived
          fieldValues(first:100) { nodes {
            ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id } } }
            ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id } } }
            ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { id } } }
          } pageInfo { endCursor hasNextPage } }
          content { __typename ... on Issue { number repository { nameWithOwner } parent { number }
            subIssues(first:100) { nodes { number } pageInfo { endCursor hasNextPage } }
            labels(first:100) { nodes { name } pageInfo { endCursor hasNextPage } }
          } }
        } pageInfo { endCursor hasNextPage } }
      } } }`,
        { id: snapshot.project, after },
      )
    if (!data.node) throw new Error('Project migration inventory unavailable.')
    for (const row of data.node.items.nodes) {
      if (
        row.fieldValues.pageInfo.hasNextPage ||
        row.content?.subIssues?.pageInfo.hasNextPage ||
        row.content?.labels?.pageInfo.hasNextPage
      )
        throw new Error(
          'Migration nested inventory exceeds bounded page; evidence incomplete.',
        )
      const values: Record<string, string | number | null> = {}
      for (const id of retainedIds) values[id] = null
      for (const field of row.fieldValues.nodes)
        if (field.field && retainedIds.has(field.field.id))
          values[field.field.id] = field.number ?? field.text ?? field.name ?? null
      const issue =
        row.content?.__typename === 'Issue' &&
        row.content.repository?.nameWithOwner ===
          CANONICAL_PROJECT_CONFIGURATION.repository
          ? row.content.number!
          : null
      snapshot.items.push({
        id: row.id,
        archived: row.isArchived,
        issue,
        parent: row.content?.parent?.number ?? null,
        children: row.content?.subIssues?.nodes.map((child) => child.number) ?? [],
        epic:
          row.content?.labels?.nodes.some((label) => label.name === 'kind:epic') ?? false,
        values,
        history:
          issue === null
            ? { receipts: [], legacy: false, diagnostics: [] }
            : await tokens.read(issue),
      })
    }
    after = nextPageCursor(data.node.items.pageInfo)
  } while (after !== null)
  return snapshot
}

/** The saved input is reviewable evidence, never authority to bypass fresh source comparison. */
export async function applyTokenMigration(
  project: GitHubClient,
  repository: GitHubClient,
  snapshot: TokenMigrationSnapshot,
  apply: boolean,
  remove: boolean,
) {
  const plan = planTokenMigration(snapshot)
  const operations: string[] = []
  if (plan.diagnostics.length || !apply) return { ...plan, operations }
  const live = await readTokenMigrationSnapshot(project, repository)
  if (
    live.items.length !== snapshot.items.length ||
    live.items.some(
      (row) =>
        !snapshot.items.some(
          (old) =>
            row.id === old.id &&
            row.issue === old.issue &&
            row.archived === old.archived &&
            row.parent === old.parent &&
            JSON.stringify(row.children) === JSON.stringify(old.children),
        ),
    )
  )
    throw new Error(
      'Project membership or native relationships changed; refresh migration evidence.',
    )
  for (const field of live.fields) {
    const original = snapshot.fields.find((row) => row.id === field.id)
    const target = TOKEN_FIELD_TARGETS.find((row) => row.id === field.id)
    if (
      !original ||
      field.dataType !== original.dataType ||
      (field.name !== original.name && field.name !== target?.name)
    )
      throw new Error('Project schema changed; refresh migration evidence.')
  }
  for (const original of snapshot.fields)
    if (
      !live.fields.some((row) => row.id === original.id) &&
      !plan.deletions.some((row) => row.id === original.id)
    )
      throw new Error('Required Project field missing.')
  const current = planTokenMigration({
    ...snapshot,
    items: snapshot.items.map((item) => {
      const history = live.items.find((row) => row.id === item.id)!.history
      const receipt = plan.receipts.find((row) => row.issue === item.issue)
      return {
        ...item,
        history: { ...history, ...(receipt ? { migrations: [receipt] } : {}) },
      }
    }),
  })
  if (current.diagnostics.length)
    throw new Error('Current migration contributions conflict.')
  for (const row of live.items) {
    const original = snapshot.items.find((old) => old.id === row.id)!
    const projection = current.projections.find((value) => value.item === row.id)
    for (const [id, value] of Object.entries(row.values)) {
      const target = TOKEN_FIELD_TARGETS.find((field) => field.id === id)
      if (
        value !== original.values[id] &&
        !(target && projection && value === projection.totals[target.key]) &&
        live.fields.some((field) => field.id === id)
      )
        throw new Error(
          'Source Project values changed; preserve and reconcile new evidence.',
        )
    }
    const receipt = plan.receipts.find((value) => value.issue === row.issue)
    const migrations = row.history.migrations ?? []
    if (migrations.some((value) => JSON.stringify(value) !== JSON.stringify(receipt)))
      throw new Error('Migration receipt conflict.')
    if (row.history.diagnostics.length) throw new Error('Incomplete receipt evidence.')
    if (
      receipt &&
      migratedTokenHistory({ ...row.history, migrations: [receipt] }).diagnostics.length
    )
      throw new Error('Saved receipt coverage no longer matches live evidence.')
  }
  // Preserve originals durably before any field overwrite or deletion. Repeated identical
  // comments are harmless if a previous successful append lost its response.
  for (const receipt of plan.receipts) {
    const row = live.items.find((item) => item.issue === receipt.issue)!
    if (!row.history.migrations?.length) {
      const body = serializeTokenMigration(receipt)
      const response = await repository.requestRestOnce(
        `/repos/jarmak-personal/hvir/issues/${receipt.issue}/comments`,
        { method: 'POST', body: JSON.stringify({ body }) },
      )
      if (!response.ok)
        throw new Error('Migration append uncertain; retry the saved evidence.')
      const posted = (await response.json()) as {
        body?: string
        user?: { login?: string }
        created_at?: string
        updated_at?: string
      }
      if (
        posted.body !== body ||
        posted.user?.login?.toLowerCase() !== 'jarmak-personal' ||
        !posted.created_at ||
        posted.created_at !== posted.updated_at
      )
        throw new Error('Migration append uncertain; retry the saved evidence.')
      row.history.migrations = [receipt]
      operations.push(`preserved:#${receipt.issue}`)
    }
  }
  for (const rename of plan.renames) {
    if (live.fields.find((field) => field.id === rename.id)?.name === rename.to) continue
    await project.graphql(
      `mutation RenameTokenField($id:ID!,$name:String!) { updateProjectV2Field(input:{fieldId:$id,name:$name}) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }`,
      { id: rename.id, name: rename.to },
    )
    operations.push(`renamed:${rename.to}`)
  }
  // Add captures that arrived since the saved snapshot using its exact covered maxima.
  for (const projection of plan.projections) {
    const item = live.items.find((row) => row.id === projection.item)!
    const participants = [
      item,
      ...(item.epic
        ? item.children.map((number) => live.items.find((row) => row.issue === number)!)
        : []),
    ]
    const rows = participants.map((row) => migratedTokenHistory(row.history))
    if (rows.some((row) => row.diagnostics.length))
      throw new Error('Migration projection evidence incomplete.')
    const totals = sumTokenTotals(rows)
    for (const field of TOKEN_FIELD_TARGETS) {
      const value = totals[field.key]
      if (item.values[field.id] === value) continue
      if (value === null)
        await clearCanonicalField(project, live.project, item.id, field.id)
      else await setCanonicalNumber(project, live.project, item.id, field.id, value)
      operations.push(`projected:#${projection.issue}:${field.name}`)
    }
  }
  if (remove) {
    // Freshly re-read every receipt and value before irreversibly deleting source columns.
    const verified = await readTokenMigrationSnapshot(project, repository)
    if (
      verified.items.length !== live.items.length ||
      verified.items.some(
        (row) =>
          !live.items.some(
            (old) =>
              row.id === old.id &&
              row.issue === old.issue &&
              row.archived === old.archived &&
              row.parent === old.parent &&
              JSON.stringify(row.children) === JSON.stringify(old.children),
          ),
      )
    )
      throw new Error('Project inventory changed before deletion.')
    for (const item of verified.items) {
      const before = live.items.find((row) => row.id === item.id)!
      for (const field of plan.deletions) {
        if (
          verified.fields.some((row) => row.id === field.id) &&
          item.values[field.id] !== before.values[field.id]
        )
          throw new Error(
            'Retired source values changed before deletion; preserve new evidence.',
          )
      }
    }
    const expected = planTokenMigration({
      ...verified,
      corrections: snapshot.corrections,
    })
    if (expected.diagnostics.length)
      throw new Error('Deletion reconciliation incomplete.')
    for (const projection of expected.projections) {
      const item = verified.items.find((row) => row.id === projection.item)!
      for (const field of TOKEN_FIELD_TARGETS)
        if (item.values[field.id] !== projection.totals[field.key])
          throw new Error('Deletion projection changed; retry reconciliation.')
    }
    for (const deletion of plan.deletions) {
      const field = verified.fields.find((row) => row.id === deletion.id)
      if (!field) continue
      if (field.name !== deletion.name) throw new Error('Deletion target changed.')
      await project.graphql(
        `mutation DeleteRetiredTokenField($id:ID!) { deleteProjectV2Field(input:{fieldId:$id}) { deletedFieldId } }`,
        { id: deletion.id },
      )
      operations.push(`deleted:${deletion.id}`)
    }
  }
  return { ...plan, operations }
}
