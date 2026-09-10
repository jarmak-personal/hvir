# Binary clipboard plist fixtures

These synthetic binary plists exercise the real parser without another JavaScript
serializer dependency. Paths are inert decoder inputs; tests never access them.
Malformed input is a truncated copy of `filenames.plist` in the test.

Regenerate from the repository root with Python 3 (created with Python 3.12.7):

```python
from pathlib import Path
import plistlib

values = {
    "filenames": ["/tmp/space name.txt", "/tmp/café-雪.txt"],
    "mixed": ["/tmp/keep.txt", "relative.txt", "file:///tmp/no", 42, True,
              {"path": "/tmp/no"}, ["/tmp/no"]],
    "dictionary": {"path": "/tmp/no"},
    "scalar": "/tmp/no",
    "too-many": ["/tmp/source-" + str(i) for i in range(257)],
}
root = Path("test/fixtures/clipboard-file-list")
for name, value in values.items():
    (root / (name + ".plist")).write_bytes(
        plistlib.dumps(value, fmt=plistlib.FMT_BINARY)
    )
```
