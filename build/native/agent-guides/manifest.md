# Package manifest and capability negotiation

Installed extension contract: 1.0. The executable starting example is the manifest produced by `hvir-agent scaffold --output /absolute/clock`; inspect its hvir-extension.json. The authoritative schema is hvir's public ExtensionManifest and ordinary package validator; this guide does not define a second schema.

Required fields are id, name, version, contract, requiredCapabilities, optionalCapabilities, access and views. IDs use bounded letters/digits, dots, underscores and hyphens; version is a semver triple. access is currently []: filesystem grants are not available in this contract. Each view names an existing package-local HTML entry, placement application/workspace and representations ["view"]. Unknown fields generate bounded warnings, not additional authority.

Same-major compatible contracts retain their supported meanings. A newer minor contract can run when every required capability exists. Required unknown capabilities refuse activation; optional ones may be absent. Read the hello reply's capabilities before using optional behavior. Installed static support is not the set admitted to this particular guest or agent. Required safety semantics cannot be downgraded because a field is unknown.

Current public capability names: presentation.read, viewer.open-own, context.read, contributions.read, contributions.publish, actions.invoke, connector.execute, connector.output, connector.status. Updaters have a narrower observation/presentation role. Native connector use still needs separate user configuration and approval. Declaring a capability neither grants filesystem/network access nor enables agent access.

Assets are ordinary contained files: no interior symlinks, hardlinks or archive traversal. ZIPs have hvir-extension.json at root, with no inferred wrapping directory. Current bounds are 256 materialized entries including directories, depth12, 2MiB/asset, 16MiB expanded, 20MiB compressed and 32KiB manifest. Validation failures name the ordinary package policy; fix the source and validate again. Read `guide surfaces`, `guide lifetimes` and `guide connectors` for exact operations.
