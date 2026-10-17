# Inspect, export and explicitly install the optional skill

Installed extension and agent contracts: 1.0. `hvir-agent skill` returns the exact tiny shipped skill as `skill`. `hvir-agent skill --output /absolute/new/SKILL.md` exports exactly those bytes into a new local file. Select an existing ordinary parent directory; no parent or destination link is followed and occupied files are refused. Export changes no harness configuration and grants no hvir permission.

Supported Claude Code setup: create a new personal skill directory ~/.claude/skills/hvir-extension with your own tools, inspect `hvir-agent skill`, then explicitly export to its absolute SKILL.md path. Claude Code loads personal skills from ~/.claude/skills/<name>/SKILL.md; description is the task trigger. The user chooses scope; a repository-local installation is an explicit user edit, never an automatic hvir action. Keep the installed hvir-agent on the ordinary command PATH.

Start a fresh supported harness session after setup and ask “Please add a clock to hvir”. The skill directs the agent to installed guide topics and exact scaffold/validate help, then ordinary user enablement. Read only relevant topics. This optional setup is not a universal model benchmark or an in-app generator. Without the skill, use `hvir-agent guide authoring` directly.

To remove, delete only the skill directory you explicitly created; inspect it first and preserve unrelated files. hvir does not maintain installed copies. After updating hvir, inspect the installed contract and compare/re-export the shipped skill explicitly; never overwrite a changed copy silently. A incompatible live contract gives a clear refusal while static help and local authoring remain available. No session-start message, banner, terminal injection, launch/recovery hook or repository instruction edit is added by hvir.

See `guide authoring` and `guide development`.

For an explicitly selected project scope instead, create .claude/skills/hvir-extension in that project and export the skill to its absolute SKILL.md path. This is an ordinary explicit user setup. Supported locations are documented in [Claude Code skills](https://code.claude.com/docs/en/skills).
