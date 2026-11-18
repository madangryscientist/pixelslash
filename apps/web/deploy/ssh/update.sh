#!/usr/bin/env bash
# The CT-side half of a LAN deploy (PS-225): unpack a release, install it beside the one serving,
# migrate, switch, and roll back if it does not come up. Run as root on the CT by release.sh, which
# builds the release on the desktop and pushes it in; nothing here builds. See apps/web/README.md,
# "Run it on the Proxmox server".
#
#   update.sh /root/pixelslash-<sha>.tar.gz
#
# Releases sit side by side in /home/pixelslash/releases/<sha>, and the units run from the
# `current` symlink there. Until the switch nothing the running processes load is touched, so the
# only downtime is the restart. A release that does not come up on :3000 puts `current` back on the
# previous one and restarts that. The last 3 releases are kept.
#
# The D1 and R2 state stays where it always was, in the old checkout's apps/web/.wrangler/state, and
# every release links to it; the CT's .dev.vars.e2e (the deployment's own secrets) is next to it
# and is copied into each release's dist/server/.dev.vars, where serve.ts reads it.
#
# Error reporting (PS-227) is on while the CT's .dev.vars.e2e holds a SENTRY_DSN. A release.sh run
# with PIXELSLASH_SENTRY_DSN set carries it in the tarball as `.sentry-dsn`, and it is saved there
# (never printed); every release then gets SENTRY_RELEASE (its sha) and SENTRY_ENVIRONMENT=lan
# beside it in dist/server/.dev.vars. With no DSN nothing is added and the server reports nowhere.
#
# The GitHub App (PS-23) is carried the same way: `.github-app-id`, `.github-app-key` (the PEM,
# base64) and `.public-url` become GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and PIXELSLASH_PUBLIC_URL
# in .dev.vars.e2e. Without both App vars the server sends GitHub nothing. `.github-app-api-base`
# (written whenever release.sh had an App id) becomes GITHUB_APP_API_BASE=https://api.github.com
# (PS-281): the CT is an e2e build whose GITHUB_API_BASE is the sign-in stub, and the App must not use it.
#
# A deploy under a live build (PS-228): the restart kills the Worker mid-diff, and the migration
# can hold the database's write lock, so a build that is `processing` errors. update.sh refuses,
# before it changes anything, while the serving release's D1 has a build that began processing in
# the last 15 minutes (a build older than that is an orphan, as 7a698500 was, and never blocks).
# PIXELSLASH_DEPLOY_FORCE=1 on the release.sh command line deploys anyway.
#
# The opencode helper is gone: every deploy retires one a CT still runs (its unit, switch, key and
# binary) and removes the org_models rows that point at it, so an org explains only through its own
# model endpoint. On a CT that never ran it this changes nothing.
#
# The diff sidecar (PS-203) is always installed: pixelslash-diff runs the server diff on
# 127.0.0.1:4181, and is restarted before pixelslash-web. One that does not come up is reported and
# the update goes on, since the Worker then diffs in-process, up to a lower pixel limit. See
# apps/web/README.md, "The diff sidecar".
#
# So is the liveness check (PS-323): pixelslash-watchdog is stopped for the restarts, timer and any
# pass in progress, so it cannot restart a unit mid-update, and started once the release serves. It
# needs curl, so an update without curl stops before it changes anything.
set -Eeuo pipefail

# The PIXELSLASH_* overrides are for the test, which runs this against temp directories.
APP_USER=pixelslash
APP_HOME=${PIXELSLASH_HOME:-/home/pixelslash}
APP_PATH=${PIXELSLASH_APP_PATH:-$APP_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin}
RELEASES=$APP_HOME/releases
CURRENT=$RELEASES/current
KEEP_RELEASES=3
# The checkout the CT served from before PS-225: its apps/web holds the state and the secrets.
LEGACY=$APP_HOME/pixelslash
SHARED_WEB=$LEGACY/apps/web
UNIT_DIR=${PIXELSLASH_UNIT_DIR:-/etc/systemd/system}
WATCHDOG_BIN=${PIXELSLASH_WATCHDOG_BIN:-/usr/local/sbin/pixelslash-watchdog}
# What the retired opencode helper left on a CT.
HELPER_SWITCH=${PIXELSLASH_HELPER_SWITCH:-/etc/pixelslash/opencode-helper}
HELPER_KEY=${PIXELSLASH_HELPER_KEY:-$APP_HOME/.config/pixelslash/opencode.key}
HELPER_URL=http://127.0.0.1:4180/v1
OPENCODE_BIN=${PIXELSLASH_OPENCODE_BIN:-$APP_HOME/.opencode/bin/opencode}
D1_RETRY_SLEEP=${PIXELSLASH_D1_RETRY_SLEEP:-2}
# A build that started processing within this many seconds is live, and a deploy waits for it.
LIVE_BUILD_SECONDS=900

as_app() {
  runuser -u "$APP_USER" -- env PATH="$APP_PATH" bash -c "$1"
}

# `restart` returns once the process is forked, so a unit that dies on start is seen by waiting
# for its port: up to $2 half-seconds (default 20, 10 s). With a unit as $3 the wait ends as soon
# as that unit has exited (failed, or waiting to be restarted), so a release that crashes on start
# is rolled back in a second or two rather than at the timeout.
wait_for_port() {
  for _ in $(seq "${2:-20}"); do
    if (echo >/dev/tcp/127.0.0.1/"$1") 2>/dev/null; then return 0; fi
    if [[ -n ${3:-} ]]; then
      case $(systemctl show -p SubState --value "$3") in failed | auto-restart) return 1 ;; esac
    fi
    sleep 0.5
  done
  return 1
}

# Removes the opencode helper from a CT that still runs it: the unit, the switch (and its backups),
# the key and the binary. Run on every deploy; on a clean CT it does nothing.
retire_helper() {
  if [[ -f $UNIT_DIR/pixelslash-opencode.service ]]; then
    systemctl disable --now --quiet pixelslash-opencode || true
    rm -f "$UNIT_DIR"/pixelslash-opencode.service
  fi
  rm -f "$HELPER_SWITCH" "$HELPER_SWITCH".bak-* "$HELPER_KEY" "$OPENCODE_BIN"
}

# `wrangler d1 $2...` on the local D1, in release $1. An upload in flight holds the database's write
# lock for a moment, and wrangler then fails with SQLITE_BUSY rather than waiting (a deploy to the
# CT failed on one), so a locked database is tried again, up to 5 times, $D1_RETRY_SLEEP s apart.
# Any other failure fails at once.
d1() {
  local rel=$1 out try
  shift
  out=$(mktemp)
  for try in 1 2 3 4 5; do
    if as_app "cd $rel/apps/web && bunx wrangler d1 $* --local --env e2e" >"$out" 2>&1; then
      cat "$out"
      rm -f "$out"
      return 0
    fi
    cat "$out" >&2
    grep -q SQLITE_BUSY "$out" && ((try < 5)) || break
    echo "the D1 database is locked: trying again in $D1_RETRY_SLEEP s" >&2
    sleep "$D1_RETRY_SLEEP"
  done
  rm -f "$out"
  return 1
}

# Refuse to deploy under a live build (PS-228). Asks the D1 of release $1, the one serving, for the
# builds that began processing within $LIVE_BUILD_SECONDS; any is a reason to stop, before anything
# changes. A D1 that cannot be read stops it too: not knowing is not a go-ahead, and FORCE is there.
refuse_live_build() {
  local rel=$1 cutoff sql out ids
  if [[ ${PIXELSLASH_DEPLOY_FORCE:-} == 1 ]]; then
    echo "PIXELSLASH_DEPLOY_FORCE=1: not checking for a build in flight" >&2
    return 0
  fi
  cutoff=$((($(date +%s) - LIVE_BUILD_SECONDS) * 1000))
  sql="SELECT id FROM builds WHERE status = 'processing' AND processing_started_at > $cutoff"
  if ! out=$(d1 "$rel" execute DB --json --command "$(printf %q "$sql")" 2>&1) ||
    ! grep -q '"results"' <<<"$out"; then
    echo "$out" >&2
    echo "refusing to deploy: could not ask the D1 whether a build is in flight (nothing changed)." >&2
    echo "Set PIXELSLASH_DEPLOY_FORCE=1 to deploy without the check." >&2
    return 1
  fi
  ids=$(grep -Eo '"id": *"[^"]+"' <<<"$out" | sed -E 's/.*: *"([^"]+)"/\1/' | paste -sd, - || true)
  [[ -z $ids ]] && return 0
  echo "refusing to deploy: a build is processing (started in the last $((LIVE_BUILD_SECONDS / 60)) min): $ids" >&2
  echo "A restart now would error it. Wait for it to end, or set PIXELSLASH_DEPLOY_FORCE=1 to deploy anyway (nothing changed)." >&2
  return 1
}

# The CT's secrets, copied into release $1, where serve.ts reads them.
# Without them it would serve with the e2e env's fixed test secrets, so a missing file fails.
copy_secrets() {
  as_app "install -m 600 $SHARED_WEB/.dev.vars.e2e $1/apps/web/dist/server/.dev.vars"
}

# Sets KEY=value in file $1; the value is read from stdin, so it is on no command line and in no
# log. The file keeps its owner and mode 600.
upsert_var() {
  local file=$1 key=$2 value tmp
  IFS= read -r value
  tmp=$(mktemp "$file.XXXXXX")
  { grep -v "^$key=" "$file" || true; } >"$tmp"
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  chown --reference="$file" "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# The secrets release.sh can carry, as `<file in the release>:<var in .dev.vars.e2e>`.
CARRIED=(.sentry-dsn:SENTRY_DSN .github-app-id:GITHUB_APP_ID .github-app-key:GITHUB_APP_PRIVATE_KEY
  .github-app-api-base:GITHUB_APP_API_BASE .public-url:PIXELSLASH_PUBLIC_URL)

# Each secret release.sh carried in release $1 is saved with the CT's secrets, where every later
# release finds it, and the carried copy is removed.
take_carried() {
  local pair carried
  for pair in "${CARRIED[@]}"; do
    carried=$1/${pair%%:*}
    [[ -f $carried ]] || continue
    upsert_var "$SHARED_WEB/.dev.vars.e2e" "${pair#*:}" <"$carried"
    rm -f "$carried"
  done
}

# Names release $1 (sha $2) to Sentry, in the secrets copied into it: the deployed commit and `lan`.
# Only when a DSN is set, so a deployment without one is left exactly as it was.
stamp_sentry() {
  local vars=$1/apps/web/dist/server/.dev.vars
  grep -q '^SENTRY_DSN=.' "$vars" || return 0
  upsert_var "$vars" SENTRY_RELEASE <<<"$2"
  upsert_var "$vars" SENTRY_ENVIRONMENT <<<"lan"
}

# Unpacks $1 (the tarball) into $2 and installs its runtime dependencies there, beside the release
# that is serving. The release links the shared state.
unpack_release() {
  local tarball=$1 rel=$2
  rm -rf "$rel"
  as_app "mkdir -p $rel $SHARED_WEB/.wrangler/state"
  as_app "tar -xzf - -C $rel" <"$tarball"
  as_app "mkdir -p $rel/apps/web/.wrangler && ln -sfn $SHARED_WEB/.wrangler/state $rel/apps/web/.wrangler/state"
  as_app "cd $rel && bun install --frozen-lockfile --production"
}

# The directory holding release $1's units: releases before the rename (PS-247) keep them in
# `deploy/lan`, and a rollback can land on one.
deploy_dir() {
  if [[ -d $1/apps/web/deploy/ssh ]]; then echo "$1/apps/web/deploy/ssh"; else echo "$1/apps/web/deploy/lan"; fi
}

install_units() {
  local d
  d=$(deploy_dir "$1")
  install -m 644 "$d"/pixelslash-stub.service "$d"/pixelslash-diff.service \
    "$d"/pixelslash-web.service "$UNIT_DIR"/
  # A release before the watchdog (PS-323), which a rollback can land on, has none of it: what is
  # installed stays and keeps working. The script is copied out, owned by root who runs it, because
  # `pixelslash` owns the release.
  if [[ -f $d/pixelslash-watchdog.timer ]]; then
    install -m 644 "$d"/pixelslash-watchdog.service "$d"/pixelslash-watchdog.timer "$UNIT_DIR"/
    install -m 755 "$d"/watchdog.sh "$WATCHDOG_BIN"
  fi
}

# The liveness check is off while units restart on purpose. Stopping one that is not there yet (the
# first deploy with it, or one before it) is not a failure.
pause_watchdog() {
  systemctl stop pixelslash-watchdog.timer pixelslash-watchdog.service 2>/dev/null || true
}

resume_watchdog() {
  systemctl enable --now --quiet pixelslash-watchdog.timer
}

# Points `current` at $1 in one rename, so a unit never sees it missing.
set_current() {
  as_app "ln -sfn $1 $CURRENT.next && mv -T $CURRENT.next $CURRENT"
}

# Keeps the newest $KEEP_RELEASES releases (by when they were switched to) and whatever `current`
# points at; deletes the rest.
prune_releases() {
  local serving dir kept=0
  serving=$(readlink -f "$CURRENT")
  # shellcheck disable=SC2045 # release names are hex
  for dir in $(ls -1dt "$RELEASES"/*/); do
    dir=${dir%/}
    [[ ${dir##*/} =~ ^[0-9a-f]+$ ]] || continue
    if [[ $dir == "$serving" ]] || ((kept < KEEP_RELEASES)); then
      kept=$((kept + 1))
      continue
    fi
    echo "pruning release ${dir##*/}" >&2
    rm -rf "$dir"
  done
}

# Puts `current` back on $1, restarts it and deletes $2, the release this deploy unpacked (empty
# when it reused a kept one), so a bad release never takes one of the kept places from a good one;
# exits 1 either way.
rollback() {
  trap - ERR HUP INT TERM
  local prev=$1 failed=$2
  if [[ -z $prev ]]; then
    echo "update failed and there is no previous release to go back to" >&2
    exit 1
  fi
  echo "update failed: going back to ${prev##*/}" >&2
  pause_watchdog
  set_current "$prev"
  install_units "$prev"
  systemctl daemon-reload
  systemctl restart pixelslash-diff pixelslash-stub pixelslash-web
  [[ -z $failed || $failed == "$prev" ]] || rm -rf "$failed"
  if ! wait_for_port 3000 60 pixelslash-web; then
    echo "the previous release did not come up on :3000 either" >&2
  fi
  resume_watchdog || true
  exit 1
}

main() {
  local tarball=${1:?usage: update.sh <release.tar.gz>}
  command -v curl >/dev/null || { echo "curl is not installed: pixelslash-watchdog needs it" >&2; exit 1; }
  local name=${tarball##*/}
  name=${name%.tar.gz}
  name=${name#pixelslash-}
  [[ $name =~ ^[0-9a-f]{7,40}$ ]] || { echo "$tarball is not named <sha>.tar.gz" >&2; exit 1; }
  local rel=$RELEASES/$name prev="" unpacked=""
  [[ ! -L $CURRENT ]] || prev=$(readlink -f "$CURRENT")

  # Before anything changes: a deploy under a live build errors that build.
  [[ -z $prev ]] || refuse_live_build "$prev" || exit 1

  # Everything up to the switch happens beside the serving release, which does not notice; a failure
  # here deletes a release this deploy unpacked, so it never takes one of the kept places. One still
  # kept (going back to it, or the current one again to apply changed secrets)
  # is not unpacked again: `current` is pointed at it and it is restarted. Only a complete release
  # is kept, since a failed one is deleted.
  trap '[[ -z $unpacked ]] || rm -rf "$unpacked"; exit 1' ERR HUP INT TERM
  if [[ -d $rel ]]; then
    echo "release $name is already unpacked: switching to it" >&2
  else
    as_app "mkdir -p $RELEASES"
    unpacked=$rel
    unpack_release "$tarball" "$rel"
  fi
  take_carried "$rel"
  copy_secrets "$rel"
  stamp_sentry "$rel" "$name"
  # Additive only, so the release still serving runs on the migrated schema until the restart.
  d1 "$rel" migrations apply DB

  # From here a failure puts `current` back on the previous release and restarts it.
  trap 'rollback "$prev" "$unpacked"' ERR HUP INT TERM
  pause_watchdog
  install_units "$rel"
  retire_helper
  systemctl daemon-reload
  set_current "$rel"
  # No org explains through the retired helper. The table is there: the migration above made it. A
  # failure here is reported, not rolled back: the release is fine, and the next deploy tries again.
  d1 "$rel" execute DB --command "$(printf %q "DELETE FROM org_models WHERE base_url = '$HELPER_URL';")" ||
    echo "could not delete the retired helper's org_models rows: the next deploy tries again" >&2
  # The sidecar is up before the server that sends to it. A sidecar that does not come up costs
  # speed, not a result: it is reported, and the update goes on.
  systemctl enable --quiet pixelslash-diff
  systemctl restart pixelslash-diff
  if ! wait_for_port 4181; then
    journalctl -u pixelslash-diff -n 5 --no-pager >&2 || true
    echo "pixelslash-diff did not come up on :4181: server diffs run in-process, up to their limit" >&2
  fi
  systemctl enable --quiet pixelslash-stub pixelslash-web
  systemctl restart pixelslash-stub pixelslash-web
  # serve.ts (PS-220) starts Miniflare on :3000 in under a second on the CT; it gets 30 s. A
  # serve.ts that exits ends the wait when the unit does; a release that hangs, at the 30 s.
  if ! wait_for_port 3000 60 pixelslash-web; then
    journalctl -u pixelslash-web -n 5 --no-pager >&2 || true
    echo "pixelslash-web did not come up on :3000" >&2
    rollback "$prev" "$unpacked"
  fi
  resume_watchdog
  trap - ERR HUP INT TERM
  touch "$rel"
  prune_releases
  echo "release $name is serving" >&2
}

# Sourced by the test for its functions; run, it deploys.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
