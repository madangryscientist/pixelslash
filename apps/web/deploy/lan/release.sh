#!/usr/bin/env bash
# Deploy a commit to the LAN self-host (CT 135): build it here, ship the release, switch on the CT.
# Run from a clean checkout of that commit (the planner's land worktree), on the desktop. See
# apps/web/README.md, "Run it on the Proxmox server".
#
#   PIXELSLASH_LAN_SSH=root@<proxmox host> PIXELSLASH_LAN_CT=<ct id> \
#     [PIXELSLASH_LAN_SSH_KEY=<identity file>] apps/web/deploy/lan/release.sh <sha>
#
# The CT never builds (PS-225): the vite build cannot fit in its 2 GiB beside a running workerd (ob
# 1887), so it used to stop the server for the build. Here the build runs on this machine, the
# release (the commit's tracked files and the built dist) goes over ssh to the Proxmox host and in
# with `pct push`, and the release's own update.sh unpacks, installs and switches it on the CT.
set -Eeuo pipefail

main() {
  local sha=${1:?usage: release.sh <sha>}
  local ssh_dest=${PIXELSLASH_LAN_SSH:?set PIXELSLASH_LAN_SSH to the Proxmox host, e.g. root@<host>}
  local ct=${PIXELSLASH_LAN_CT:?set PIXELSLASH_LAN_CT to the CT id}
  local ssh_args=(-o BatchMode=yes)
  [[ -z ${PIXELSLASH_LAN_SSH_KEY:-} ]] || ssh_args+=(-i "$PIXELSLASH_LAN_SSH_KEY")

  local root
  root=$(git rev-parse --show-toplevel)
  cd "$root"
  # The release is the commit, not this working tree: a dirty tree or another HEAD would ship
  # something no commit names.
  sha=$(git rev-parse --verify --quiet "$sha^{commit}") || { echo "no commit $1" >&2; exit 1; }
  [[ $sha == "$(git rev-parse HEAD)" ]] || { echo "HEAD is not $sha: check it out first" >&2; exit 1; }
  [[ -z $(git status --porcelain) ]] || { echo "the checkout is not clean" >&2; exit 1; }
  local short=${sha:0:12}

  bun install --frozen-lockfile
  (cd apps/web && rm -rf dist && CLOUDFLARE_ENV=e2e bun run build)

  # Global, not local: the EXIT trap runs after main has returned.
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  # Every tracked file but bench/ (its corpora are large, and nothing on the CT runs it; the frozen
  # install skips a workspace that is not on disk).
  mkdir "$stage/$short"
  git archive --format=tar "$sha" -- . ':!bench' | tar -x -C "$stage/$short"
  cp -a apps/web/dist "$stage/$short/apps/web/dist"
  # This machine's .dev.vars must never reach the CT: it carries its own, which update.sh puts here.
  rm -f "$stage/$short/apps/web/dist/server/.dev.vars"
  tar -czf "$stage/$short.tar.gz" -C "$stage/$short" .
  echo "release $short: $(du -h "$stage/$short.tar.gz" | cut -f1)" >&2

  # On the Proxmox host: take the tarball from stdin, push it and its own update.sh into the CT, run
  # that update.sh there, and remove both copies whatever it exits with.
  # shellcheck disable=SC2016 # expanded on the host
  local remote='set -euo pipefail
ct=$1 short=$2 d=$(mktemp -d)
trap "rm -rf $d" EXIT
cat >"$d/$short.tar.gz"
tar -xzf "$d/$short.tar.gz" -C "$d" ./apps/web/deploy/lan/update.sh
pct push "$ct" "$d/$short.tar.gz" "/root/pixelslash-$short.tar.gz"
pct push "$ct" "$d/apps/web/deploy/lan/update.sh" /root/pixelslash-update.sh --perms 0755
status=0
pct exec "$ct" -- /root/pixelslash-update.sh "/root/pixelslash-$short.tar.gz" || status=$?
pct exec "$ct" -- rm -f "/root/pixelslash-$short.tar.gz" /root/pixelslash-update.sh
exit $status'
  ssh "${ssh_args[@]}" "$ssh_dest" "bash -c $(printf %q "$remote") _ $(printf %q "$ct") $short" \
    <"$stage/$short.tar.gz"
}

main "$@"
