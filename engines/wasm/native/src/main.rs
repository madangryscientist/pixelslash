//! `diff.wasm`'s Rust built for the host (PS-212), to time it against the same code in wasm and
//! against C#. Bench only: nothing ships it, and the gate never builds it.
//!
//!   diff-native <runs> <pair.raw>...
//!
//! A `.raw` holds a pair as `bench/src/perf/native.ts` writes it: for main then branch, the
//! width, height and channels (u32 little-endian), then the inflated rows. Inflate stays out: the
//! module has none, and neither does this build. For each pair it prints one JSON line: the median
//! ms of each step over `runs` warm runs, the first run's, and what the steps found (for checking
//! against the wasm run).

#[allow(dead_code)]
#[path = "../../src/lib.rs"]
mod diff;

use std::time::Instant;

struct Shot {
    width: u32,
    height: u32,
    channels: u32,
    rows: Vec<u8>,
}

fn word(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

fn shots(bytes: &[u8]) -> [Shot; 2] {
    let mut at = 0;
    let mut next = || {
        let (width, height, channels) = (word(bytes, at), word(bytes, at + 4), word(bytes, at + 8));
        let len = ((width * channels + 1) * height) as usize;
        let rows = bytes[at + 12..at + 12 + len].to_vec();
        at += 12 + len;
        Shot { width, height, channels, rows }
    };
    [next(), next()]
}

fn alloc(len: usize) -> usize {
    let at = diff::alloc(len);
    assert!(at != 0, "arena is full");
    at
}

/// FNV-1a (32-bit) over `len` bytes at `at`, so a wasm run and this one compare without a dump.
fn fnv(at: usize, len: usize) -> u32 {
    let bytes = unsafe { std::slice::from_raw_parts(at as *const u8, len) };
    bytes.iter().fold(0x811c_9dc5, |h, &b| (h ^ b as u32).wrapping_mul(0x0100_0193))
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

const STEPS: [&str; 4] = ["copy", "decode_unfilter", "pixel_compare", "blob_boxes"];

/// One diff of the pair, as `wasmDiff` runs it: each step's ms and the result's fingerprint.
fn run(pair: &[Shot; 2], max_delta: f64, gap: f64) -> ([f64; 4], String) {
    diff::reset();
    let mut times = [0.0; 4];
    let mut rgba = [0usize; 2];
    for (i, shot) in pair.iter().enumerate() {
        rgba[i] = alloc((shot.width * shot.height * 4) as usize);
        let lines = diff::mark();
        let started = Instant::now();
        let raw = alloc(shot.rows.len());
        unsafe { std::ptr::copy_nonoverlapping(shot.rows.as_ptr(), raw as *mut u8, shot.rows.len()) };
        times[0] += ms(started);
        let started = Instant::now();
        assert_eq!(diff::unfilter(raw, shot.width, shot.height, shot.channels, rgba[i]), 0);
        times[1] += ms(started);
        diff::rewind(lines);
    }
    let [a, b] = pair;
    let (w, h) = (a.width.min(b.width), a.height.min(b.height));
    let n = (w * h) as usize;
    let overlay_len = (a.width.max(b.width) * a.height.max(b.height) * 4) as usize;
    let (overlay, field, out) = (alloc(overlay_len), alloc(n * 3), alloc(16));
    let started = Instant::now();
    diff::diff(rgba[0], a.width, a.height, rgba[1], b.width, b.height, 0, max_delta, field, overlay, out);
    times[2] = ms(started);
    let started = Instant::now();
    let count = diff::blob_boxes(field, w, h, gap, out + 8);
    times[3] = ms(started);
    let counts = unsafe { std::slice::from_raw_parts(out as *const u32, 2) };
    let boxes = unsafe { *((out + 8) as *const usize) };
    let found = format!(
        "\"changed\":{},\"antialiased\":{},\"boxes\":{},\"rgba\":[{},{}],\"field\":{},\"overlay\":{},\"box_bytes\":{}",
        counts[0],
        counts[1],
        count,
        fnv(rgba[0], (a.width * a.height * 4) as usize),
        fnv(rgba[1], (b.width * b.height * 4) as usize),
        fnv(field, n * 3),
        fnv(overlay, overlay_len),
        fnv(boxes, count as usize * 16),
    );
    (times, found)
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let runs: usize = args.first().and_then(|r| r.parse().ok()).expect("usage: diff-native <runs> <pair.raw>...");
    // The defaults: threshold 0.01 and a merge distance of 24 (`DEFAULT_THRESHOLD`, `DEFAULT_MERGE_DISTANCE`).
    let max_delta = 35215.0 * 0.01 * 0.01;
    for path in &args[1..] {
        let pair = shots(&std::fs::read(path).expect("read the pair"));
        let (first, found) = run(&pair, max_delta, 24.0);
        let mut samples: Vec<[f64; 4]> = Vec::new();
        for _ in 0..runs {
            samples.push(run(&pair, max_delta, 24.0).0);
        }
        let fmt = |times: [f64; 4]| {
            STEPS.iter().zip(times).map(|(s, t)| format!("\"{s}\":{t:.2}")).collect::<Vec<_>>().join(",")
        };
        let medians: [f64; 4] = std::array::from_fn(|i| median(samples.iter().map(|t| t[i]).collect()));
        println!("{{\"pair\":\"{path}\",\"warm\":{{{}}},\"first\":{{{}}},{found}}}", fmt(medians), fmt(first));
    }
}
