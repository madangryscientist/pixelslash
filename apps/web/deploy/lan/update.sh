#!/usr/bin/env bash
# Update the LAN self-host to origin/main: pull, install, migrate, build, restart. Run as root on
# the CT. See apps/web/README.md, "Run it on the Proxmox server".
set -euo pipefail

# Everything is in a function so bash has read the whole script before `git reset` rewrites it.
main() {
  local repo=/home/pixelslash/pixelslash
  as_app() {
    runuser -u pixelslash -- env PATH=/home/pixelslash/.bun/bin:/usr/local/bin:/usr/bin:/bin \
      bash -c "cd $repo && $1"
  }
  # A deploy checkout: nothing is edited or committed here, so main's tip wins.
  as_app "git fetch --quiet origin main && git reset --quiet --hard origin/main && git log --oneline -1"
  as_app "bun install --frozen-lockfile"
  as_app "cd apps/web && bunx wrangler d1 migrations apply DB --local --env e2e"
  as_app "cd apps/web && CLOUDFLARE_ENV=e2e bun run build"
  install -m 644 "$repo"/apps/web/deploy/lan/*.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --quiet pixelslash-stub pixelslash-web
  systemctl restart pixelslash-stub pixelslash-web
}

main "$@"
