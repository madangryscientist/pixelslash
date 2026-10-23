#!/usr/bin/env bash
# Update the LAN self-host to origin/main: pull, stop, install, migrate, build, restart. Run as root
# on the CT. See apps/web/README.md, "Run it on the Proxmox server".
#
# pixelslash-web is stopped before the install and build. A running workerd holds ~1.5 GB of the
# CT's 2 GiB cgroup, the vite build then has no room and the CT thrashes page cache for tens of
# minutes (2026-10-23, ob 1887); with the server stopped the build takes seconds. The cost is a short
# downtime. If a step fails after the stop, the previous build is put back and started again.
set -Eeuo pipefail

# Everything is in a function so bash has read the whole script before `git reset` rewrites it.
main() {
  local repo=/home/pixelslash/pixelslash
  local dist=$repo/apps/web/dist
  local prev=/home/pixelslash/dist.prev
  as_app() {
    runuser -u pixelslash -- env PATH=/home/pixelslash/.bun/bin:/usr/local/bin:/usr/bin:/bin \
      bash -c "cd $repo && $1"
  }

  # A deploy checkout: nothing is edited or committed here, so main's tip wins.
  as_app "git fetch --quiet origin main && git reset --quiet --hard origin/main && git log --oneline -1"

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
  install -m 644 "$repo"/apps/web/deploy/lan/*.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --quiet pixelslash-stub pixelslash-web
  systemctl restart pixelslash-stub pixelslash-web
  trap - ERR HUP INT TERM
  rm -rf "$prev"
}

main "$@"
