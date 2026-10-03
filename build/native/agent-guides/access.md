# Agent access

In Settings > Extensions turn on Agent access. The default is Allow actions within approved
access. Enable agent access separately for each extension and enable that extension normally.
Per-installation consent defaults to off, including installations without a saved consent
field, and is written by the same authoritative extension-state writer. A second
instance without that writer cannot change consent or invoke extension actions, but can still
use global inspection and reports. Writer loss cancels pending actions.
This does not approve native connectors or expand any grant. Inspection/reporting continue
when an action is unavailable. The endpoint has a private user-owned directory/socket;
processes running as the same OS user are not separated or authenticated per agent.

Also confirm destructive actions requires a trusted hvir decision for declared delete/replace
effects. Decisions expire after 30 seconds and bind the exact request, caller, target and input.
Cancellation, extension disable or stricter settings revoke pending work. Native executable
effects cannot be classified or proved confined by a declaration. Turning access off rejects
live work but does not claim rollback or remove already published reports.

Harness approval and sandbox settings are independent. hvir neither reads nor changes them.
The harness sandbox does not automatically constrain admitted work executed by hvir. Authorize
the installed hvir-agent command and its instance socket through ordinary harness controls.
For Claude Code a narrow command allow rule or interactive command approval permits invocation.
For Codex choose a named permission profile with its required filesystem access and the exact
endpoint in network.unix_sockets; the installed 0.160.0 also requires network.enabled=true.
Without an active network proxy this grants direct network access, not only socket access.
See the installed harness help and https://learn.chatgpt.com/docs/permissions#unix-sockets.
Do not infer hvir access from harness flags or claim that an unusable default connection works.

For an explicit endpoint already displayed by hvir, the following ordinary per-invocation
setup was tested with Codex 0.160.0. Set HVIR_AGENT_ENDPOINT to that exact absolute socket path.
The ignored user configuration is invocation-local; no global configuration is changed.

```sh
codex exec --ignore-user-config \
  -c 'permissions.hvir.extends=":read-only"' \
  -c 'permissions.hvir.network.enabled=true' \
  -c "permissions.hvir.network.unix_sockets={\"$HVIR_AGENT_ENDPOINT\"=\"allow\"}" \
  -c 'default_permissions="hvir"' \
  "Run hvir-agent workspaces --instance $HVIR_AGENT_ENDPOINT"
```

Claude Code 2.1.287 can approve the exact command through its ordinary prompt, or receive
that exact command approval for one invocation:

```sh
claude -p "Run hvir-agent workspaces --instance $HVIR_AGENT_ENDPOINT" \
  --allowedTools "Bash(hvir-agent workspaces --instance $HVIR_AGENT_ENDPOINT)"
```

These permissions authorize invocation only. hvir access must still be enabled explicitly.

The installed Electron RunAsNode fuse stays enabled for the CLI. Other local processes can
use the binary as a Node runtime with hvir's macOS permissions.
