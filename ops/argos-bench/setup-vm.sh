#!/usr/bin/env bash
# Inside the argos-bench VM, as root (ob 1476): Docker from Debian's own archive.
# Run from the desktop:  ssh debian@<ip> 'sudo bash -s' < ops/argos-bench/setup-vm.sh
# Idempotent: re-running changes nothing that is already in place.
set -euo pipefail

if command -v docker >/dev/null; then
  echo "docker already installed: $(docker --version)"
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  # docker.io is trixie's own Docker; docker-buildx so `docker build` uses BuildKit.
  apt-get install -y -q docker.io docker-buildx
  systemctl enable --now docker
fi
usermod -aG docker debian

install -d -o debian -g debian /home/debian/argos-bench /home/debian/argos-bench/work
docker --version
free -m
