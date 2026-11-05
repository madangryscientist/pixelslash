#!/usr/bin/env bash
# One pass of the liveness check (PS-323), run every 30 s by pixelslash-watchdog.timer. A unit can be
# `active` and answer nothing: on 2026-11-05 workerd and the sidecar sat in D state over MemoryHigh,
# port 3000 accepted connections and systemd saw no failure. So this asks each unit's HTTP path, and
# restarts a unit that is active and has not answered $STRIKES passes in a row.
#
# Any HTTP answer counts as alive, a 500 too: a restart fixes a wedge, not a bad release, and looping
# one would only take down what still works. A unit that is not active is left to Restart=.
#
# $STRIKES is 4 so the first restart comes at least 90 s after the first miss, past the 30 s
# update.sh gives a start. The sidecar answers nothing during a diff, ~5 s at worst when measured.
# See apps/web/README.md, "Run it on the Proxmox server". The PIXELSLASH_WATCHDOG_* overrides are for
# the test and for perf/wedge-check.ts, which run this against other units.
set -uo pipefail

STATE=${PIXELSLASH_WATCHDOG_STATE:-/run/pixelslash-watchdog}
STRIKES=${PIXELSLASH_WATCHDOG_STRIKES:-4}
WAIT_SECONDS=${PIXELSLASH_WATCHDOG_WAIT_SECONDS:-10}
TARGETS=${PIXELSLASH_WATCHDOG_TARGETS:-pixelslash-web=http://127.0.0.1:3000/ pixelslash-diff=http://127.0.0.1:4181/health}
read -r -a SYSTEMCTL <<<"${PIXELSLASH_WATCHDOG_SYSTEMCTL:-systemctl}"

# Without curl every unit would read as silent and be restarted for nothing.
if ! command -v curl >/dev/null; then
  echo "watchdog: curl is not installed: nothing checked" >&2
  exit 1
fi

check() {
  local unit=$1 url=$2 file count=0
  file=$STATE/$unit
  if [[ $("${SYSTEMCTL[@]}" show -p ActiveState --value "$unit") != active ]]; then
    rm -f "$file"
    return
  fi
  if curl -s -o /dev/null -m "$WAIT_SECONDS" "$url"; then
    rm -f "$file"
    return
  fi
  [[ ! -f $file ]] || read -r count <"$file"
  count=$((count + 1))
  echo "$unit: no answer from $url in ${WAIT_SECONDS} s ($count of $STRIKES)"
  if ((count < STRIKES)); then
    echo "$count" >"$file"
    return
  fi
  rm -f "$file"
  echo "$unit: active and silent for $STRIKES checks: restarting"
  "${SYSTEMCTL[@]}" restart "$unit"
}

mkdir -p "$STATE"
for target in $TARGETS; do
  check "${target%%=*}" "${target#*=}"
done
