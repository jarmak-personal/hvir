import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { SKILLAGER_AGENTS, type SkillagerAgent } from '../../../shared/skillager'
import type {
  SkillagerExposureEntry,
  SkillagerExposureMode,
  SkillagerExposurePreview,
} from '../../../shared/skillager-exposure'
import { ConfirmationDialog } from '../workbench/ConfirmationDialog'
import type { SkillagerExposureController } from './use-skillager-exposure'

export function SkillagerExposureDialog({
  controller,
}: {
  readonly controller: SkillagerExposureController
}): ReactElement | null {
  const state = controller.state
  if (!state) return null
  const busy = Boolean(state.loading || state.applying),
    preview = state.preview
  const label =
    state.action === 'remove'
      ? 'Remove workspace copy'
      : state.action === 'change'
        ? 'Change workspace mode'
        : 'Add to project'
  return createPortal(
    <ConfirmationDialog
      key={`${preview?.previewId ?? 'choose'}:${state.used ?? false}`}
      labelledBy="skillager-exposure-title"
      className="skillager-exposure-dialog"
      busy={busy}
      actions={[
        {
          label: state.used ? 'Close' : 'Cancel',
          kind: 'cancel',
          onSelect: controller.close,
        },
        ...(!state.used
          ? [
              {
                label: preview ? 'Confirm exact changes' : 'Preview changes',
                kind:
                  state.action === 'remove'
                    ? ('destructive' as const)
                    : ('primary' as const),
                disabled: !state.destination,
                onSelect: () => {
                  void (preview ? controller.apply() : controller.preview())
                },
              },
            ]
          : []),
      ]}
    >
      <h2 id="skillager-exposure-title">{label}</h2>
      <p>
        <strong>{state.metadata.name}</strong> · <code>{state.metadata.id}</code> ·
        Personal library
      </p>
      {!preview && state.action === 'add' ? (
        <div className="skillager-destination-fields">
          <label>
            Project
            <select
              aria-label="Destination project"
              value={state.destination?.projectId ?? ''}
              disabled={busy}
              onChange={(event) =>
                controller.choose({
                  destination: controller.destinations.find(
                    (item) => item.projectId === event.currentTarget.value,
                  ),
                })
              }
            >
              <option value="">Choose a registered project</option>
              {[
                ...new Map(
                  controller.destinations.map((item) => [
                    item.projectId,
                    item.projectName,
                  ]),
                ).entries(),
              ].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Worktree
            <select
              aria-label="Destination worktree"
              value={state.destination?.workspaceId ?? ''}
              disabled={busy || !state.destination}
              onChange={(event) =>
                controller.choose({
                  destination: controller.destinations.find(
                    (item) =>
                      item.projectId === state.destination?.projectId &&
                      item.workspaceId === event.currentTarget.value,
                  ),
                })
              }
            >
              {!state.destination ? (
                <option value="">Choose a project first</option>
              ) : null}
              {controller.destinations
                .filter((item) => item.projectId === state.destination?.projectId)
                .map((item) => (
                  <option key={item.workspaceId} value={item.workspaceId}>
                    {item.name} · {item.root.path}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Agent
            <select
              aria-label="Destination agent"
              value={state.agent}
              disabled={busy}
              onChange={(event) =>
                controller.choose({ agent: event.currentTarget.value as SkillagerAgent })
              }
            >
              {SKILLAGER_AGENTS.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Discovery mode
            <select
              aria-label="Discovery mode"
              value={state.mode}
              disabled={busy}
              onChange={(event) =>
                controller.choose({
                  mode: event.currentTarget.value as SkillagerExposureMode,
                })
              }
            >
              <option value="native">Full skill</option>
              <option value="stub">Stub</option>
            </select>
          </label>
          <p>Only open local workspaces are available here.</p>
        </div>
      ) : null}
      {state.destination ? (
        <p>
          Selected workspace:{' '}
          <code>
            {state.destination.root.hostId}:{state.destination.root.path}
          </code>
        </p>
      ) : null}
      <p>
        {SKILLAGER_AGENTS.find((agent) => agent.id === state.agent)?.label} ·{' '}
        {state.mode === 'native' ? 'Full skill' : 'Stub'}
        {state.action === 'change'
          ? ` (from ${state.metadata.workspace?.mode === 'native' ? 'Full skill' : 'Stub'})`
          : ''}
      </p>
      {state.action === 'remove' ? (
        <p>
          Remove only this managed copy. The personal library and other workspace copies
          stay unchanged.
        </p>
      ) : (
        <p>
          Skillager uses the currently accepted library version. The preview includes
          supporting files and deployment metadata.
        </p>
      )}
      {preview ? <ExposureEffects preview={preview} /> : null}
      {busy ? (
        <p role="status">
          {state.applying ? 'Applying confirmed changes…' : 'Preparing complete preview…'}
        </p>
      ) : null}
      {state.message ? (
        <p role={state.failed ? 'alert' : 'status'}>{state.message}</p>
      ) : null}
    </ConfirmationDialog>,
    document.body,
  )
}

function ExposureEffects({
  preview,
}: {
  readonly preview: SkillagerExposurePreview
}): ReactElement {
  return (
    <section aria-label="Complete file effects">
      <p>
        Exact target:{' '}
        <code>
          {preview.target.hostId}:{preview.target.path}
        </code>
      </p>
      {preview.sourceHash ? (
        <p>
          Incoming accepted source version: <code>{preview.sourceHash}</code>
        </p>
      ) : null}
      <p>
        Target state: <code>{preview.targetHash ?? 'absent'}</code>
      </p>
      <p>
        Target folder permissions:{' '}
        <code>
          {mode(preview.beforeMode)} → {mode(preview.afterMode)}
        </code>
      </p>
      <p>{preview.effects.length} file and directory effects</p>
      <div className="skillager-exposure-effects">
        {preview.effects.map((effect) => (
          <details key={effect.path}>
            <summary>
              {effect.action} · {effect.path}
            </summary>
            <div className="skillager-effect-sides">
              <div>
                <h4>Before</h4>
                <Entry value={effect.before} />
              </div>
              <div>
                <h4>After</h4>
                <Entry value={effect.after} />
              </div>
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}
function Entry({
  value,
}: {
  readonly value: SkillagerExposureEntry | null
}): ReactElement {
  if (!value) return <p>Absent</p>
  return (
    <>
      <p>
        {value.type} · permissions <code>{mode(value.mode)}</code>
        {value.size !== undefined ? ` · ${value.size} bytes` : ''}
      </p>
      {value.sha256 ? (
        <p>
          SHA-256 <code>{value.sha256}</code>
        </p>
      ) : null}
      {value.linkTarget !== undefined ? (
        <p>
          Link: <code>{value.linkTarget}</code>
        </p>
      ) : null}
      {value.device !== undefined ? <p>Device: {value.device}</p> : null}
      {value.metadata ? <pre>{value.metadata}</pre> : null}
      {value.generatedFields?.map((policy) => (
        <p key={policy}>{policy}</p>
      ))}
    </>
  )
}
function mode(value: number | null): string {
  return value === null ? 'absent' : value.toString(8).padStart(4, '0')
}
