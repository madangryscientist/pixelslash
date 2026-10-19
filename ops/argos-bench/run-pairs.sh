#!/usr/bin/env bash
# From the desktop (ob 1476): send N screenshot pairs to the argos-bench VM, run Argos's
# comparison on them there, and bring the verdicts and diff images back.
#
#   ops/argos-bench/run-pairs.sh <pairs-dir> <out-dir> [--threshold n]
#
# <pairs-dir>/<name>/base.png and <pairs-dir>/<name>/head.png, one directory per pair.
# Writes <out-dir>/verdicts.jsonl (one JSON object per pair) and <out-dir>/<name>.diff.png for
# every pair Argos calls changed. The container runs with --network none: pairs go in over ssh,
# and nothing leaves the VM.
set -euo pipefail

VM="${ARGOS_BENCH_HOST:-debian@192.168.0.45}"
KEY="${ARGOS_BENCH_KEY:-$HOME/.ssh/id_ed25519_mac}"
[ $# -ge 2 ] || { sed -n '4,9p' "$0" >&2; exit 2; }
pairs="$1"; out="$2"; shift 2

ssh_() { ssh -o BatchMode=yes -i "$KEY" "$VM" "$@"; }
run="argos-bench/work/run-$(date +%Y%m%d-%H%M%S)-$$"

tmp="$(mktemp -d)"
# Whatever happens (a failed tar, a failed run, Ctrl-C), remove both the local and the VM copy.
trap 'rm -rf "$tmp"; ssh_ "rm -rf $run" || true' EXIT

ssh_ "mkdir -p $run/in $run/out"
tar -C "$pairs" -cf - . | ssh_ "tar -C $run/in -xf -"
# --user: files in the run dir stay the debian user's, so the trap can remove them.
ssh_ "docker run --rm --network none --user \$(id -u):\$(id -g) -v \$HOME/$run:/work argos-bench --pairs /work/in /work/out $*" \
  > "$tmp/verdicts.jsonl"

mkdir -p "$out"
# The wrapper prints container paths (/work/out/<name>.diff.png); rewrite them to local ones.
sed "s|\"/work/out/|\"$out/|g" "$tmp/verdicts.jsonl" > "$out/verdicts.jsonl"
ssh_ "tar -C $run/out -cf - ." | tar -C "$out" -xf -
cat "$out/verdicts.jsonl"
