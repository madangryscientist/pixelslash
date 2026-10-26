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
# The opencode helper (ob 1900) is a switch: the file /etc/pixelslash/opencode-helper holds the
# model (`provider/model`), and while it exists this script installs opencode, installs and enables
# pixelslash-opencode, and points every org without a model of its own at the helper. Without the
# file nothing about the helper is installed, and one that was is disabled and removed. See
# apps/web/README.md, "The AI explain step through opencode".
#
# The diff sidecar (PS-203) is always installed: pixelslash-diff runs the server diff with the
# napi-image codec on 127.0.0.1:4181, and is restarted before pixelslash-web. One that does not come
# up is reported and the update goes on, since the Worker then diffs in-process with pngjs, as it
# did before the sidecar. See apps/web/README.md, "The diff sidecar".
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
HELPER_SWITCH=${PIXELSLASH_HELPER_SWITCH:-/etc/pixelslash/opencode-helper}
HELPER_KEY=$APP_HOME/.config/pixelslash/opencode.key
HELPER_URL=http://127.0.0.1:4180/v1
OPENCODE_BIN=$APP_HOME/.opencode/bin/opencode
D1_RETRY_SLEEP=${PIXELSLASH_D1_RETRY_SLEEP:-2}

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

# opencode, the release the capture image pins ($1/docker/capture/Dockerfile: version and sha256),
# from the same npm tarball. Installed once per version; nothing is downloaded when it is there.
install_opencode() {
  local dockerfile=$1/docker/capture/Dockerfile version sha
  version=$(sed -n 's/^ARG OPENCODE_VERSION=//p' "$dockerfile")
  # The ADD whose URL is the opencode tarball: its checksum is on the line before it.
  sha=$(grep -B1 'cli-linux-x64' "$dockerfile" | sed -n 's/.*--checksum=sha256:\([0-9a-f]*\).*/\1/p')
  [[ -n $version && -n $sha ]] || { echo "no pinned opencode in $dockerfile" >&2; return 1; }
  if [[ -x $OPENCODE_BIN ]] && "$OPENCODE_BIN" --version 2>/dev/null | grep -qx "opencode v$version"; then
    return
  fi
  local tmp
  tmp=$(mktemp -d)
  curl -fsSL "https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-$version.tgz" -o "$tmp/opencode.tgz"
  echo "$sha  $tmp/opencode.tgz" | sha256sum -c --quiet
  tar -xzf "$tmp/opencode.tgz" -C "$tmp" --strip-components=2 package/bin/opencode
  install -d -o "$APP_USER" -g "$APP_USER" "$(dirname "$OPENCODE_BIN")"
  install -m 755 -o "$APP_USER" -g "$APP_USER" "$tmp/opencode" "$OPENCODE_BIN"
  rm -rf "$tmp"
}

# With the switch on, every org without a model of its own explains through the helper (the key
# column is a placeholder: the real key is the helper's token file). An org that has a model of
# its own keeps it. With it off, the rows that point at the helper are removed. $1 is the release.
point_models() {
  local sql
  sql=$(mktemp)
  if [[ -n $2 ]]; then
    cat >"$sql" <<SQL
INSERT INTO org_models (org_id, base_url, model, api_key, auto_pass_noise)
SELECT id, '$HELPER_URL', '$2', 'opencode-helper', 0 FROM orgs WHERE is_smoke = 0
ON CONFLICT (org_id) DO UPDATE SET model = excluded.model WHERE org_models.base_url = excluded.base_url;
SQL
  else
    echo "DELETE FROM org_models WHERE base_url = '$HELPER_URL';" >"$sql"
  fi
  chmod 644 "$sql"
  d1 "$1" execute DB --file="$sql"
  rm -f "$sql"
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

# A DSN release.sh carried in release $1 is saved with the CT's secrets, where every later release
# finds it, and the carried copy is removed.
take_sentry_dsn() {
  local carried=$1/.sentry-dsn
  [[ -f $carried ]] || return 0
  upsert_var "$SHARED_WEB/.dev.vars.e2e" SENTRY_DSN <"$carried"
  rm -f "$carried"
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

install_units() {
  install -m 644 "$1"/apps/web/deploy/lan/pixelslash-stub.service \
    "$1"/apps/web/deploy/lan/pixelslash-diff.service \
    "$1"/apps/web/deploy/lan/pixelslash-web.service "$UNIT_DIR"/
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
  set_current "$prev"
  install_units "$prev"
  # The helper too, when it is installed: it would otherwise run on from the deleted release.
  local units=(pixelslash-diff pixelslash-stub pixelslash-web)
  if [[ -f $UNIT_DIR/pixelslash-opencode.service ]]; then
    [[ ! -f $prev/apps/web/deploy/lan/pixelslash-opencode.service ]] ||
      install -m 644 "$prev"/apps/web/deploy/lan/pixelslash-opencode.service "$UNIT_DIR"/
    units+=(pixelslash-opencode)
  fi
  systemctl daemon-reload
  systemctl restart "${units[@]}"
  [[ -z $failed || $failed == "$prev" ]] || rm -rf "$failed"
  if ! wait_for_port 3000 60 pixelslash-web; then
    echo "the previous release did not come up on :3000 either" >&2
  fi
  exit 1
}

main() {
  local tarball=${1:?usage: update.sh <release.tar.gz>}
  local name=${tarball##*/}
  name=${name%.tar.gz}
  name=${name#pixelslash-}
  [[ $name =~ ^[0-9a-f]{7,40}$ ]] || { echo "$tarball is not named <sha>.tar.gz" >&2; exit 1; }
  local rel=$RELEASES/$name prev="" unpacked=""
  [[ ! -L $CURRENT ]] || prev=$(readlink -f "$CURRENT")

  # The switch, read before anything changes: a bad one fails here, with the LAN still up.
  local helper_model="" had_helper=0
  [[ -f $UNIT_DIR/pixelslash-opencode.service ]] && had_helper=1
  if [[ -f $HELPER_SWITCH ]]; then
    helper_model=$(tr -d '[:space:]' <"$HELPER_SWITCH")
    [[ $helper_model =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] ||
      { echo "$HELPER_SWITCH must hold one provider/model, e.g. opencode-go/claude-haiku-5-5" >&2; exit 1; }
    [[ -f $HELPER_KEY && $(stat -c '%a %U' "$HELPER_KEY") == "600 $APP_USER" ]] ||
      { echo "$HELPER_KEY must exist, mode 600, owned by $APP_USER" >&2; exit 1; }
  fi

  # Everything up to the switch happens beside the serving release, which does not notice; a failure
  # here deletes a release this deploy unpacked, so it never takes one of the kept places. One still
  # kept (going back to it, or the current one again to apply a changed helper switch or secrets)
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
  take_sentry_dsn "$rel"
  copy_secrets "$rel"
  stamp_sentry "$rel" "$name"
  [[ -z $helper_model ]] || install_opencode "$rel"
  # Additive only, so the release still serving runs on the migrated schema until the restart.
  d1 "$rel" migrations apply DB

  # From here a failure puts `current` back on the previous release and restarts it.
  trap 'rollback "$prev" "$unpacked"' ERR HUP INT TERM
  install_units "$rel"
  if [[ -n $helper_model ]]; then
    install -m 644 "$rel"/apps/web/deploy/lan/pixelslash-opencode.service "$UNIT_DIR"/
  elif [[ $had_helper == 1 ]]; then
    systemctl disable --now --quiet pixelslash-opencode || true
    rm -f "$UNIT_DIR"/pixelslash-opencode.service
  fi
  systemctl daemon-reload
  set_current "$rel"
  # The sidecar is up before the server that sends to it. Waited for like the helper, but a sidecar
  # that does not come up costs speed, not a result: it is reported, and the update goes on.
  systemctl enable --quiet pixelslash-diff
  systemctl restart pixelslash-diff
  if ! wait_for_port 4181; then
    journalctl -u pixelslash-diff -n 5 --no-pager >&2 || true
    echo "pixelslash-diff did not come up on :4181: server diffs run in-process (pngjs)" >&2
  fi
  # The helper is up before any org is pointed at it: a unit that will not start fails the update
  # here, and no row aims at a port with nothing behind it.
  if [[ -n $helper_model ]]; then
    systemctl enable --quiet pixelslash-opencode
    systemctl restart pixelslash-opencode
    # `restart` returns once the process is forked, so a helper that dies on start (a missing
    # module, a bad key file) is only seen by waiting for its port. Without it no row points there.
    if ! wait_for_port 4180; then
      journalctl -u pixelslash-opencode -n 5 --no-pager >&2 || true
      echo "pixelslash-opencode did not come up on :4180" >&2
      rollback "$prev" "$unpacked"
    fi
  fi
  if [[ -n $helper_model || $had_helper == 1 ]]; then point_models "$rel" "$helper_model"; fi
  systemctl enable --quiet pixelslash-stub pixelslash-web
  systemctl restart pixelslash-stub pixelslash-web
  # serve.ts (PS-220) starts Miniflare on :3000 in under a second on the CT; it gets 30 s. A
  # serve.ts that exits ends the wait when the unit does; a release that hangs, at the 30 s.
  if ! wait_for_port 3000 60 pixelslash-web; then
    journalctl -u pixelslash-web -n 5 --no-pager >&2 || true
    echo "pixelslash-web did not come up on :3000" >&2
    rollback "$prev" "$unpacked"
  fi
  trap - ERR HUP INT TERM
  touch "$rel"
  prune_releases
  echo "release $name is serving" >&2
}

# Sourced by the test for its functions; run, it deploys.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
