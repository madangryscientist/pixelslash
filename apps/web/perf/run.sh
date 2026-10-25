#!/usr/bin/env bash
# PS-214: the burst at 50, 200 and 500 shots, each from a freshly restarted unit, one after another.
# From apps/web: perf/run.sh [out-dir]. Needs ssh to the Proxmox host, a token for the server in
# ~/.config/pixelslash/credentials.json, and an otherwise quiet desktop and CT (perf/README.md).
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-perf/results/$(date +%F)-$(git rev-parse --short HEAD)}"
mkdir -p "$out"
for n in ${SHOTS:-50 200 500}; do
  bun perf/rss-burst.ts --shots "$n" --commit "$(git rev-parse --short HEAD)" --out "$out/$n.json" >/dev/null
  echo "done $n -> $out/$n.json"
done
