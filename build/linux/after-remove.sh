#!/bin/bash
set -e

case "$1" in
upgrade | failed-upgrade | abort-install | abort-upgrade | disappear)
  # The replacement package owns the command and profile during an update.
  exit 0
  ;;
remove | purge)
  ;;
*)
  echo "hvir package removal received an unknown lifecycle action: $1" >&2
  exit 1
  ;;
esac

stage='removing the hvir command'
report_failure() {
  status=$?
  echo "hvir package removal failed while $stage" >&2
  exit "$status"
}
trap report_failure ERR

HVIR_COMMAND='/opt/${sanitizedProductName}/resources/hvir-command'
if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives \
    --remove '${executable}' "$HVIR_COMMAND"
else
  rm -f '/usr/bin/${executable}'
fi

stage='unloading the AppArmor profile'
APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
if [ -f "$APPARMOR_PROFILE_TARGET" ]; then
  if apparmor_status --enabled >/dev/null 2>&1 &&
    ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; } &&
    command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser --remove "$APPARMOR_PROFILE_TARGET"
  fi
  rm -f "$APPARMOR_PROFILE_TARGET"
fi

stage='finalizing package removal'
trap - ERR
