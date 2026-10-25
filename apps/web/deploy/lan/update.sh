#!/usr/bin/env bash
# Update the LAN self-host to origin/main: pull, stop, install, migrate, build, restart. Run as root
# on the CT. See apps/web/README.md, "Run it on the Proxmox server".
#
# pixelslash-web is stopped before the install and build. A running workerd holds ~1.5 GB of the
# CT's 2 GiB cgroup, the vite build then has no room and the CT thrashes page cache for tens of
# minutes (2026-10-23, ob 1887); with the server stopped the build takes seconds. The cost is a short
# downtime. If a step fails after the stop, the previous build is put back and started again.
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

HELPER_SWITCH=/etc/pixelslash/opencode-helper
HELPER_KEY=/home/pixelslash/.config/pixelslash/opencode.key
HELPER_URL=http://127.0.0.1:4180/v1
OPENCODE_BIN=/home/pixelslash/.opencode/bin/opencode

# Everything is in a function so bash has read the whole script before `git reset` rewrites it.
main() {
  local repo=/home/pixelslash/pixelslash
  local dist=$repo/apps/web/dist
  local prev=/home/pixelslash/dist.prev
  as_app() {
    runuser -u pixelslash -- env PATH=/home/pixelslash/.bun/bin:/usr/local/bin:/usr/bin:/bin \
      bash -c "cd $repo && $1"
  }

  # opencode, the release the capture image pins (docker/capture/Dockerfile: version and sha256),
  # from the same npm tarball. Installed once per version; nothing is downloaded when it is there.
  install_opencode() {
    local dockerfile=$repo/docker/capture/Dockerfile version sha
    version=$(sed -n 's/^ARG OPENCODE_VERSION=//p' "$dockerfile")
    # The ADD whose URL is the opencode tarball: its checksum is on the line before it.
    sha=$(grep -B1 'cli-linux-x64' "$dockerfile" | sed -n 's/.*--checksum=sha256:\([0-9a-f]*\).*/\1/p')
    [[ -n $version && -n $sha ]] || { echo "no pinned opencode in $dockerfile" >&2; exit 1; }
    if [[ -x $OPENCODE_BIN ]] && "$OPENCODE_BIN" --version 2>/dev/null | grep -qx "opencode v$version"; then
      return
    fi
    local tmp
    tmp=$(mktemp -d)
    curl -fsSL "https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-$version.tgz" -o "$tmp/opencode.tgz"
    echo "$sha  $tmp/opencode.tgz" | sha256sum -c --quiet
    tar -xzf "$tmp/opencode.tgz" -C "$tmp" --strip-components=2 package/bin/opencode
    install -d -o pixelslash -g pixelslash "$(dirname "$OPENCODE_BIN")"
    install -m 755 -o pixelslash -g pixelslash "$tmp/opencode" "$OPENCODE_BIN"
    rm -rf "$tmp"
  }

  # With the switch on, every org without a model of its own explains through the helper (the key
  # column is a placeholder: the real key is the helper's token file). An org that has a model of
  # its own keeps it. With it off, the rows that point at the helper are removed.
  point_models() {
    local sql
    sql=$(mktemp)
    if [[ -n $1 ]]; then
      cat >"$sql" <<SQL
INSERT INTO org_models (org_id, base_url, model, api_key, auto_pass_noise)
SELECT id, '$HELPER_URL', '$1', 'opencode-helper', 0 FROM orgs WHERE is_smoke = 0
ON CONFLICT (org_id) DO UPDATE SET model = excluded.model WHERE org_models.base_url = excluded.base_url;
SQL
    else
      echo "DELETE FROM org_models WHERE base_url = '$HELPER_URL';" >"$sql"
    fi
    chmod 644 "$sql"
    as_app "cd apps/web && bunx wrangler d1 execute DB --local --env e2e --file=$sql"
    rm -f "$sql"
  }

  # `restart` returns once the process is forked, so a unit that dies on start is seen by waiting
  # for its port: up to 10 s.
  wait_for_port() {
    for _ in $(seq 20); do
      if (echo >/dev/tcp/127.0.0.1/"$1") 2>/dev/null; then return 0; fi
      sleep 0.5
    done
    return 1
  }

  # A deploy checkout: nothing is edited or committed here, so main's tip wins.
  as_app "git fetch --quiet origin main && git reset --quiet --hard origin/main && git log --oneline -1"

  # The switch, read before anything is stopped: a bad one fails here, with the LAN still up.
  local helper_model="" had_helper=0
  [[ -f /etc/systemd/system/pixelslash-opencode.service ]] && had_helper=1
  if [[ -f $HELPER_SWITCH ]]; then
    helper_model=$(tr -d '[:space:]' <"$HELPER_SWITCH")
    [[ $helper_model =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] ||
      { echo "$HELPER_SWITCH must hold one provider/model, e.g. opencode-go/claude-haiku-5-5" >&2; exit 1; }
    [[ -f $HELPER_KEY && $(stat -c '%a %U' "$HELPER_KEY") == "600 pixelslash" ]] ||
      { echo "$HELPER_KEY must exist, mode 600, owned by pixelslash" >&2; exit 1; }
    install_opencode
  fi

  # From here a failure must not leave the LAN down: a failed build can leave dist half written, so
  # the old one is moved aside and put back, then the server is started on it (the checkout stays at
  # the new commit).
  trap rollback ERR HUP INT TERM
  rollback() {
    trap - ERR HUP INT TERM
    echo "update failed: starting the previous build again" >&2
    if [[ -d $prev ]]; then
      rm -rf "$dist"
      mv "$prev" "$dist"
    fi
    systemctl start pixelslash-web
    exit 1
  }

  systemctl stop pixelslash-web
  rm -rf "$prev"
  if [[ -d $dist ]]; then
    mv "$dist" "$prev"
  fi
  as_app "bun install --frozen-lockfile"
  as_app "cd apps/web && bunx wrangler d1 migrations apply DB --local --env e2e"
  as_app "cd apps/web && CLOUDFLARE_ENV=e2e bun run build"
  install -m 644 "$repo"/apps/web/deploy/lan/pixelslash-stub.service \
    "$repo"/apps/web/deploy/lan/pixelslash-diff.service \
    "$repo"/apps/web/deploy/lan/pixelslash-web.service /etc/systemd/system/
  if [[ -n $helper_model ]]; then
    install -m 644 "$repo"/apps/web/deploy/lan/pixelslash-opencode.service /etc/systemd/system/
  elif [[ $had_helper == 1 ]]; then
    systemctl disable --now --quiet pixelslash-opencode || true
    rm -f /etc/systemd/system/pixelslash-opencode.service
  fi
  systemctl daemon-reload
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
      rollback
    fi
  fi
  if [[ -n $helper_model || $had_helper == 1 ]]; then point_models "$helper_model"; fi
  systemctl enable --quiet pixelslash-stub pixelslash-web
  systemctl restart pixelslash-stub pixelslash-web
  trap - ERR HUP INT TERM
  rm -rf "$prev"
}

main "$@"
