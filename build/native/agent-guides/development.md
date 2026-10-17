# Development links, revisions and removal

Installed extension contract: 1.0. Settings > Extensions > Open extensions folder selects the current instance's extensions directory; do not infer it from an unrelated checkout. Create an explicit top-level link to your author directory using your own tools, Discover, inspect the current requested access and Enable. Discovery and validation execute no code and never approve or auto-enable packages.

Editing source changes the candidate revision. Reload prepares and validates before revoking the old activation, then explicitly accepts edited bytes; preparation failure preserves the valid current activation. Replace accepts another source revision. Unchanged access needs no repeated permission decision. Changed trust declarations/configuration require their ordinary new decision. An absent/reappearing source is never automatically accepted. Installation identity is retained per manifest ID across path/source-kind changes; source package id and installation ID are different values.

Remove disables/revokes before cleanup. A development package loses only its link, never the author directory. Ordinary directories and ZIPs placed in extensions go to recoverable trash. Keep installation identity for reinstall, or explicitly forget platform setup; this never deletes your libraries, project skills or unrelated data. Finish copying incomplete ZIPs before Discover again. A ZIP must contain hvir-extension.json at root.

Use separate user-data directories for development and your normal installed app. One instance owns extension state writes per directory. A conflicting instance may browse but cannot obtain that writer's extension authority; choose another directory instead of bypassing the guard. Native package guidance remains authoritative for launching a separate development channel; copying a launcher alone does not change its state root.

See `guide authoring`, `guide manifest`, `guide lifetimes` and `guide skill`. Current pre-release contracts update directly; old templates and legacy readers are not supported.
