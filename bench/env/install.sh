#!/usr/bin/env bash
# Install (or remove) the root helper behind `bun run bench:perf -- --env dedicated` (ob 1947).
#
#   bench/env/install.sh              build, show what will change, ask, install
#   bench/env/install.sh --uninstall  show what will be removed, ask, remove
#   bench/env/install.sh --yes        skip the question (still prints the plan)
#
# Run it as yourself, not as root: it builds as you and calls sudo only for the install itself.
set -euo pipefail

HELPER=/usr/local/sbin/pixelslash-bench-reserve
SUDOERS=/etc/sudoers.d/pixelslash-bench
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILT="$HERE/dist/pixelslash-bench-reserve"
USER_NAME="$(id -un)"

mode=install
assume_yes=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) mode=uninstall ;;
    --yes) assume_yes=1 ;;
    *) echo "usage: bench/env/install.sh [--uninstall] [--yes]" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -eq 0 ]; then
  echo "run this as your own user, not root: it needs your name for the sudoers line" >&2
  exit 2
fi

sudoers_line="$USER_NAME ALL=(root) NOPASSWD: $HELPER"

confirm() {
  [ "$assume_yes" -eq 1 ] && return 0
  read -r -p "Go ahead? [y/N] " answer
  [ "$answer" = y ] || [ "$answer" = Y ]
}

if [ "$mode" = uninstall ]; then
  echo "This will:"
  echo "  - run '$HELPER off' if the machine is still reserved (restores cores, boost, governor)"
  echo "  - remove $HELPER"
  echo "  - remove $SUDOERS"
  confirm || { echo "nothing changed"; exit 1; }
  if [ -x "$HELPER" ] && ! sudo "$HELPER" off; then
    echo "the restore failed; not removing the helper, so it can be run again: sudo $HELPER off" >&2
    exit 1
  fi
  sudo rm -f "$HELPER" "$SUDOERS"
  echo "removed"
  exit 0
fi

command -v bun >/dev/null || { echo "bun is not on PATH" >&2; exit 1; }
command -v visudo >/dev/null || { echo "visudo is not installed" >&2; exit 1; }

echo "Building the helper as $USER_NAME (bun build --compile) ..."
mkdir -p "$HERE/dist"
# Root runs this binary: it must not pick up a bunfig.toml or .env from whatever directory sudo was called in.
bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
  "$HERE/host.ts" --outfile "$BUILT" >/dev/null

echo
echo "This will, with sudo:"
echo "  - run the installed helper's 'off' first if one is there (restores anything still reserved)"
echo "  - install $BUILT"
echo "      as $HELPER (root:root, mode 0755)"
echo "  - write $SUDOERS (root:root, mode 0440) holding exactly one line:"
echo "      $sudoers_line"
echo
echo "The helper takes 'on --cpus <list> --mem <size> --pid <pid>', 'off' and 'status', and nothing else."
echo "'on' sets AllowedCPUs on system.slice, user.slice and init.scope, puts the pid in"
echo "pixelslash-bench.scope with a memory reservation, and turns CPU boost off; 'off' undoes all of it."
echo "Nothing is reserved until you run 'bun run bench:perf -- --env dedicated'. No reboot, no boot parameters."
echo "Remove it again with: bench/env/install.sh --uninstall"
echo
confirm || { echo "nothing changed"; exit 1; }

staged="$(mktemp -p "$HERE/dist" sudoers.XXXXXX)"
trap 'rm -f "$staged"' EXIT
printf '%s\n' "$sudoers_line" > "$staged"
# A bad sudoers file can lock sudo out: check the syntax before it goes into place.
sudo visudo -cf "$staged" >/dev/null

# An installed helper restores what it reserved before it is replaced: a record it wrote is read by it.
if [ -x "$HELPER" ] && ! sudo "$HELPER" off; then
  echo "the installed helper could not restore the machine; not replacing it: sudo $HELPER off" >&2
  exit 1
fi
sudo install -o root -g root -m 0755 "$BUILT" "$HELPER"
sudo install -o root -g root -m 0440 "$staged" "$SUDOERS"
sudo visudo -c >/dev/null

echo
echo "installed. Check it:  sudo -n $HELPER status"
sudo -n "$HELPER" status
