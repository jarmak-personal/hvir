import type { HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'

/** POSIX private-cache effects, identity receipts and exact-object retirement through ProjectHost. */
export async function identity(
  host: ProjectHost,
  path: HostPath,
  signal?: AbortSignal,
): Promise<string> {
  return control(host, `${STAT}\nkey "$1"`, [path.path], signal)
}
export async function control(
  host: ProjectHost,
  script: string,
  args: readonly string[],
  parent?: AbortSignal,
): Promise<string> {
  const result = await host.exec(
    'sh',
    ['-c', `set -eu\numask 077\n${script}`, 'hvir-agent-cache', ...args],
    {
      signal: parent
        ? AbortSignal.any([parent, AbortSignal.timeout(8000)])
        : AbortSignal.timeout(8000),
      maxBuffer: 8192,
    },
  )
  if (result.code !== 0)
    throw new Error(
      'hvir-agent private cache setup or exact cleanup is unavailable; existing files were preserved',
    )
  return result.stdout.trim()
}
export const STAT = String.raw`
key() { stat -c '%u:%d:%i' "$1" 2>/dev/null || stat -f '%u:%d:%i' "$1"; }
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
owner() { stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"; }
private() { [ -d "$1" ] && [ ! -L "$1" ] && [ "$(owner "$1")" = "$(id -u)" ] && [ "$(mode "$1")" = 700 ]; }
`
export const PRIVATE_DIRECTORY = `${STAT}\n[ -e "$1" ] || mkdir "$1"\nprivate "$1"`
export const DETECT = `${STAT}
safe() { case "$1" in /*) ;; *) return 1;; esac; case "$1" in *[!A-Za-z0-9_./-]*) return 1;; esac; }
uid=$(id -u)
if safe "\${XDG_RUNTIME_DIR-}"; then parent=$XDG_RUNTIME_DIR; base=$parent/hvir
else parent=\${TMPDIR:-/tmp}; safe "$parent" || parent=/tmp; base=$parent/hvir-$uid; fi
[ -d "$parent" ] || exit 70
[ -e "$base" ] || mkdir "$base"
private "$base" || exit 71
uname -s; uname -m; printf '%s\n' "$base"
`
export const CREATE_REVISION = `${STAT}\nmkdir "$1"\nprivate "$1"`
export const VERIFY_MARKER = `${STAT}\nprivate "$1"\n[ -f "$1/owned.json" ] && [ ! -L "$1/owned.json" ]\n[ "$(owner "$1/owned.json")" = "$(id -u)" ] && [ "$(mode "$1/owned.json")" = 600 ]`
export const VERIFY_PUBLICATION = `${STAT}\nprivate "$1"\n[ -f "$1/hvir-agent" ] && [ ! -L "$1/hvir-agent" ]\n[ "$(owner "$1/hvir-agent")" = "$(id -u)" ] && [ "$(mode "$1/hvir-agent")" = 755 ]\n[ -f "$1/owned.json" ] && [ ! -L "$1/owned.json" ]\n[ "$(owner "$1/owned.json")" = "$(id -u)" ] && [ "$(mode "$1/owned.json")" = 600 ]`
export const CREATE_LEASE = `${STAT}\n[ ! -e "$1" ]\n(set -C; printf '%s\\n' "$2" > "$1")\n[ "$(mode "$1")" = 600 ]`
export const SHORT_SOCKET_BASE = `${STAT}\nbase=/tmp/hvir-$(id -u)\n[ -e "$base" ] || mkdir "$base"\nprivate "$base"\nprintf '%s\\n' "$base"`
export const UPDATE_MARKER = `${STAT}\nprivate "$1"\n[ ! -L "$1/owned.json" ] && [ "$(key "$1/owned.json")" = "$2" ] && [ "$(mode "$1/owned.json")" = 600 ]\nprintf '%s' "$3" > "$1/owned.json"`
export const CHECK_LEASE = `${STAT}\n[ ! -L "$1" ] && [ "$(owner "$1")" = "$(id -u)" ] && [ "$(mode "$1")" = 600 ]`
export const UPDATE_LEASE = `${CHECK_LEASE}\n[ "$(key "$1")" = "$2" ]\nprintf '%s' "$3" > "$1"`
export const SOCKET_IDENTITY = `${STAT}\n[ -S "$1" ] && [ ! -L "$1" ] && [ "$(owner "$1")" = "$(id -u)" ]\nkey "$1"`
export const SOCKET_ABSENT = '[ ! -e "$1" ] && [ ! -L "$1" ]'
export const REMOVE_EXACT_SOCKET = `${STAT}
[ ! -e "$1" ] && [ ! -L "$1" ] && exit 0
[ -S "$1" ] && [ ! -L "$1" ] && [ "$(key "$1")" = "$2" ] || exit 71
quarantine="$1.retired"
[ ! -e "$quarantine" ] && [ ! -L "$quarantine" ] || exit 71
mv "$1" "$quarantine"
[ -S "$quarantine" ] && [ ! -L "$quarantine" ] && [ "$(key "$quarantine")" = "$2" ] || exit 71
rm "$quarantine"`
export const REMOVE_EXACT_FILE = `${STAT}\n[ ! -e "$1" ] && exit 0\n[ ! -L "$1" ] && [ "$(key "$1")" = "$2" ] || exit 71\nquarantine="$1.retired"\n[ ! -e "$quarantine" ] || exit 71\nmv "$1" "$quarantine"\n[ "$(key "$quarantine")" = "$2" ] || exit 71\nrm "$quarantine"`
export const RETIRE = `${STAT}
private "$1" && private "$2"
[ "$(key "$2")" = "$3" ] && [ "$(key "$2/owned.json")" = "$6" ] || exit 71
check() {
  count=0
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case "\${entry##*/}" in
      owned.json) [ ! -L "$entry" ] && [ "$(key "$entry")" = "$6" ] || exit 71;;
      hvir-agent) expected=$4; [ -n "$expected" ] || expected=$8; [ -n "$expected" ] && [ ! -L "$entry" ] && [ "$(key "$entry")" = "$expected" ] || exit 71;;
      upload.*) [ "\${entry##*/}" = "$7" ] && [ -n "$8" ] && [ ! -L "$entry" ] && [ "$(key "$entry")" = "$8" ] || exit 71;;
      *) exit 71;;
    esac
    count=$((count+1))
  done
  [ "$count" -le 2 ] && [ "$count" -ge 1 ]
}
check "$2" "$2" "$3" "$4" "$5" "$6" "$7" "$8"
quarantine="$1/retired.$5"
[ ! -e "$quarantine" ] || exit 71
mv "$2" "$quarantine"
[ "$(key "$quarantine")" = "$3" ] || exit 71
check "$quarantine" "$2" "$3" "$4" "$5" "$6" "$7" "$8"
for entry in "$quarantine"/*; do rm "$entry"; done
rmdir "$quarantine"`
