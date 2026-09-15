import type { HostPath } from '../../../shared/host-path'

export function SkillagerFirstSkill({ root }: { readonly root: HostPath }) {
  const prompt = `Help me create my first useful skill in my personal Skillager library at ${JSON.stringify(root.path)}. Ask which recurring task I want to capture, then use Skillager's public CLI guidance to create the skill there. Leave it pending for my review; do not accept or expose it to any workspace.`
  return (
    <div className="skillager-first-skill">
      <p>Your personal library is empty.</p>
      <h3>Create your first skill with your agent</h3>
      <p>
        Select and copy this prompt into your agent. Come back and refresh to review the
        skill.
      </p>
      <textarea aria-label="First skill agent prompt" readOnly value={prompt} rows={7} />
      <p className="skillager-hint">
        You review and accept new content before separately choosing where to expose it.
      </p>
    </div>
  )
}
