#!/usr/bin/env bash
# Provision the argos-bench VM on the Proxmox host (ob 1476).
#
# Runs AS ROOT ON THE PROXMOX HOST (192.168.0.20). It creates ONE small Debian 13 VM from the
# official cloud image, on DHCP on vmbr0, with the desktop's ssh key for user `debian`, then
# finds the address DHCP gave it and prints it. It does not install anything inside the VM:
# that is setup-vm.sh, run from the desktop over ssh (this host holds no key for the VM).
#
# A full VM, not an LXC, because it builds and runs downloaded code (argos-ci/argos).
#
# Every step is guarded, so re-running is safe: an existing VM made by this script is left as it
# is, an existing image is not re-downloaded, and a VMID used by anything else is refused.
#
# What it touches on the host, and nothing else: /root/argos-bench/ (the image and the key) and
# one VM's disks on $STORAGE. No storage, bridge, firewall or other guest is changed.
set -euo pipefail

VMID="${ARGOS_BENCH_VMID:-101}"
NAME="${ARGOS_BENCH_NAME:-argos-bench}"
CORES="${ARGOS_BENCH_CORES:-2}"
MEMORY_MB="${ARGOS_BENCH_MEMORY:-2048}"
DISK_GB="${ARGOS_BENCH_DISK_GB:-20}"
STORAGE="${ARGOS_BENCH_STORAGE:-local-lvm}"
BRIDGE="${ARGOS_BENCH_BRIDGE:-vmbr0}"
SUBNET="${ARGOS_BENCH_SUBNET:-192.168.0.0/24}"
MIN_FREE_MB="${ARGOS_BENCH_MIN_FREE_MB:-2560}"
PUBKEY="${ARGOS_BENCH_PUBKEY:-/root/argos-bench/desktop.pub}"
# A dated build, not `latest`, so a rebuild gets the same image. The checksum is checked against
# the same directory's SHA512SUMS.
IMAGE_BUILD="${ARGOS_BENCH_IMAGE_BUILD:-20261017-2634}"
IMAGE_NAME="debian-13-genericcloud-amd64-${IMAGE_BUILD}.qcow2"
IMAGE_URL="https://cloud.debian.org/images/cloud/trixie/${IMAGE_BUILD}/${IMAGE_NAME}"
SUMS_URL="https://cloud.debian.org/images/cloud/trixie/${IMAGE_BUILD}/SHA512SUMS"
WORK=/root/argos-bench
TAG="argos-bench (ob 1476)"

step() { printf '\n== %s\n' "$*"; }

# --- 0. preflight ------------------------------------------------------------
step "preflight"
command -v qm >/dev/null || { echo "qm not found: this script runs on the Proxmox HOST" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "run as root on the Proxmox host" >&2; exit 1; }
# nmap finds the VM's DHCP address (step 4). It was already on pve; this script does not install it.
command -v nmap >/dev/null || { echo "nmap not found: needed to find the VM's address" >&2; exit 1; }
pvesm status | awk 'NR>1 {print $1}' | grep -qx "$STORAGE" || { echo "no such storage: $STORAGE" >&2; exit 1; }
[ -s "$PUBKEY" ] || { echo "no ssh public key at $PUBKEY (runbook step 1 copies it there)" >&2; exit 1; }

exists=0
if qm status "$VMID" >/dev/null 2>&1; then
  case "$(qm config "$VMID" | sed -n 's/^description: //p')" in
    *"ob 1476"*) exists=1; echo "VM $VMID already exists and is this one; leaving its config alone" ;;
    *) echo "REFUSING: VMID $VMID exists and was not created by this script. Pick a free id with ARGOS_BENCH_VMID." >&2; exit 1 ;;
  esac
elif pct status "$VMID" >/dev/null 2>&1; then
  echo "REFUSING: $VMID is a container. Pick a free id with ARGOS_BENCH_VMID." >&2; exit 1
fi

if [ "$exists" -eq 0 ]; then
  avail_mb=$(( $(awk '/^MemAvailable/ {print $2}' /proc/meminfo) / 1024 ))
  echo "MemAvailable: ${avail_mb} MB (need ${MIN_FREE_MB})"
  [ "$avail_mb" -ge "$MIN_FREE_MB" ] || { echo "STOP: not enough free memory on the host" >&2; exit 1; }
fi

# --- 1. the cloud image ------------------------------------------------------
step "image $IMAGE_NAME"
install -d -m 0700 "$WORK"
if [ -s "$WORK/$IMAGE_NAME" ]; then
  echo "already downloaded"
else
  curl -fsSL -o "$WORK/$IMAGE_NAME.part" "$IMAGE_URL"
  mv "$WORK/$IMAGE_NAME.part" "$WORK/$IMAGE_NAME"
fi
want="$(curl -fsSL "$SUMS_URL" | awk -v f="debian-13-genericcloud-amd64-${IMAGE_BUILD}.qcow2" '$2==f {print $1}')"
have="$(sha512sum "$WORK/$IMAGE_NAME" | awk '{print $1}')"
[ -n "$want" ] && [ "$want" = "$have" ] || { echo "checksum mismatch for $IMAGE_NAME" >&2; rm -f "$WORK/$IMAGE_NAME"; exit 1; }
echo "sha512 ok"

# --- 2. the VM ---------------------------------------------------------------
# Not started at boot (onboot 0): it is a bench, and this host is short of memory. The serial
# console is the only display, which is what the cloud image expects.
step "VM $VMID ($NAME)"
if [ "$exists" -eq 1 ]; then
  echo "already exists"
else
  qm create "$VMID" \
    --name "$NAME" \
    --description "$TAG: Argos image-comparison bench. Runs downloaded code; LAN only, no tunnel, no port forward. Destroy with: qm stop $VMID && qm destroy $VMID --purge" \
    --ostype l26 \
    --cores "$CORES" --cpu host \
    --memory "$MEMORY_MB" \
    --net0 "virtio,bridge=${BRIDGE}" \
    --scsihw virtio-scsi-single \
    --scsi0 "${STORAGE}:0,import-from=${WORK}/${IMAGE_NAME},discard=on" \
    --ide2 "${STORAGE}:cloudinit" \
    --boot order=scsi0 \
    --serial0 socket --vga serial0 \
    --ciuser debian \
    --sshkeys "$PUBKEY" \
    --ipconfig0 ip=dhcp \
    --onboot 0
  qm disk resize "$VMID" scsi0 "${DISK_GB}G"
fi

# --- 3. start ----------------------------------------------------------------
step "start"
if [ "$(qm status "$VMID" | awk '{print $2}')" = "running" ]; then
  echo "already running"
else
  qm start "$VMID"
fi

# --- 4. find its DHCP address ------------------------------------------------
# The cloud image has no guest agent, so the address is found by MAC with an ARP ping sweep of
# the LAN (nmap -sn). nmap sends its ARP probes raw, so they do not land in the kernel's
# neighbour table: read the answer from nmap's own output.
step "address"
mac="$(qm config "$VMID" | sed -n 's/^net0: virtio=\([0-9A-Fa-f:]*\),.*/\1/p' | tr 'a-f' 'A-F')"
ip=""
for _ in $(seq 1 30); do
  ip="$(nmap -sn -n "$SUBNET" 2>/dev/null \
    | awk -v m="$mac" '/^Nmap scan report for/ {h=$NF} /^MAC Address:/ && toupper($3)==m {print h; exit}')"
  [ -n "$ip" ] && break
  sleep 5
done
[ -n "$ip" ] || { echo "VM $VMID is up but its address was not found (MAC $mac). Read it from the router's DHCP list." >&2; exit 1; }

cat <<EOF

VM $VMID ($NAME) is running at $ip  (MAC $mac, DHCP on $BRIDGE).
$CORES vCPU, $MEMORY_MB MB, ${DISK_GB} GB on $STORAGE. User: debian, key: $PUBKEY.

Next (from the desktop): ops/argos-bench/runbook.md, step 3.
  ssh debian@$ip true
EOF
