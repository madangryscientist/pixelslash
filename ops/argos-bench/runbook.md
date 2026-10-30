# argos-bench: Argos's image comparison in a VM on a Proxmox host

One small Debian VM on the Proxmox host runs **only** Argos's image-comparison step
(`diffImages`, from an unmodified `argos-ci/argos` checkout at a pinned commit) in a Docker
container, behind our wrapper. It answers a single question for the benchmark: given base and head
PNGs, does Argos call the shot changed, and with what score and diff image?

The full Argos app (Postgres, Redis, RabbitMQ, S3, GitHub App) is **not** run. The maintainer decided
this on 2026-10-19 because the host is short of memory. Findings and how the comparison works are
in `docs/research/argos-local.md`.

Conventions: `pve#` is root on the Proxmox host, `vm$` is `debian` in the VM, `desk$` is your
machine, run from this repo's root. Set `SSH_HOST` (the Proxmox host), `VMID` (the VM's id), `VM_IP` (its address)
and `VM` (`<user>@$VM_IP`, where the user is `debian`) first.

## What exists

| | |
| --- | --- |
| VM | `$VMID` `argos-bench`. Full VM, not an LXC, because it builds and runs downloaded code. `onboot: 0` |
| host | a Proxmox host, `$SSH_HOST` (PVE 9.2.2) |
| address | `$VM_IP`, by DHCP on `vmbr0`. Not reserved on the router (see below) |
| resources | 2 vCPU (`cpu: host`), 2048 MB RAM, no swap, 20 GB disk on `local-lvm` |
| OS | Debian 13 genericcloud `20261017-2634`, user `debian`, your public key |
| Docker | `docker.io` 26.1.5 + `docker-buildx` from Debian's archive |
| image | `argos-bench`, 1.6 GB. Argos `21e8520c28129d501b22028a5499546b03336e38` on `node:26-bookworm-slim` |
| on the host | `/root/argos-bench/` (cloud image, `desktop.pub`, `provision-vm.sh`) and the VM's two volumes. Nothing else. `nmap`, used to find the address, was already installed on the host |
| exposure | LAN only. No tunnel, no port forward, no DNS, and nothing listens: the bench is driven over ssh |

Every `ssh` below assumes the key that logs in to the Proxmox host is your default one; if it is
not, add `-i ~/.ssh/<key>`, or an `IdentityFile` in `~/.ssh/config`.

## The files

| file | runs where | what it is |
| --- | --- | --- |
| `provision-vm.sh` | the Proxmox host, root | checks free RAM, downloads and checksums the cloud image, creates and starts the VM, finds its DHCP address |
| `setup-vm.sh` | VM, root (sent over ssh) | installs Docker and creates `~/argos-bench/work` |
| `Dockerfile` | VM | clones Argos at the pinned commit, installs the backend workspace, adds the wrapper |
| `argos-diff.ts` | VM, in the container | our wrapper: calls Argos's `diffImages` and prints JSON lines |
| `run-pairs.sh` | desktop | sends a directory of pairs to the VM, runs the container, fetches verdicts and diff images |

## Rebuild from nothing

### Step 0: check the host

```
desk$ ssh root@$SSH_HOST 'grep MemAvailable /proc/meminfo; pvesh get /cluster/nextid; qm list; pct list; pvesm status'
```

**Verify:** `MemAvailable` is at least 2.5 GB (2621440 kB). The script refuses below 2560 MB. the VM id
is free, or is this VM. `local-lvm` has more than 20 GB free. As of 2026-10-19 the host had
15.5 GiB RAM, 4 cores and about 6.5 GiB available, and was already swapping. That is why the VM is
small and does not start at boot.

**If it fails:** stop. The fix is capacity, not a bigger VM.

### Step 1: provision the VM

```
desk$ ssh root@$SSH_HOST 'install -d -m 0700 /root/argos-bench'
desk$ scp ~/.ssh/<key>.pub root@$SSH_HOST:/root/argos-bench/desktop.pub
desk$ scp ops/argos-bench/provision-vm.sh root@$SSH_HOST:/root/argos-bench/
desk$ ssh root@$SSH_HOST bash /root/argos-bench/provision-vm.sh <vmid> <bridge> <subnet>
```

The VM id, the bridge and the subnet to scan are required arguments; the other defaults are environment variables at the top of the script (`ARGOS_BENCH_MEMORY`,
`_CORES`, `_DISK_GB`, `_IMAGE_BUILD`, …). A re-run is safe: it leaves an existing VM alone if
the description says `ob 1476`, and refuses if the id is anything else. The last thing it prints is
the VM's address. If DHCP hands out a different one later, the same re-run finds it again.

**Verify:** `ssh $VM true` works from your machine. `qm config $VMID` shows `cores: 2`,
`memory: 2048` and `onboot: 0`.

**Rollback:** see "Destroy".

### Step 2: Docker in the VM

```
desk$ ssh $VM 'cloud-init status --wait'
desk$ ssh $VM 'sudo bash -s' < ops/argos-bench/setup-vm.sh
```

**Verify:** `ssh $VM docker info` works without sudo. If it does not, log out and
in again, because the `docker` group membership is new.

### Step 3: build the image

```
desk$ scp ops/argos-bench/Dockerfile ops/argos-bench/argos-diff.ts $VM:argos-bench/
desk$ ssh $VM 'cd argos-bench && docker build -t argos-bench .'
```

The build takes about 3 minutes and fetches from github.com, npm and Debian. That is the only time
the VM goes out to the internet. Peak memory measured during the build was 1.2 GB, with no swap.
To pin a different Argos commit, pass `--build-arg ARGOS_COMMIT=<sha>` and record it in the doc.

**Verify:** run Argos's own unit tests for this code path inside the image, with no network:

```
desk$ ssh $VM 'docker run --rm --network none --entrypoint /bench/self-test argos-bench'
```

Expect `Tests 27 passed (27)`. That is their `diff/image/index.test.ts` calibration table and
`test/diff.test.ts` snapshot scores. `--testTimeout 30000` is set because on 2 vCPU their
`different-dimensions` case takes 4–10 s, and vitest's default timeout is 5 s.

### Step 4: run pairs

```
desk$ mkdir -p /tmp/pairs/pages
desk$ cp main.png /tmp/pairs/pages/base.png; cp branch.png /tmp/pairs/pages/head.png
desk$ ops/argos-bench/run-pairs.sh /tmp/pairs /tmp/argos-out          # [--threshold 0.5]
```

The script prints one JSON line per pair and writes `/tmp/argos-out/verdicts.jsonl` plus
`<name>.diff.png` for each pair Argos calls changed. `ARGOS_BENCH_HOST` and
`ARGOS_BENCH_KEY` are required: the VM's `user@host` and the ssh key that logs in to it.

## Start and stop

The VM does not start with the host. Start it for a bench run and stop it afterwards, so it is not
holding 2 GB on a host that is already swapping:

```
desk$ ssh root@$SSH_HOST "qm start $VMID"      # address may change: re-run provision-vm.sh to find it
desk$ ssh root@$SSH_HOST "qm shutdown $VMID"
```

The image survives a restart. Nothing in the VM runs between bench runs.

## Destroy

```
desk$ ssh root@$SSH_HOST "qm stop $VMID; qm destroy $VMID --purge"
desk$ ssh root@$SSH_HOST 'rm -rf /root/argos-bench'
desk$ ssh-keygen -R $VM_IP
```

That removes everything this ticket put on the host.

## Left for a human

- **DHCP reservation** for the VM's MAC (`qm config $VMID`, `net0`) on the router, if you want the
  address stable. This is optional: `provision-vm.sh` re-finds the address.
- Nothing else. No GitHub App, no OAuth app, no Argos account was needed.
