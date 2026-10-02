# Reports

`printf '# Result\n' | hvir-agent report --title Result --format markdown --stdin`
publishes into the calling terminal's workspace without taking focus. Outside hvir supply
`--instance ENDPOINT --workspace ID`. Text and Markdown are accepted up to 128 KiB. Reports
remain closable for the application session; restart persistence is not promised.

The result includes an opaque ID and replacement handle. Only `--handle HANDLE` can replace
that exact report in the same workspace. Capacity is 64 reports/4 MiB application-wide and
8 reports/1 MiB per connection. Close unused reports when capacity is full.

A quiet agent badge appears on the tab and rolls up to workspace/project rows. Viewing clears
that report's badge; terminal attention and the OS badge are independent. Reports execute no
scripts or automatic image/network/file resources. Human file-link clicks resolve relative to
the report workspace root and follow ordinary explicit document viewing protections. External
links use the trusted Open in browser action. `open --path README.md` returns presentation
metadata only, never file contents. It grants no general filesystem retrieval API.
