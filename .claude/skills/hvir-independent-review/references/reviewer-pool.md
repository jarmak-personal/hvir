# Reviewer pool and headless invocation

Use these pinned reviewers. Model-family names describe the author family to exclude, not the
CLI used to launch the completing agent.

| Reviewer | Family | Model | Effort |
| --- | --- | --- | --- |
| GitHub Copilot CLI | Google | `gemini-3.5-flash` | Provider default; omit `--effort` |
| Claude Code | Anthropic | `claude-opus-4.8` | `medium` |
| Codex | OpenAI | `gpt-5.6-sol` | `medium` |

Select by completing family:

| Completing family | Independent reviewers |
| --- | --- |
| OpenAI | Gemini through Copilot CLI and Claude |
| Anthropic | Gemini through Copilot CLI and Codex |
| Google | Claude and Codex |

If another family produced the artifact, select any two distinct families from the pool and
record the choice. Never use a reviewer from the completing family. Do not fall back to an
unpinned model when a selected model is unavailable.

## Process boundary

Run from the exact hvir worktree that owns the artifact. Start each reviewer with a minimal
environment containing only the ordinary OS values its subscription-backed CLI needs; remove
PATs, API keys, cloud credentials, and repository tokens from the child environment. Never
replace `HOME` or point it at repository content. Pass prompts as one argument or through stdin
using the executor's argument/stdin facilities; never interpolate artifact text into shell
source.

Use a managed foreground process with a ten-minute deadline. Terminate a process that exceeds
the deadline. A detached process, automatic retry, fallback model, resumed session, or partial
output is not a completed review.

The commands below are the required capability shape. Adapt quoting only as required by the
host shell; do not remove restrictions. `<review-prompt>` is the trusted prompt assembled from
this skill and the selected mode reference.

## Gemini through GitHub Copilot CLI

```sh
copilot -p '<review-prompt>' \
  -C . \
  --model gemini-3.5-flash \
  --no-ask-user \
  --no-custom-instructions \
  --disable-builtin-mcps \
  --no-auto-update \
  --no-experimental \
  --no-remote \
  --no-remote-export \
  --no-color \
  --silent \
  --max-ai-credits 30 \
  --available-tools='bash,view,grep,glob' \
  --allow-tool='read,shell(git diff:*),shell(git show:*),shell(git status:*),shell(git rev-parse:*)' \
  --deny-tool='write,url,memory,shell(gh:*),shell(git fetch:*),shell(git pull:*),shell(git push:*)'
```

Do not pass an effort flag for Gemini 3.5 Flash until GitHub documents configurable reasoning
for that model. File search and read tools plus the four allowlisted local Git inspection
commands are sufficient. Do not use Copilot's GitHub MCP, review agent, remote mode, sharing, or
session persistence.

## Claude Code

```sh
claude -p '<review-prompt>' \
  --model claude-opus-4.8 \
  --effort medium \
  --safe-mode \
  --no-session-persistence \
  --no-chrome \
  --permission-mode dontAsk \
  --tools 'Bash,Read,Grep,Glob' \
  --allowedTools 'Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git status:*),Bash(git rev-parse:*)' \
  --disallowedTools 'Edit,Write,NotebookEdit,WebFetch,WebSearch,Task' \
  --output-format text
```

`--safe-mode` keeps repository and machine customizations, hooks, plugins, MCP servers, memory,
and background features out of the review while preserving normal subscription authentication.
Use ordinary `claude -p` only. Do not use or recommend Ultrareview.

## Codex

Send `<review-prompt>` on stdin in place of `-`:

```sh
codex exec \
  --model gpt-5.6-sol \
  --config 'model_reasoning_effort="medium"' \
  --sandbox read-only \
  --ephemeral \
  --ignore-user-config \
  --ignore-rules \
  --config 'approval_policy="never"' \
  --config 'project_doc_max_bytes=0' \
  --config 'web_search="disabled"' \
  --config 'mcp_servers={}' \
  --config 'agents.max_threads=1' \
  --config 'agents.max_depth=0' \
  --config 'shell_environment_policy.inherit="none"' \
  --config 'shell_environment_policy.include_only=["PATH"]' \
  -
```

Use `codex exec`, not a writable session or an external code-review product. Read-only sandbox,
disabled approvals/network/MCP, ephemeral state, suppressed project instructions, one-thread
policy, and a PATH-only command environment are mandatory. The reviewer may use local read-only
commands solely to inspect the supplied artifact.
