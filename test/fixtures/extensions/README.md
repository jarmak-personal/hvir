# Released extension inputs

`0.3.0/reference` and `0.3.0/clock` are immutable released package bytes. Their
closed `0.3.0/inventory.json` records every file; current template builds must not
rewrite these inputs.

`0.3.0/contracts/skillager-manifest.json` freezes the released public scoped-read,
managed-delivery and action declarations for tests at their existing authority
owners. It is a contract input, not a second runnable Skillager package.
`contracts-inventory.json` records it separately from the original package inventory.

`newer-minor` contains independently authored contract 1.1 admission fixtures.
Their actual guest script negotiates its declared version, uses a known capability,
and asks for an unknown optional capability. The optional package can run with that
capability gated; the required-safety package must be refused before guest execution.
These files are also recorded in the separate contract inventory.
