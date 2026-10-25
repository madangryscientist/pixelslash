# Server memory during an upload burst (PS-214)

How much memory the LAN self-host (CT 135: `pixelslash-web.service` = `vite preview` in front of
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
```

Needs: ssh to the Proxmox host (`~/.ssh/id_ed25519_mac`, `pct exec 135`), a personal token in
`~/.config/pixelslash/credentials.json` (or `PIXELSLASH_TOKEN`), and a quiet desktop and CT: nothing
else gating on the desktop, nobody using the LAN server. Each run restarts both units first.

**It leaves data on the CT.** There is no delete API, so each run keeps a throwaway project
(`ps-214-rss-<N>-<id>` in the `pixelslash` org) with its N shots on each side in R2 and D1. The 50, 200, 200 (rerun)
and 500 runs added about 2.6 GB; the CT's root disk was 2.9 GB free after them (9.8 GB, 70 % used).
Check `pct exec 135 -- df -h /` before a run, and do not run 500 again until that is cleaned up.

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
