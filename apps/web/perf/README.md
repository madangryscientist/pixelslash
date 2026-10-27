# Server memory during an upload burst (PS-214)

How much memory the LAN self-host (a Proxmox CT, `$CT`: `pixelslash-web.service` = `vite preview` in front of
workerd, and `pixelslash-diff.service` = the Bun diff sidecar) uses while a CI run uploads 50, 200
and 500 shots, split by phase and by process. On demand only: it is not in the gate.

Measured against the deployed commit **9f969e9** (the server under test). The driver in this folder
is the only change; no product code, unit file or `update.sh` was touched.

## Re-run

```bash
cd apps/web
perf/run.sh                     # 50, 200 and 500 shots, each from freshly restarted units
SHOTS="200" perf/run.sh out-dir # one size, into out-dir
bun perf/rss-burst.ts --shots 200 --out run.json   # one run, all flags in the file header
bun perf/table.ts perf/results/<run>               # the tables below
bun perf/rss-burst.ts --local 1 --server http://127.0.0.1:3301 --cg <app.slice cgroup> \
  --web-unit <unit>.service --diff-unit <unit>.service --shots 200 --out run.json   # a desktop run (PS-220, below)
```

Needs: ssh to the Proxmox host (`$SSH_HOST`, `pct exec $CT`), a personal token in
`~/.config/pixelslash/credentials.json` (or `PIXELSLASH_TOKEN`), and a quiet development machine and
CT: nothing else gating on the machine, nobody using the server. Each run restarts both units first.

**It leaves data on the CT.** There is no delete API, so each run keeps a throwaway project
(`ps-214-rss-<N>-<id>` in the `pixelslash` org) with its N shots on each side in R2 and D1. The 50, 200, 200 (rerun)
and 500 runs added about 2.6 GB; the CT's root disk was 2.9 GB free after them (9.8 GB, 70 % used).
Check `pct exec $CT -- df -h /` before a run, and do not run 500 again until that is cleaned up.

## Method

- **Corpus**: a mixed set of busy PNGs per N (`e2e/png.ts`): 2 of 10 at 1280x9500 (long pages), 3 at
  1440x6000, 3 at 1440x900, 2 at 390x844. 50 shots = 70 MB per side; 200 = 279 MB; 500 = 698 MB.
- **Flow** (what the CLI does, concurrency 4): open a main build, `PUT` every snapshot, finalize;
  open a branch build off it, `PUT` every snapshot, finalize until measured (the diff runs inline
  in the finalize with a 25 s budget, so the CLI calls it again until it is measured: 1 call at 50
  shots, 3 at 200, 6 at 500).
- **Phases**: `main PUTs`, `main finalize` (no baseline, nothing to diff), `branch PUTs`,
  `branch finalize (diff)` and then three settle windows (`+10s`, `+60s`, `+180s`) with no traffic.
- **Sampling** (`rss-sampler.py`, run on the CT every 0.25 s): `VmRSS` of every process in each
  unit's cgroup, summed per class (workerd, vite, sidecar); the cgroup's `memory.current`,
  `memory.swap.current`, anon and file bytes and the `high` event count. Each phase also reports
  `VmHWM`, the kernel's own peak, and the sampler resets it between phases with `clear_refs`, so a
  phase's peak is that phase's, not the run's.
- **Cold**: both units are restarted before every N, so N=500 does not inherit N=200's heap.
- **`GET /` probe** every ~1.5 s through the burst, to see whether the server stays answering.

## Results (MB)

Process columns are the peak `VmHWM` of the phase; `web unit` is the cgroup's peak `memory.current`
(MemoryHigh is 1400, MemoryMax 1700), which counts page cache as well as processes. Peaks in a row
do not add up: they are not at the same moment.

| shots | phase | s | workerd | vite | sidecar | web unit (cgroup) | swap | `high` events |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | idle (cold start) | | 141 | 558 | 24 | | | |
| 50 | main PUTs | 5 | 329 | 562 | 24 | 827 | 0 | 0 |
| 50 | main finalize | 1 | 300 | 557 | 24 | 807 | 0 | 0 |
| 50 | branch PUTs | 4 | 321 | 557 | 24 | 901 | 0 | 0 |
| 50 | branch finalize (diff) | 14 | 335 | 564 | 419 | 915 | 0 | 0 |
| 50 | settled +10s | 10 | 523 | 484 | 303 | 1078 | 0 | 0 |
| 50 | settled +60s | 50 | 520 | 485 | 288 | 1081 | 0 | 0 |
| 50 | settled +180s | 120 | 549 | 485 | 286 | 1087 | 0 | 0 |
| 200 | idle (cold start) | | 142 | 561 | 27 | | | |
| 200 | main PUTs | 17 | 389 | 561 | 27 | 1102 | 0 | 0 |
| 200 | main finalize | 2 | 366 | 554 | 26 | 1100 | 0 | 0 |
| 200 | branch PUTs | 25 | 497 | 555 | 26 | **1400** | 0 | 276 |
| 200 | branch finalize (diff) | 59 | 508 | 556 | 420 | **1395** | 0 | 285 |
| 200 | settled +10s | 11 | 689 | 488 | 320 | 1174 | 129 | 285 |
| 200 | settled +60s | 50 | 835 | 363 | 252 | 1107 | 252 | 285 |
| 200 | settled +180s | 120 | 846 | 243 | 242 | 1016 | 288 | 285 |
| 500 | idle (cold start) | | 142 | 566 | 25 | | | |
| 500 | main PUTs | 52 | 467 | 566 | 25 | **1400** | 0 | 401 |
| 500 | main finalize | 7 | 462 | 562 | 25 | **1400** | 0 | 442 |
| 500 | branch PUTs | 66 | 640 | 564 | 25 | **1400** | 0 | 2069 |
| 500 | branch finalize (diff) | 139 | 639 | 512 | 416 | **1400** | 0 | 2093 |
| 500 | settled +10s | 11 | 743 | 512 | 285 | 1220 | 236 | 2093 |
| 500 | settled +60s | 50 | 868 | 276 | 279 | 1040 | 327 | 2093 |
| 500 | settled +180s | 120 | 865 | 186 | 268 | 1034 | 376 | 2093 |

(`s` is the phase's wall time; the settle windows are `+10s`, `+50s` and `+120s` long.) The full data
is `results/2026-10-25-9f969e9/{50,200,500}.json`.

`GET /` never failed (0 of 25, 104 and 265 probes), but its slowest answer went 0.4 s, 2.3 s, 4.1 s.
Diffing is linear: 14, 59 and 139 s, about 0.28 s a shot.

**Repeat of 200** (`results/2026-10-25-9f969e9-rerun/200.json`, same commit, cold again, also split
into the cgroup's anon and file bytes):

| phase | workerd | vite | sidecar | web unit | anon / file | swap | `high` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| idle | 138 | 562 | 25 | | | | |
| main PUTs | 377 | 562 | 25 | 1110 | 802 / 307 | 0 | 0 |
| branch PUTs | 515 | 557 | 25 | 1400 | 940 / 504 | 0 | 264 |
| branch finalize (diff) | 515 | 559 | 431 | 1400 | 944 / 449 | 0 | 295 |
| settled +10s | 677 | 488 | 319 | 1235 | 998 / 301 | 31 | 295 |
| settled +60s | 798 | 464 | 251 | 1155 | 1072 / 97 | 123 | 295 |
| settled +180s | 957 | 391 | 460 | 1219 | 1097 / 187 | 432 | 295 |

The first four phases repeat within 5 %. The settle windows do not repeat as closely (workerd 846
against 957 at +180 s; the sidecar 242 against 460), so read those as "about 850 to 950" and "250 to 460".

## Verdict

The ~1.1 GB is not a baseline: a cold start is ~725 MB (workerd 140 + vite 560 + sidecar 25) and
the ~1.1 GB is what the unit settles at after *any* burst, 50 shots included (1.08 GB). What grows
with N is **workerd**, and it grows in the **snapshot PUT phases**: its peak went from 140 at idle to
330 (50), 390 to 515 (200) and 467 to 640 (500) as the PUTs came in, on top of the main build's
still-held memory, so the upload bytes are being held in workerd, not streamed through it. Then
workerd grows again with *no traffic*, in the 10 to 60 s after the diff finished: from its
diff-phase peak to its settled size it is +214 MB at 50 shots (335 to 549), +340 and +440 at 200
(508 to 846, 515 to 957) and +226 at 500 (639 to 865). It plateaus at about 850 to 950 MB at 200
and 500 alike, so that rise is not proportional to N, but it is the biggest single step, and this run does not say what is behind it (a background task after finalize, or workerd's
heap not being compacted; unmeasured). **vite does not grow** (560 MB flat); it only shrinks, because
once the cgroup hits MemoryHigh (1400 MB, reached at 200 shots in the branch PUTs and at 500 in the
main PUTs) the kernel swaps it out (swap peaks at 288 to 432 MB), which is also why `GET /` slowed
to 2.3 and 4.1 s. **The sidecar does not grow with N either**: ~420 MB at its peak at every size,
because the Worker sends it one shot at a time, so that figure is one diff's working set (the
1280x9500 shots), and 600 MB MemoryMax holds at 500 shots. The diff phase itself costs workerd
nothing; it costs the sidecar its 420 MB and 0.28 s a shot.

**Next cut**, in this order: (1) stop buffering a PUT body in workerd, so the upload phase stops
growing with the bytes (this is what the streaming Rust upload service of PS-217 should beat:
workerd peak 330 to 640 MB and a 1.4 GB unit at 200+ shots, with the same 0.28 s a shot to diff);
(2) find what workerd holds after finalize, since it is +200 to +450 MB with no work in flight and is the
reason the unit sits near its limit afterwards; (3) size the Rust service's diff concurrency from
the sidecar's ~420 MB per diff of a 1280x9500 page (one diff in flight today, so two in flight is
~850 MB, which does not fit the 600 MB MemoryMax the sidecar has now).

What this does not show: the upload and diff are both on the one 2 vCPU, 2 GiB CT, so `memory.high`
throttling stretches the PUT times at 200 and 500 shots (they are not a clean measure of the
server's speed); one corpus, one set of sizes, and a single run per N (plus the repeat at 200).

## PS-220: `serve.ts` in place of `vite preview` (desktop A/B)

`deploy/ssh/serve.ts` starts the built Worker on Miniflare directly, so there is no vite process
and no Node-to-workerd hop. This section is what that measured **on a development machine, not on the CT**:
a builder could not deploy a branch to the CT (`update.sh` reset it to `origin/main`; since PS-225
`release.sh` deploys any clean commit), and a 500-shot
run adds about 2.6 GB to a disk that had 2.9 GB free after PS-214. The CT run is still owed (below).

**Method.** Same harness, same corpus, same commit (**88ee718**'s product code plus `serve.ts`), one
arm after the other on a fresh `.wrangler/state` and fresh units: `rss-burst.ts --local 1` drives
the server as `systemd-run --user` units (`ps220-web`, `ps220-diff` with the sidecar's 450M/600M
caps, `ps220-stub`) and the sampler reads their cgroups. The arms differ in one thing:
`bun deploy/ssh/serve.ts` against `bunx vite preview` of the same `CLOUDFLARE_ENV=e2e` build.
`rss-sampler.py` classes the Bun process that runs Miniflare as `serve.ts`. The desktop was
busy (load ~8 on 12 cores) and the web units had **no** `MemoryHigh`, so nothing was swapped or
throttled; the cgroup column counts page cache the CT's cap would have reclaimed, so read the
**anon** column and the process columns, not the cgroup peak.
Data: `results/2026-10-26-88ee718-ps220/{serve,vite}/{50,200,500}.json`.

Peak `VmHWM` by process (MB), idle and after each burst has settled (+180 s):

| shots | arm | idle workerd / host / sidecar | settled workerd | settled vite or `serve.ts` | settled workerd + host | settled anon |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 50 | `serve.ts` | 137 / 114 / 27 | 290 | 106 | **396** | 285 |
| 50 | `vite preview` | 156 / 565 / 27 | 350 | 477 | 827 | 688 |
| 200 | `serve.ts` | 137 / 111 / 31 | 411 | 103 | **514** | 402 |
| 200 | `vite preview` | 155 / 563 / 27 | 518 | 428 | 946 | 808 |
| 500 | `serve.ts` | 135 / 114 / 27 | 588 | 106 | **694** | 580 |
| 500 | `vite preview` | 156 / 555 / 27 | 692 | 473 | 1165 | 1023 |

- **Idle**: workerd + the host is 251 MB under `serve.ts` (workerd 137, the Bun process 114) against
  721 MB under vite (156 + 565). PS-214 measured 141 + 558 on the CT. The Bun process that runs
  Miniflare is not free: it is the ~115 MB.
- **After a burst** the resident set is 430 to 470 MB lower at every size, and the cgroup's anon
  bytes 400 to 440 MB lower (peak anon at 500 shots 643 against 1083). workerd itself is 60 to
  105 MB smaller under `serve.ts` in this run; that part is within what one run per arm can say,
  and is confounded: the plugin's Miniflare is 5.20261012.0-beta (workerd 1.20261012.1) and
  `serve.ts` runs the `miniflare` the app depends on, 5.20261019.0-beta (workerd 1.20261019.1, the
  one `wrangler` in `apps/web` already uses). The ~450 MB is the vite and Node process, not workerd.
- **The sidecar is unchanged** (27 idle, 411 to 425 at its peak): it is the same process.
- `GET /` probes never failed on the `serve.ts` arm (0 of 16, 82 and 183); the slowest answer was
  0.2, 2.4 and 9.9 s, against 0.2, 0.3 and 3.8 s under vite. The slow ones are the 500-shot PUTs
  and finalize with a busy desktop and no cap; the CT run is where this matters.

**ECONNRESET (ob 1876).** None on `serve.ts`: the CLI-shaped driver sent 1, 2 and 4 finalizes
back to back (4 hand-offs in all, the next one sent the moment the last answered) straight to workerd's own socket
with Bun's `fetch`, and no request failed. It is a weak result, because the desktop does not
reproduce 1876 under `vite preview` either: with `freshConnectionPerRequest` switched off the same
200 and 500 runs (`results/.../vite-no-fresh-connection/`) also had no reset. What `serve.ts`
changes is structural: Miniflare's undici `Pool` is not on the path (workerd listens on the port
itself), so the pooled socket 1876 had to reset does not exist. What is left is the other end
of the connection: a client whose keep-alive socket workerd closes 50 ms after a long answer.
Bun's `fetch` does reset on that (a stand-in server that closes 40 ms after answering, then a
second request 5 ms later: 20 of 40 failed), and workerd on the desktop keeps an idle socket
15 s, so whether the CT's workerd closes early is for the CT run to show. If it does, the
real consequence is bounded: `upload-client.ts` retries a network error at 1, 2, 4, 8 and 15 s
and the finalize is resumable ("until measured"), so the CLI pays a second, not a failure.

**State survives the switch.** A build seeded under `vite preview` (org, project, a main and a
branch build with a changed shot, its PNGs in R2) was read back through `serve.ts` on the same
`.wrangler/state/v3`: the build, its `changes` verdict, and the signed baseline, branch and
diff image URLs all answered, and no second D1 database file or new R2 object appeared. The
database file is named from the D1 id, which `serve.ts` takes from `dist/server/wrangler.json`
as the plugin does.

**Verdict.** `serve.ts` takes about 450 MB out of the web unit at idle and after any burst, and
does not change what the PUT phases hold in workerd (same shape: 375 to 640 MB peak at 50 to 500
shots). **`MemoryHigh` / `MemoryMax` stay at 1400M / 1700M.** The desktop did not reproduce
PS-214's settled workerd on the CT (850 to 960 MB at 200 and 500 shots against 410 and 590
here), and on the CT's figure `serve.ts` (115) + workerd (960) is ~1.07 GB: a cap lowered by the
saving would sit under it. Lowering needs the CT's own numbers.

**Owed after the land**: deploy with `deploy/ssh/release.sh` (PS-225), then `perf/run.sh` on the CT (check
`df -h /` first, the disk note above) and read the settled workerd, the cgroup peak, and whether
any finalize hits `ECONNRESET` (`journalctl -u pixelslash-web`, and the driver stops on a failed
request). That is the PS-217 Q10 number and the basis for any lower cap.
