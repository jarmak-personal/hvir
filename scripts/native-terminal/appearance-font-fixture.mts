export const APPEARANCE_FONT_LAUNCHER = 'scripts/native-terminal/artifacts.mts'
export const APPEARANCE_FONT_CONFIG_SOURCE =
  'scripts/native-terminal/appearance-font-fixture.mts'
export const APPEARANCE_FONT_SOURCE = 'src/font/res/JetBrainsMonoNoNF-Regular.ttf'
export const APPEARANCE_FONT_LICENSE_SOURCE = 'src/font/res/OFL.txt'
export const APPEARANCE_FONT_FILE = 'appearance-fonts/JetBrainsMonoNoNF-Regular.ttf'
export const APPEARANCE_FONT_LICENSE = 'appearance-fonts/OFL.txt'
export const APPEARANCE_FONT_PROVENANCE = 'appearance-fonts/source.json'
export const APPEARANCE_FONT_FILES = [
  APPEARANCE_FONT_FILE,
  APPEARANCE_FONT_LICENSE,
  APPEARANCE_FONT_PROVENANCE,
] as const

// The only discoverable font is the pinned fixture. No system/user includes or
// directories are consulted. Both paths are relative to this invocation's XML.
export const APPEARANCE_FONT_CONFIG = `<?xml version="1.0"?>
<fontconfig>
  <reset-dirs />
  <dir prefix="relative">fonts</dir>
  <cachedir prefix="xdg">fontconfig</cachedir>
</fontconfig>
`
