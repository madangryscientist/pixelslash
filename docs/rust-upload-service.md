# The Rust upload service — design for approval (PS-217)

Status: **proposed**, waiting on the maintainer. No build ticket is dispatched until he approves this
and answers the open questions in §9.

Decided before this doc (not reopened here):

- Straight to Rust, no TypeScript streaming stopgap.
- One Rust codebase: **native** on the self-host (a LAN CT now, Docker later), **workers-rs**
  (WASM) on Cloudflare.
- On the server everything runs as native Rust, the diff engine included. WASM is the Cloudflare
  build only (and the CLI's `diff.wasm`, which stays). So the diff core must be target-neutral.
- The Rust service never writes the DB. Rows go through a small internal endpoint on the web app,
  so `apps/web/src/db` stays the only query layer.

Inputs: `apps/web/perf/README.md` (PS-214, `b158324`) for every memory and time figure below;
the code on `main` at `b158324` for everything about today's flow.

## 0. Why: what PS-214 measured

On the LAN CT (2 vCPU, 2 GiB; `pixelslash-web` MemoryHigh 1400M, `pixelslash-diff` MemoryMax 600M):

| | 50 shots | 200 | 500 |
| --- | --- | --- | --- |
| workerd peak, during the snapshot PUTs | 330 MB | 515 MB | 640 MB |
| diff sidecar peak | ~420 MB | ~420 MB | ~420 MB |
| diff time (0.28 s/shot, one at a time) | 14 s | 59 s | 139 s |

- workerd's peak **grows with N**: `snapshotForm` reads every PUT whole (`request.formData()`),
  four at a time from the CLI, and the isolate does not give the memory back between them. After
  a burst it settles at ~850–950 MB (cause unmeasured).
- From 200 shots the web unit reaches its 1400M MemoryHigh, swaps, and `GET /` slows.
- The sidecar's ~420 MB is **one** diff's working set at 1280x9500. Two in flight would be
  ~850 MB, which does not fit its 600M MemoryMax; that is why diffs are serial today.
- All diffs wait for finalize, so finalize on a 500-shot build is ~139 s of pure diff after the
  upload is done.

The service fixes both: the PUT body is streamed (memory independent of N), and each shot is
diffed as it arrives (finalize waits only for the tail).

## 1. Crate layout

A cargo workspace at `engines/rust/` (location and the `engines/wasm` rename: Q8).

| Crate | Kind | Targets | What is in it |
| --- | --- | --- | --- |
| `pixelslash-diff` | lib | all | The diff core: PNG walk, inflate, unfilter, decode, ignore mask, pixel diff, blob boxes, box merge, noise floors, shift labels, overlay filter and encode. Takes `&[u8]`, returns `Vec`/structs. No allocator, no I/O, no `std::arch` outside `cfg`. |
| `pixelslash-diff-wasm` | cdylib | `wasm32-unknown-unknown` | Today's `extern "C"` ABI and bump allocator, now a thin shim over `pixelslash-diff`. Builds the CLI's `packages/engine/wasm/diff.wasm`. |
| `pixelslash-upload` | lib | all | The service logic, written once: routing table, streaming multipart parse, part staging and hashing, the diff job queue, the finalize wait, the internal-endpoint client. All I/O behind traits. |
| `pixelslash-upload-native` | bin | x86_64/aarch64 Linux | The LAN/Docker binary: tokio + hyper, the fs blob store, the front-door proxy, the loopback blob API, config from env. Ships its systemd unit. |
| `pixelslash-upload-worker` | cdylib | workers-rs | The Cloudflare Worker: R2 binding, service binding to the web app, a Queue consumer for diff jobs. |

### What is shared and what is per-target

Shared (in `pixelslash-diff` and `pixelslash-upload`), so both hosts run the same code:

- every byte of the diff, and every number it reports;
- the multipart parse, the size caps, the part names and their checks;
- the job identity, the dedupe, the retry and the result write;
- the finalize sequence and the reply mapping.

Per target, each behind a trait in `pixelslash-upload`:

| Trait | Native | Worker |
| --- | --- | --- |
| `BlobStore` (`put_stream`, `get`, `delete`) | fs directory, temp file + rename | R2 binding |
| `WebApp` (the internal endpoints, §5) | HTTP to loopback with the shared secret | the service binding `fetch` |
| `DiffRunner` (run one job, bounded) | `spawn_blocking` behind a `Semaphore(K)` | Queue send; the consumer runs the diff |
| `Clock` / `Sleep` | tokio | `worker::Delay` / `Date` |

The async code is `?Send` (workers-rs futures are not `Send`). Native runs it on a tokio
`current_thread` runtime inside a `LocalSet`; the CPU-bound diff goes to tokio's blocking pool,
so the I/O thread is never stalled by a diff.

### lib.rs has to change to be target-neutral

`engines/wasm/src/lib.rs` today is wasm-only: `use std::arch::wasm32::{self, *}`, a `static mut`
bump allocator over `__heap_base` with `memory_grow`, `#[target_feature(enable = "simd128")]` in
`filter`, and every function is `extern "C"` over raw `usize` pointers. The split (ticket T1):

- The algorithms move to `pixelslash-diff` as safe functions over slices.
- SIMD stays, behind `#[cfg(target_arch = "wasm32")]`; the native build gets a scalar path (and
  may later get an `x86_64` SSE/AVX path). **Every path must give identical bytes**; a `cargo
  test` runs the golden on each.
- The allocator and the pointer ABI stay in `pixelslash-diff-wasm`. The CLI's `diff.wasm` keeps
  its exports and its `diff.wasm.json` input hashes; `wasm:check` keeps proving the committed
  module is built from the committed source.

### The JS that has to be ported

`diff.wasm` is only the inner loop. Today `packages/engine/src/diff-wasm.ts` (348 lines) does the
rest in JS, and a native server needs all of it in Rust (T2):

| JS today | Lines | Port note |
| --- | --- | --- |
| `png-walk.ts` (chunk walk, CRC, IHDR) | 154 | Same error messages (they are pngjs's, and the CLI shows them). |
| inflate via `node:zlib` (pngjs's capped inflate, `Z_SYNC_FLUSH`) | in `diff-wasm.ts` | `zlib-rs` or `miniz_oxide`; the cap must refuse the same inputs. |
| deflate of the overlay via `node:zlib` | in `diff-wasm.ts` | **Q1**: a non-zlib deflate gives different bytes. |
| `ignore-mask.ts` | — | Straight port. |
| `regions.ts` (box merge) | 321 | Straight port; the golden pins the boxes. |
| `measured.ts` (noise, floors) | 102 | Straight port; floats must be computed in the same order. |
| `shift.ts` (shift labels) | 220 | Straight port. |
| `identical.ts`, `yiq.ts` | small | Straight port. |

The golden (`packages/engine/test/fixtures/pngjs-golden.json`) is the parity bar: the Rust core
reads the same fixture in `cargo test` and must match every field.

## 2. Endpoints

### What Rust owns

| Endpoint | Owner after cut-over | Why |
| --- | --- | --- |
| `PUT /api/v1/builds/:id/snapshots` | **Rust** | The body that does not fit: up to `pngs × 32 MiB`. Streamed. Includes the `diff:<baselineId>` and `flake:<run>` parts. |
| `POST /api/v1/builds/:id/finalize` | **Rust** | It must wait for the in-flight diffs, which live in Rust. |
| `POST /api/v1/builds` (open build) | web app | Small JSON, all DB. |
| `POST /api/v1/builds/:id/baselines` | web app | Small JSON, all DB. |
| `POST /api/v1/baselines` | web app | Small JSON, all DB. |
| `GET /api/v1/me`, projects, detection-flags | web app | All DB. |
| flakes list and resolve | web app | Small JSON, no diff. |
| `GET /api/v1/builds/:id`, `GET /api/v1/snapshots/:id`, `/images/*`, the UI | web app | Reads. (Rust serving the image bytes on the LAN: Q7.) |

So Rust owns exactly the two endpoints that carry pixels or wait on pixels. Opening the build and
picking baselines stay in TypeScript, where the DB is.

`ENDPOINTS` in `apps/web/src/api/handler.ts` keeps all of them, and the README's API table too:
it is the contract, not the routing table. The test that compares the two still holds. If an
owner column helps a reader, it is additive (an `owner: "upload"` field); not required.

Server diffs that are not triggered by an upload — a reviewer's re-run (ob 1738) and an override
or ignore-box edit (`override.ts` → `rediffShots`, ob 1495) — stay synchronous in the web app,
as they are today: `measure()` and `rediffShots` diff and then, in the same call, run
`settleReviews`, `refreshBuildStatus`, `recordRun` and `queueExplain`. What changes is who does
the pixels: on the LAN, Rust serves the sidecar's existing synchronous wire (`sidecar-wire.ts`)
at `POST /v1/diff` on a second, loopback-only listener at `127.0.0.1:4181`, the address and path
the sidecar has today, with no secret, as today. `DIFF_SIDECAR_URL` and `sidecar.ts` do not
change. `compare.ts` changes in one place: today `measurer` falls back to the in-process diff on
any `SidecarError` (and always on a 422 `rejected`, to get the error message). That fallback
would put a ~395 MB diff back in workerd whenever Rust is slow or down, so T6 removes it when a
sidecar URL is set: Rust's 422 carries the error message itself, and an unreachable or timed-out
diff is recorded as the shot's `diffError`, which a re-run retries. After the LAN cut-over the web
app never diffs itself and the sidecar is gone; only PUT-triggered diffs are asynchronous jobs
(§3).

On Cloudflare the synchronous calls go over the `env.UPLOAD` service binding, which `sidecar.ts`
(loopback `http:` only) cannot reach today: T9 adds a binding client beside it. Those diffs meet
the same 128 MB isolate limit as the uploads (Q5).

### Routing on the LAN

**Recommendation: Rust is the front door.** `pixelslash-upload-native` listens on `:3000` (the
port the CLI and the browser already use) and:

- handles `PUT …/snapshots` and `POST …/finalize` itself;
- refuses `/internal/*` from outside with 404 (the internal endpoints are loopback-only twice:
  stripped here, and the web app only listens on loopback);
- streams everything else to `vite preview` on `127.0.0.1:3001`, bodies and responses untouched
  (hyper client, no buffering).

Alternatives considered:

- **Two ports, the CLI told which.** Breaks every CLI already shipped (`--server` names one
  origin). Rejected.
- **The web app forwards the two routes to Rust.** Then the whole body still enters workerd
  first, which is the memory we are removing. Rejected.
- **A separate proxy (Caddy/nginx) in front of both.** Works, but a third process and config for
  a two-route split that Rust can do in ~100 lines. Kept as the fallback if the proxy code turns
  out to be a burden.

### Routing on Cloudflare

Same shape. **Recommendation: the Rust Worker owns the custom domain**; its `fetch` handles the
two routes and passes every other request to the web app through a **service binding**
(`env.WEB.fetch(request)`), which costs no extra billed request and no public hop. The web app
binds back to the Rust Worker (`env.UPLOAD`) for the synchronous diff calls (re-run, override).

The alternative — the web app owns the domain and forwards the two routes over a service binding —
reads the body into the web app's isolate before forwarding unless it streams `request.body`
straight through, which it can. It is a smaller change on Cloudflare, but it makes the LAN and
Cloudflare topologies differ. That is **Q2**.

## 3. Streaming

### A PUT, step by step

The CLI sends one multipart PUT per shot, four at a time (`CONCURRENCY = 4` in
`packages/engine/src/upload.ts`). Its part order is `diff:*`, `flake:*`, then `meta`, then `file`:
**meta is not first**, so Rust cannot know the shot's name until after the masks. The design does
not depend on part order.

1. **Authorize from the headers alone**, before reading the body:
   `POST /internal/v1/uploads/authorize` with the CLI version header, the bearer token and the
   build id. The web app runs what `handleApi` runs today — `belowMinimum` (426 `cli_outdated`),
   `authorize` (401), `actorBuild` (404, closed build) — and either returns that error, which Rust
   relays byte for byte, or returns `{ orgId, projectId, diffLocation, status, limits }`. The
   content-length cap is checked here, as `snapshotForm` does (`pngs × MAX_PNG_BYTES + 64 KiB`,
   413).
2. **Stream each part to the blob store** as it arrives, under a key that does not need meta:
   `orgs/<org>/builds/<build>/<putId>/<field>.png`, where `putId` is fresh per request. While
   streaming: check the PNG signature in the first 8 bytes, parse IHDR from the first chunk, count
   bytes against `MAX_PNG_BYTES` (413 as soon as it is passed), and sha256 the stream. `meta` is
   held in memory (it is a few KB; capped at 64 KiB).
3. **Write the row**: `POST /internal/v1/snapshots` with `meta` as the CLI sent it and a manifest
   of the staged parts `[{ field, key, bytes, sha256, width, height }]`. The web app validates
   `meta` with its existing TypeScript (`parseSnapshotInput`, `parseCiInput`, `flakeFields`), so
   every 400's text is unchanged; writes the row with `putSnapshot` minus its blob write (split
   out: T5); and replies with:
   - `reply`: the exact status and JSON body the CLI gets today, which Rust relays;
   - `jobs`: 0–2 diff jobs it can already name (the baseline diff, and against-main for a branch
     build), when the project diffs on the server and a baseline is picked;
   - `orphans`: blob keys a resend replaced, which Rust deletes.
   On a 4xx, Rust deletes the parts it staged.
4. **Enqueue the jobs** and reply to the CLI. The PUT returns as soon as the row is written; it
   does not wait for its diff.

### Diff jobs

A job is `{ jobId, buildId, snapshotId, kind: "baseline" | "main", shotKey, acceptedKey?,
branchKey, options, ignore, overlayKey }`. `shotKey` is the baseline's own shot and `acceptedKey`
the accepted image it carries from, when they differ. `jobId = sha256(snapshotId, branchKey,
shotKey, acceptedKey, kind, options)`: the same
work always has the same id, so a duplicate enqueue is a no-op and a duplicate result write is
idempotent.

The runner (native) is a FIFO with **at most K diffs in flight** (`PIXELSLASH_DIFF_SLOTS`, default
K = 2, below). Each job: get both PNGs from the blob store, diff, put the overlay at `overlayKey`
(deterministic: `diffKeyOf(imageKey)`), then `POST /internal/v1/diff-results`. The web app writes
the result with `storeDiff`, **conditional on the shot still having those keys**; if the shot was
re-sent or its baseline moved, it answers 409 and Rust drops the result. The carry fallback in
`diffOne` (shot unchanged against `baseline.shot` → carry; changed → measure against
`baseline.accepted`) runs inside the job, as it does today: the runner diffs against `shotKey`
and, only when that shows a change and `acceptedKey` is set, diffs again against it and reports
that result. No round trip for the second diff.

Both kinds of diff — these jobs and the synchronous `/v1/diff` calls — share the same K slots.
A synchronous call goes to the **front** of the queue: a reviewer's re-run sent during a 500-shot
upload must not wait behind hundreds of jobs and hit the client's 15 s timeout.

Jobs are held in memory, ~1 KB each. They are **not** durable, on purpose: `processBuild`'s
`stands(shot, baseline)` already decides at finalize which shots have a result that still holds,
so a job lost to a restart is simply re-issued by finalize. No queue table, no new state.

### Finalize

`POST /api/v1/builds/:id/finalize`:

1. Authorize as in step 1.
2. **Wait for the build's in-flight and queued jobs**, up to a wall cap W (default 20 s, under
   today's `DIFF_BUDGET_MS = 25 s`).
3. `POST /internal/v1/finalize/plan`: the web app runs today's `processBuild` front half —
   `finaliseBuild`, the atomic claim, `selectBaselines`, `withOverrides`, `stands` — and returns
   the jobs still due (the shots with no standing result, typically none, or the ones whose
   baseline could not be picked at PUT time).
4. Run those jobs (same runner, same K), within what is left of W.
5. `POST /internal/v1/finalize/commit`: the back half — `markRemoved`, accept on the default
   branch, `refreshBuildStatus`, `recordRun`, `queueExplain` — and the reply body, which Rust
   relays.
6. If W runs out first, commit replies exactly as today's `DiffCeilingError` does: `errored` with
   `unmeasured: <n>`. The shipped CLI already loops on that while `unmeasured` falls
   (`upload.ts:78`), and the runner keeps working between calls, so the next finalize finds more
   standing. **No CLI change is needed.** A clearer additive field (`measuring: true`) is **Q6**.

### Memory, at 1280x9500

**Measured today**: the sidecar idles at ~25 MB and peaks at ~420 MB on the 1280x9500 shots, so
one diff of that size costs **~395 MB**, about 32 B/px over 12.16 Mpx. Where it goes, per pixel:

| Buffer | Today (JS glue + diff.wasm) | Native core, as designed |
| --- | --- | --- |
| main and branch, inflated filtered scanlines | ~8 B | 0: unfiltered row by row into the RGBA buffer, one previous row kept |
| main and branch RGBA | 8 B | 8 B |
| overlay RGBA | 4 B | 4 B |
| overlay filtered scanlines (for deflate) | ~4 B | ~4 B (0 if the encode filters row by row, a T2 option) |
| blob-box scratch (`first n, second n, lasts w×8, stack n×4`) | ~6 B | ~6 B |
| copies across the JS/WASM boundary, wasm memory that never shrinks | the rest | 0 |
| **Total** | **~32 B/px, measured** | **~22 B/px, estimated** |

| Shot | Pixels | Today, measured | Native, estimated |
| --- | --- | --- | --- |
| 1280x9500 (the largest in the PS-214 corpus) | 12.16 M | ~395 MB | **~270 MB** |
| 1440x6000 | 8.64 M | — | ~190 MB |
| 1440x900 | 1.30 M | — | ~29 MB |

The native figure is an estimate until T2's port exists; T7 measures it. The binary itself idles
at a few MB.

A PUT in flight holds **under 1 MB** whatever the PNG size: a multipart read buffer (64 KiB), the
sha256 state, `meta` (≤ 64 KiB), the blob store's write buffer. Parts go to the store as they
arrive and are never assembled in memory.

**The burst bound** for the native service is:

```
C_put × 1 MB  +  K × 270 MB  +  jobs × 1 KB  +  ~10 MB base
```

At the CLI's C_put = 4 and K = 2: **~555 MB for any N** (500 shots queue 500 KB of jobs). Today
the same burst is workerd 330–640 MB growing with N, plus the sidecar's 420 MB.

### Choosing K

**K = 2**, if the port reaches its estimate. Reasons:

- The CT has 2 vCPU. A diff is CPU-bound (0.28 s/shot on one core); K > 2 adds memory and no
  throughput.
- 2 × 270 MB + PUT buffers ≈ 555 MB fits **MemoryHigh 600M / MemoryMax 700M** for the Rust unit,
  which is the sidecar's 600M budget plus 100M. The worst case is two 1280x9500 shots at once.
- If the native diff stays at today's ~395 MB (the estimate is wrong), two in flight is ~800 MB
  and does not fit 700M. Then the choice is K = 1, or a larger cap paid for by the web unit:
  workerd no longer holds any PNG body, so its burst peak (330–640 MB today) should fall, and its
  1400M MemoryHigh can give some back. Its post-burst 850–950 MB plateau is unexplained by PS-214,
  so that is not counted on until T7 measures it.

Time: 500 shots × 0.28 s / 2 ≈ **70 s of diff, overlapped** with the upload (the 500-shot branch
PUTs took 66 s in PS-214, stretched by MemoryHigh throttling). The hope is that finalize then
waits only for the tail, not for 139 s, but that is not a result: K = 2 takes both of the CT's
vCPUs, which workerd also needs during the PUTs, so the overlap may stretch the upload instead.
T7 measures it. The native diff may well be faster than 0.28 s; that is not assumed either. K is a setting, not a constant; T7
re-runs the PS-214 harness (`rss-burst.spec.ts`) at 50/200/500 with K = 1, 2 and records the peak
and finalize time in `apps/web/perf/README.md`. Whether to take K = 2 and the 700M cap on this
estimate, before T7 measures it, is **Q3**.

### The memory limit

K alone does not bound memory: K diffs of *any* size can be in flight, and the ~555 MB above
holds only while no shot is larger than 1280x9500. Nothing caps a shot's pixels today.
`MAX_PNG_BYTES` (`snapshot-form.ts`, 32 MiB) caps the **compressed** size, and a flat page
compresses well: a 32 MiB PNG can decode to hundreds of Mpx, at 22 B/px several GB. Today such a
shot OOM-kills the sidecar (`MemoryMax=600M`, `OOMPolicy=stop`) and the Worker re-diffs it
in-process; after T6 there is no in-process fallback, so the service has to refuse it itself. The
limit is therefore set in three layers, each one's job stated:

**1. The unit's cgroup cap: the backstop, not the plan.** `pixelslash-upload.service` (T4) carries
the sidecar unit's settings, resized:

| Setting | Value | What it does |
| --- | --- | --- |
| `MemoryHigh` | 600M | Above it the kernel reclaims and throttles the unit: slower, not killed. Counts page cache, which the fs blob store's writes add to; that part is reclaimable, so writes push the unit into reclaim before anything is at risk. |
| `MemoryMax` | 700M | The kernel OOM-kills the unit. |
| `OOMPolicy` | `stop` | One kill stops the whole unit rather than leaving it half alive. |
| `Restart` / `RestartSec` | `on-failure` / 2 s | It comes back. The failure table (§5) covers the rest: PUTs in flight get a 502 that the CLI retries, and finalize re-issues lost jobs. |

The service is designed never to reach `MemoryMax`. A kill drops every PUT and diff in flight, so
one oversized shot would cost the whole build its progress, and a killed unit gives no error that
names the shot.

**2. A byte budget per diff, admitted from the PNG header.** Before a diff starts, the runner
reads both images' `IHDR` (the first 33 bytes; `pngSize` in `validate.ts` does the same) and
computes its need: `need = max(w) × max(h) × B_px`, where `B_px` is 22 B until T7 measures it.
A diff starts only when `reserved + need ≤ PIXELSLASH_DIFF_BUDGET_MB` (default **540 MB**: 700M
less the ~10 MB base, 4 MB of PUT buffers and ~146 MB of headroom for page cache and allocator
slack). It releases its reservation when it finishes. K stays a cap on the *count*, because CPU
is the other limit (2 vCPU); the budget caps the *bytes*. So two 1280x9500 diffs (2 × 270 MB) run
together, one 1280x9500 and any number of 1440x900 fill the slots, and a 1280x19000 runs alone.
A synchronous call still goes to the front of the queue, and waits only for running diffs to free
bytes.

**3. A per-shot cap, so no shot can wait forever.** A shot whose `need` is over the whole budget
can never be admitted. It is not diffed: the runner writes its `diffError` (`too large for a
server diff: 1280x40000 = 51.2 Mpx, limit 24.5 Mpx`), as `diffOrRecord` records any per-shot
error. The build goes on, the review page shows the error on that shot, and the CLI's own diff
(`diffLocation: "ci"`) is the way to measure it. At 540 MB and 22 B/px the cap is
**~24.5 Mpx**, about 1280x19000: twice the largest shot in the PS-214 corpus. The cap follows from
the budget and `B_px` and is not a setting of its own; T7 prints it at startup. The `IHDR` check
uses the same parser as the decode, so a PNG that lies about its size fails the decode, and the
decode allocates only what the header admitted.

`Vec::try_reserve` on the big buffers is not the guard: under a cgroup the allocation succeeds and
the OOM killer acts later, at first touch. Admission is what keeps the unit under the cap.

**The CT as a whole.** The caps are per unit and do not partition the CT's 2 GiB. Today
`pixelslash-web` (`MemoryMax=1700M`) and `pixelslash-diff` (600M) already add up to 2300M; after
the LAN cut-over the web unit and the Rust unit (700M) add up to 2400M. That is safe only if
the two do not peak together. They do not today, because the sidecar peaks during finalize and
workerd peaks during the PUTs. With diffs overlapping the upload, they will. The web unit should
be the one to give: it no longer reads any PNG body, so its PS-214 PUT peak (330–640 MB) should
fall. T7 measures it, then lowers `pixelslash-web`'s caps so the two `MemoryMax` add up to
≤ 1900M, about 150 MB under the CT. That is **Q10**.

**On Cloudflare** the limit is the isolate's 128 MB. It is fixed and is not a setting. The same
admission applies, with a budget of ~100 MB per invocation (one diff per invocation, so the count
is 1). That is ~4.5 Mpx whole-image, and the band diff (T8) lifts it (Q5).

### Later: a band diff

The whole-image diff is the whole of that 270 MB. Most of the diff is local — the anti-alias
test reads a radius-2 neighbourhood, and the blob boxes are connected components, which a
row-by-row union-find builds without the whole image — so a first pass that decodes, compares and
encodes a few rows at a time would need roughly the compressed PNGs plus a few hundred rows,
~16 MB at 1280x9500 (an estimate).

One step is not local: `labelShifts` (`shift.ts`) reads both images inside each **merged**
region plus a 24 px margin, after `regions.ts` has merged boxes across the whole page, and a
merged region can be thousands of rows tall. So the band diff needs a **second decode pass** over
the rows of the regions that need a shift test, one region at a time, and its peak is set by the
tallest region, not by the band: 1280 × 2 images × 4 B is ~10 KB per row, so a 3000-row region is
another ~30 MB. Not needed for the LAN (K = 2 fits); needed for Cloudflare (below). Ticket T8.

### Cloudflare's version of the same

- A Worker isolate has **128 MB**. One whole-image diff fits only up to ~5 Mpx (~1280x4000), so a
  1280x9500 shot cannot be diffed whole in a Worker. Either the band diff (T8) lands before the
  Cloudflare cut-over, or Cloudflare refuses server diffs above a size and says so in the result.
  **Q5.** (Cloudflare's projects default to `DEFAULT_DIFF_LOCATION: "ci"`, so only projects that
  opted in to server diffs are affected.)
- An R2 `put` needs a known length, and one isolate serves several requests at once (the CLI
  sends 4 PUTs), so buffering whole parts would be up to 4 × 32 MiB in a 128 MB isolate. Instead
  each part goes up as an **R2 multipart upload**, in 5 MiB parts (R2's minimum): ≤ 5 MiB held per
  PUT, ~20 MB for the CLI's 4.
- K is the Queue consumer's `max_concurrency`; each job runs in its own invocation, so the isolate
  limit is per diff.

## 4. Blobs

### The problem on the LAN

The self-host's blobs live in miniflare's local R2 under `apps/web/.wrangler/state`: a SQLite
index plus blob files whose layout is miniflare's internal format. A native process cannot open
that bucket by its keys, and should not try: the format is not a contract and moves with
wrangler releases.

### The answer

**Rust owns the blob store on the LAN, and the web app reaches it over loopback.**

- `pixelslash-upload-native` stores blobs as plain files:
  `/var/lib/pixelslash/blobs/<key>` (keys are already `orgs/<org>/…` with SAFE_SEGMENT-checked
  segments), written to a temp file in the same directory and renamed, so a reader never sees a
  half-written PNG.
- It exposes a loopback blob API: `PUT/GET/DELETE /internal/v1/blobs/<key>`, behind the same
  shared secret (§5).
- The web app gets an `HttpBlobStore` that implements the existing `BlobStore` interface over that
  API. `orgBlobs` stays as the scoping layer above it, untouched. The web app picks
  `HttpBlobStore` when `BLOB_URL` is set, and `r2BlobStore` otherwise (Cloudflare).
- Docker later: the same fs store on a volume, or an S3 implementation of the trait if a user
  wants object storage. Not built now.
- Cloudflare: R2 on both sides, the same bucket (`pixelslash-blobs`), bound to both Workers.

### Migration of the existing LAN blobs

A one-off script, run once by the LAN ticket (T3) during a stopped window:

1. Open the bucket through Miniflare's own API (`getR2Bucket("BLOBS")` over the same persist
   directory), so it reads the format the way miniflare does.
2. List every object; write each to the fs store at its key.
3. Verify: same count, and the sha256 of every object matches.
4. Leave `.wrangler/state` in place as the backup until the next `update.sh` after a week of
   service; then the runbook says to delete it.

New uploads after the cut-over use the `<putId>/<field>.png` keys (§3). Old rows keep their old
keys; nothing rewrites them, and the store does not care about the shape. Whether the new scheme
is acceptable or keys should stay `<sha256(identity)>.png` (which needs meta before the file, so a
temp key and a rename) is **Q9**.

### Orphans

A PUT whose row write fails after its parts were stored leaves orphan blobs (and a resend leaves
the replaced ones if Rust dies before deleting them). The service sweeps its own
`builds/<build>/<putId>/` prefixes: at finalize, any `putId` the commit does not reference is
deleted. Folded into T7; no separate janitor.

## 5. The internal row endpoint

### The contract

All under `/internal/v1/`, JSON in and out, served by the web app (`apps/web/src/internal/*`, a
new route file; every query still through `src/db/*`):

| Call | Body | Reply |
| --- | --- | --- |
| `POST uploads/authorize` | `{ buildId, token, cliVersion, contentLength }` | `{ ok: true, orgId, projectId, diffLocation, status, limits }`, or `{ ok: false, status, body }` to relay |
| `POST snapshots` | `{ buildId, putId, meta, parts: [{ field, key, bytes, sha256, width, height }] }` | `{ reply: { status, body }, jobs: Job[], orphans: string[] }` |
| `POST diff-results` | `{ jobId, snapshotId, kind, againstKey, branchKey, result, overlayKey, ms }` | 200, 409 stale, 404 gone |
| `POST finalize/plan` | `{ buildId, actor }` | `{ claim, jobs: Job[] }` or `{ reply }` (already finalised, refused) |
| `POST finalize/commit` | `{ buildId, claim, unmeasured }` | `{ reply: { status, body } }` |
| `POST /v1/diff` on `127.0.0.1:4181` (web app → Rust; LAN) | the sidecar wire (`sidecar-wire.ts`), unchanged | the sidecar's reply — synchronous, for finalize before T7, re-run and override. Loopback-only and unauthenticated, as the sidecar is today; not under `/internal` and not behind the secret |

The Rust service owns no row and keeps no state across restarts; the web app owns every write.

### Auth between the two

A shared secret, `PIXELSLASH_INTERNAL_SECRET`, sent as `X-PixelSlash-Internal` and compared in
constant time (`subtle` in Rust, `crypto.subtle.timingSafeEqual` in workerd). On the LAN it lives
in the systemd units' `EnvironmentFile` (root-only), on Cloudflare as a Worker secret on both
Workers. Defence in depth, because the secret is not the only wall:

- LAN: the web app and the blob API listen on loopback only; the front door 404s `/internal/*`.
- Cloudflare: the internal calls go over service bindings, which are not reachable from the
  internet; the web app's internal routes also refuse a request that did not come in over the
  binding (no secret, 404), and `workers_dev` stays off for both Workers.

No mTLS and no signing: both hops are loopback or in-account, and the secret is per host.

### Failure handling

| Failure | What happens |
| --- | --- |
| The web app is down during a PUT | 502 to the CLI, staged parts deleted. The CLI retries it (`upload-client.ts`: 6 tries, 1, 2, 4, 8 then 15 s, on 502/503/504), and a resend replaces the row; after the sixth it fails the upload, as today. |
| Row write fails after the parts are stored | Parts deleted; the CLI gets the web app's error, or 502. |
| Diff done, result write fails (5xx, timeout) | Retried with backoff (3 tries, ~1 s, 4 s, 16 s). If it still fails the result is dropped and logged. Nothing is lost: the overlay key is deterministic, so the next run overwrites it, and finalize's plan sees no standing result and re-issues the job. |
| Diff done, result is stale (409) | Dropped. The newer upload has its own job. |
| A diff hits a malformed PNG | The core returns `Result` for every bad input; the job writes the shot's `diffError`, as `diffOrRecord` (`process.ts`) does today. A panic is a bug: native wraps the diff in `catch_unwind` as a backstop; on `wasm32` a panic aborts the invocation, and finalize re-issues the job. |
| The Rust service restarts mid-build | In-memory jobs are lost; finalize's plan re-issues every shot without a standing result. |
| Finalize times out with jobs left | `errored` + `unmeasured`, as today; the CLI calls finalize again while `unmeasured` falls; the runner keeps going between calls, so each call finds fewer left. |

## 6. Contract and cut-over

### Keeping the TS and Rust paths identical

- **An `/api/v1` contract suite** in `apps/web/e2e/`, parameterised by base URL, drives the CLI's
  upload against a fresh build and asserts the exact status and JSON body of every reply, then
  reads the stored result back through `GET /api/v1/builds/:id` and `GET /api/v1/snapshots/:id`.
  It runs twice in `test:e2e`: once against the web app alone (the TS path), once through the Rust
  front door. Any difference fails the gate. The existing `upload.spec.ts`, `flakes.spec.ts` and
  `rerun.spec.ts` cases are the starting set; the error cases (`cli_outdated`, 401, 413, bad meta,
  closed build) are added.
- **The diff core** runs `pngjs-golden.json` in `cargo test`, every SIMD path included.
- **The bench**: `bench:check` gains a leg that runs the Rust core through the bench's diff
  contract, as `engines/dotnet` does, so a score regression in the port fails the gate.
- **Rust in the gate**: `rust` pinned in `.tool-versions` (1.99.1, as `engines/wasm` already pins
  in `rust-toolchain.toml`), an Nx project per crate group using `nx:run-commands` (`cargo test`,
  `cargo clippy -D warnings`, `cargo fmt --check`, `cargo deny check licenses`), the way
  `engines/dotnet` joined. It makes the gate need cargo on every machine that runs it. **Q4**.

`/api/v1` does not change (invariant 7): the CLI sends the same bytes and reads the same replies.
The only new routes are `/internal/v1/*`, which are not part of the public contract.

### Order

LAN first, Cloudflare second; each step lands on its own and leaves the system working.

1. **T1** split `lib.rs` into the core and the wasm shim; Rust enters the gate. `diff.wasm`
   unchanged byte for byte.
2. **T2** port the JS glue to the core; golden and bench parity.
3. **T3** the fs blob store, its loopback API, `HttpBlobStore`, and the migration of the LAN blobs.
   The web app now reads and writes blobs through Rust; nothing else changes.
4. **T4** the native service as a pure pass-through front door on `:3000`, vite preview moved to
   `127.0.0.1:3001`; systemd unit; the binary is built on the desktop by `release.sh` and ships in the release
   (PS-225: the CT never builds).
5. **T5** the internal endpoints in the web app, `putSnapshot` split from its blob write; unused
   until T7.
6. **T6** Rust serves the sidecar's synchronous wire at `127.0.0.1:4181/v1/diff`, with the
   native core and K slots; `DIFF_SIDECAR_URL` is unchanged; `compare.ts` loses its in-process
   fallback when a sidecar URL is set.
   **`pixelslash-diff.service` and `apps/web/deploy/ssh/diff-sidecar.ts` are retired here.**
7. **T7** streaming PUT and finalize on the LAN, behind `PIXELSLASH_UPLOAD_RUST=1` (unset → the
   front door passes the two routes through to the TS path, so a rollback is a restart). The
   contract suite. The PS-214 re-run at K = 1, 2, recorded.
8. **T8** the band diff.
9. **T9** the workers-rs target: R2, the service binding, the Queue; deployed to a staging Worker
   and run against the contract suite.
10. **T10** the Cloudflare route flip, and after a soak the removal of the TS upload handlers
    (`snapshotForm`, the in-Worker diff path).

The sidecar is retired by the LAN cut-over (T6), not by Cloudflare.

### Invariants

- **4 (local unless told to upload)**: unchanged. The Rust service only receives what the CLI
  uploads to the server it is configured for, and sends pixels only to its own blob store. It
  never calls a model endpoint: `queueExplain` and the region crops stay in the web app.
- **7 (`/api/v1` stable)**: unchanged; the contract suite enforces it.
- Rust never touches D1, on either host.

## 7. Crates

Permissive only. Every licence is to be re-checked when the version is pinned, and `cargo deny
check licenses` in the gate (allow-list: MIT, Apache-2.0, BSD-2/3-Clause, ISC, Zlib, Unicode-3.0)
keeps a copyleft crate from arriving through a dependency.

| Crate | Licence | Used for | Where |
| --- | --- | --- | --- |
| `tokio` | MIT | runtime, blocking pool, semaphore | native |
| `hyper`, `hyper-util`, `http`, `http-body-util` | MIT | server, proxy client | native |
| `bytes` | MIT | buffers | shared |
| `multer` | MIT | streaming multipart parse | shared |
| `encoding_rs` (via multer) | (Apache-2.0 OR MIT) AND BSD-3-Clause | charset in multer | shared |
| `futures` | MIT OR Apache-2.0 | stream combinators | shared |
| `serde`, `serde_json` | MIT OR Apache-2.0 | the internal JSON | shared |
| `sha2` | MIT OR Apache-2.0 | part hashes, job ids | shared |
| `subtle` | BSD-3-Clause | constant-time secret compare | shared |
| `zlib-rs` | Zlib | inflate and deflate (`miniz_oxide`, MIT OR Zlib OR Apache-2.0, only if Q1 falls back) | core |
| `thiserror` | MIT OR Apache-2.0 | error types | shared |
| `tracing`, `tracing-subscriber` | MIT | logs | shared |
| `worker` (workers-rs) | Apache-2.0 | the Worker runtime | worker |
| `wasm-bindgen` | MIT OR Apache-2.0 | the Worker's JS glue | worker |
| `cargo-deny` (tool) | MIT OR Apache-2.0 | the licence gate | dev |

No TLS crate: both internal hops are plain loopback or a service binding, and TLS on the LAN is
whatever is in front of `:3000` today. The core (`pixelslash-diff`) depends on one inflate crate
and nothing else, so `diff.wasm` stays small.

Nothing is taken from an open-source rival (Argos or others). The service is written from this
repo's own code and its own measurements.

## 8. Tickets

| # | Size | Ticket | Depends on |
| --- | --- | --- | --- |
| T1 | M | Split `lib.rs` into `pixelslash-diff` (target-neutral, scalar + SIMD paths with identical bytes) and `pixelslash-diff-wasm`; cargo workspace; Rust in the gate (`.tool-versions`, Nx run-commands, clippy, fmt, cargo-deny). `diff.wasm` unchanged. | — |
| T2 | L | Port `png-walk`, inflate, deflate (per Q1), `ignore-mask`, `regions`, `measured`, `shift`, `identical`, `yiq` to the core; `pngjs-golden.json` in `cargo test`; a bench leg for the Rust core. | T1 |
| T3 | M | fs blob store and its loopback API in a minimal native bin; `HttpBlobStore` in the web app; the miniflare → fs migration script and runbook; the LAN switched over. | T1 |
| T4 | L | `pixelslash-upload-native` as the front door: hyper pass-through to vite preview on loopback, `/internal` stripping, config, the systemd unit, the binary in `release.sh`'s release (built on the desktop, PS-225), the internal secret. | T3 |
| T5 | M | The internal endpoints in the web app (`/internal/v1/*`), the secret check, `putSnapshot` split from its blob write, `processBuild` split into plan and commit; TS tests for each. | — |
| T6 | M | Rust serves the sidecar wire at `127.0.0.1:4181/v1/diff` with the native core behind K slots (synchronous calls first); `compare.ts`'s in-process fallback removed when a sidecar URL is set; the Bun sidecar and its unit removed. Every server diff (finalize, re-run, override, against-main) now runs in Rust, still called synchronously. | T2, T4 |
| T7 | L | The async job runner (dedupe, retries, the in-job carry fallback); streaming PUT and finalize in `pixelslash-upload`, behind `PIXELSLASH_UPLOAD_RUST`; admission by byte budget and the per-shot pixel cap (§3, "The memory limit"); the orphan sweep; the `/api/v1` contract suite run against both paths; the PS-214 re-run at K = 1, 2 written into `apps/web/perf/README.md`. | T5, T6 |
| T8 | M | The band diff in the core: row-streamed decode, radius-2 window, row-by-row union-find for blob boxes, streamed overlay encode, and the second pass over merged regions for shift labels; golden parity; a `bench:perf` entry in `bench/PERF.md`. | T2 |
| T9 | L | `pixelslash-upload-worker`: R2 store, service bindings both ways, the Queue consumer, wrangler config; a binding client beside `sidecar.ts` so re-run and override diff over `env.UPLOAD`; a staging Worker passing the contract suite. | T7, T8 (or the Q5 cap) |
| T10 | S | Cloudflare route flip; after a soak, remove `snapshotForm`'s whole-body path and the in-Worker diff. | T9 |

Filed on its own, outside this list: **PS-220** (S/M), serve the LAN's built Worker with a small
Miniflare host instead of `vite preview`. vite preview holds ~560 MB idle (PS-214) only to start
Miniflare; it depends on nothing here and can land before T4, which forwards to whatever listens
on `127.0.0.1:3001`. Its measured saving is what Q10 lowers the web unit's caps by.

Rough total: three L and five M on the LAN path (T1–T8), then T9 (L) and T10 (S) for Cloudflare.
T3 and T5 can run beside T1/T2.

Each ticket's brief carries its own `## Do not`; common to all: no change to `/api/v1`'s shape,
no D1 access from Rust, no copyleft crate, and the capability matrix updated by the ticket whose
landing changes a row (T7 for "streaming upload", T9 for the hosted path).

## 9. Open questions for the maintainer

Each has a recommendation; the build tickets assume it unless he says otherwise.

| # | Question | Recommendation |
| --- | --- | --- |
| **Q1** | The golden pins the overlay PNG's **sha256**, which pins zlib's exact deflate bytes. A pure-Rust deflate (`miniz_oxide`) gives different, equally valid bytes. Keep byte-identical overlays (use `zlib-rs`, which aims at zlib's output — to be proven in T2), or relax the golden to the **decoded** overlay pixels plus the result fields? | Try `zlib-rs` for byte parity in T2; if it does not match, relax the golden to decoded pixels. Overlay bytes are not part of any contract a user sees. |
| **Q2** | The front door: Rust owns `:3000` / the custom domain and forwards the rest (recommended, same shape on both hosts), or the web app owns them and forwards the two routes (smaller change on Cloudflare, different shape per host)? | Rust is the front door on both. |
| **Q3** | K = 2 and the Rust unit at MemoryHigh 600M / MemoryMax 700M, from PS-214's ~395 MB per diff today and the ~270 MB the native core is estimated at, before T7 measures it? If the estimate does not hold, K = 1 or a larger cap taken from the web unit's 1400M? | Yes to K = 2 / 700M. If T7 measures more than ~300 MB a diff, the byte budget ("The memory limit") already admits one 1280x9500 at a time, so nothing breaks; set `B_px` from the measurement. K stays a setting. |
| **Q4** | Rust in the gate: every machine that runs `bun run test` then needs cargo (as it needs .NET today). Accept, or keep cargo behind an opt-out like `NX_DOTNET_DISABLE`? | Accept, with the same kind of opt-out env var for a machine without it. |
| **Q5** | Cloudflare's 128 MB isolate cannot diff a 1280x9500 shot whole. Block the Cloudflare cut-over on the band diff (T8), or ship T9 with a size cap (refuse server diffs above ~5 Mpx with a clear result) and add T8 later? | Block on T8: the LAN does not need it, so it costs no LAN time, and a size cap is a visible gap. |
| **Q6** | While diffs are still running, finalize replies `errored` + `unmeasured` (today's shape, no CLI change). Add an additive `measuring: true` so the CLI can print "still measuring" instead of a retry that looks like an error? | Yes, additive, in T7; the CLI change is a follow-up and old CLIs keep working. |
| **Q7** | On the LAN, should Rust also serve the signed image GETs (`/images/*`) straight from the fs store, so image bytes stop passing through workerd? | Not now. Measure workerd's read path after T7; open a ticket if it shows. |
| **Q8** | Crate location: a new `engines/rust/` workspace with `engines/wasm` folded into it (`pixelslash-diff` + `pixelslash-diff-wasm`), or keep `engines/wasm` and add `engines/upload`? | `engines/rust/`, one workspace, one lockfile, one `cargo deny`. |
| **Q9** | New upload blob keys become `builds/<build>/<putId>/<field>.png` (no meta needed to name a part). Old rows keep old keys. Accept, or keep `<sha256(identity)>.png` with a temp key and a rename at row-write time? | Accept the new scheme. A rename is a copy on R2, and nothing reads the key's shape. |
| **Q10** | The CT's caps add up to more than its 2 GiB (web 1700M + Rust 700M). Lower `pixelslash-web`'s `MemoryHigh` / `MemoryMax` after T7 measures its new PUT peak, so the two `MemoryMax` add up to ≤ 1900M? Or give the CT more memory (Proxmox is already overcommitted)? Also: the per-shot cap of ~24.5 Mpx (about 1280x19000) refuses a server diff with a named `diffError`. Is that the behaviour you want, or should larger shots wait for the band diff (T8)? | Lower the web unit's caps in T7, from its measured peak, after PS-220 removes vite preview's ~560 MB. Take the 24.5 Mpx cap with a named error; T8 raises it later. |
