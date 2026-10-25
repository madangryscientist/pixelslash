//! The server diff's hot loops for workerd (PS-204), written from the engine's TypeScript
//! (`packages/engine/src/diff.ts`, `regions.ts`) and pngjs's unfilter, which it must match byte
//! for byte, and pngjs's adaptive filter for the overlay's encode (PS-205). JS keeps everything
//! else: chunk parsing, inflate and deflate (workerd's zlib), the ignore mask, merging boxes, the
//! noise call, shift labels, the floors and the encode's PNG chunks.
//!
//! The module owns one linear memory and a bump allocator over it: `reset` at the start of a diff,
//! `alloc` for each buffer, `mark`/`rewind` for scratch. Nothing is freed one by one; the memory
//! stays at the largest diff's size for the life of the instance.
//!
//! It uses std only for `f64::sqrt` and `f64::floor` (core has no stable float math), which lower
//! to the wasm instructions; nothing allocates through std, and a panic aborts (a trap in JS).

use std::arch::wasm32::{self, *};
use std::slice;

unsafe extern "C" {
    static __heap_base: u8;
}

static mut TOP: usize = 0;

const PAGE: usize = 65536;

fn heap_base() -> usize {
    &raw const __heap_base as usize
}

/// Forget every allocation: the next `alloc` starts at the bottom of the heap again.
#[unsafe(no_mangle)]
pub extern "C" fn reset() {
    unsafe { TOP = heap_base() }
}

#[unsafe(no_mangle)]
pub extern "C" fn mark() -> usize {
    unsafe { TOP }
}

/// Free everything allocated since `mark` returned `to`.
#[unsafe(no_mangle)]
pub extern "C" fn rewind(to: usize) {
    unsafe { TOP = to }
}

/// `len` bytes, 8-aligned, growing the memory when it must; 0 when it cannot grow.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> usize {
    let start = (unsafe { TOP }.max(heap_base()) + 7) & !7;
    let Some(end) = start.checked_add(len) else {
        return 0;
    };
    let have = wasm32::memory_size(0) * PAGE;
    if end > have {
        let pages = (end - have).div_ceil(PAGE);
        if wasm32::memory_grow(0, pages) == usize::MAX {
            return 0;
        }
    }
    unsafe { TOP = end }
    start
}

fn bytes<'a>(ptr: usize, len: usize) -> &'a [u8] {
    unsafe { slice::from_raw_parts(ptr as *const u8, len) }
}

fn bytes_mut<'a>(ptr: usize, len: usize) -> &'a mut [u8] {
    unsafe { slice::from_raw_parts_mut(ptr as *mut u8, len) }
}

const CRC_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
};

/// The PNG chunk CRC (ISO 3309) of `len` bytes at `ptr`.
#[unsafe(no_mangle)]
pub extern "C" fn crc32(ptr: usize, len: usize) -> u32 {
    let mut c = !0u32;
    for &b in bytes(ptr, len) {
        c = CRC_TABLE[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    !c
}

/// pngjs's Paeth predictor: left, then above, then upper-left on ties.
#[inline(always)]
fn paeth(left: u8, above: u8, up_left: u8) -> u8 {
    let p = left as i32 + above as i32 - up_left as i32;
    let p_left = (p - left as i32).abs();
    let p_above = (p - above as i32).abs();
    let p_up_left = (p - up_left as i32).abs();
    if p_left <= p_above && p_left <= p_up_left {
        left
    } else if p_above <= p_up_left {
        above
    } else {
        up_left
    }
}

/// Unfilter an 8-bit, non-interlaced PNG's inflated rows in place at `src` (`channels` 3 or 4,
/// `(width * channels + 1) * height` bytes), then write them to `dst` as RGBA (RGB gets alpha
/// 255, as pngjs's bitmapper does). 0 on success, 1 on a filter type pngjs refuses.
#[unsafe(no_mangle)]
pub extern "C" fn unfilter(src: usize, width: u32, height: u32, channels: u32, dst: usize) -> u32 {
    let (w, h, bpp) = (width as usize, height as usize, channels as usize);
    let row = w * bpp;
    let stride = row + 1;
    let data = bytes_mut(src, stride * h);
    for y in 0..h {
        let (before, rest) = data.split_at_mut(y * stride);
        let filter = rest[0];
        let line = &mut rest[1..stride];
        let up: &[u8] = if y == 0 { &[] } else { &before[(y - 1) * stride + 1..y * stride] };
        match filter {
            0 => {}
            1 => {
                for x in bpp..row {
                    line[x] = line[x].wrapping_add(line[x - bpp]);
                }
            }
            2 => {
                if y > 0 {
                    for x in 0..row {
                        line[x] = line[x].wrapping_add(up[x]);
                    }
                }
            }
            3 => {
                for x in 0..row {
                    let left = if x >= bpp { line[x - bpp] as u32 } else { 0 };
                    let above = if y > 0 { up[x] as u32 } else { 0 };
                    line[x] = line[x].wrapping_add(((left + above) >> 1) as u8);
                }
            }
            4 => {
                for x in 0..row {
                    let left = if x >= bpp { line[x - bpp] } else { 0 };
                    let (above, up_left) = if y > 0 {
                        (up[x], if x >= bpp { up[x - bpp] } else { 0 })
                    } else {
                        (0, 0)
                    };
                    line[x] = line[x].wrapping_add(paeth(left, above, up_left));
                }
            }
            _ => return 1,
        }
    }
    let out = bytes_mut(dst, w * h * 4);
    for y in 0..h {
        let line = &data[y * stride + 1..(y + 1) * stride];
        let to = &mut out[y * w * 4..(y + 1) * w * 4];
        if bpp == 4 {
            to.copy_from_slice(line);
        } else {
            for x in 0..w {
                to[x * 4] = line[x * 3];
                to[x * 4 + 1] = line[x * 3 + 1];
                to[x * 4 + 2] = line[x * 3 + 2];
                to[x * 4 + 3] = 255;
            }
        }
    }
    0
}

/// Bytes per pixel of the RGBA overlay: the left neighbour is 4 bytes back.
const BPP: usize = 4;

/// The predictor of `filter` (1 Sub, 2 Up, 3 Average, 4 Paeth; 0 None) for one byte.
#[inline(always)]
fn predict(filter: usize, left: i32, above: i32, up_left: i32) -> i32 {
    match filter {
        0 => 0,
        1 => left,
        2 => above,
        3 => (left + above) >> 1,
        _ => paeth(left as u8, above as u8, up_left as u8) as i32,
    }
}

/// The byte at `x` and its left, above and upper-left neighbours (0 off the row's left edge).
#[inline(always)]
fn neighbours(line: &[u8], up: &[u8], x: usize) -> (i32, i32, i32, i32) {
    let (left, up_left) = if x >= BPP { (line[x - BPP] as i32, up[x - BPP] as i32) } else { (0, 0) };
    (line[x] as i32, left, up[x] as i32, up_left)
}

/// Eight bytes at `at`, widened to i16 lanes: `high` picks the upper half of the 16.
#[inline]
#[target_feature(enable = "simd128")]
fn widen(v: v128, high: bool) -> v128 {
    if high { u16x8_extend_high_u8x16(v) } else { u16x8_extend_low_u8x16(v) }
}

/// `paeth` on eight i16 lanes, with p − left, p − above and p − upper-left written as
/// above − upper-left, left − upper-left and left + above − 2 × upper-left.
#[inline]
#[target_feature(enable = "simd128")]
fn paeth_v(left: v128, above: v128, up_left: v128) -> v128 {
    let p_left = i16x8_abs(i16x8_sub(above, up_left));
    let p_above = i16x8_abs(i16x8_sub(left, up_left));
    let p_up_left = i16x8_abs(i16x8_sub(i16x8_add(left, above), i16x8_add(up_left, up_left)));
    let pick_left = v128_and(i16x8_le(p_left, p_above), i16x8_le(p_left, p_up_left));
    let above_or_up_left = v128_bitselect(above, up_left, i16x8_le(p_above, p_up_left));
    v128_bitselect(left, above_or_up_left, pick_left)
}

/// 16 bytes from `at` (unaligned); the caller keeps `at + 16` inside the slice it came from.
#[inline]
#[target_feature(enable = "simd128")]
fn load(bytes: &[u8], at: usize) -> v128 {
    debug_assert!(at + 16 <= bytes.len());
    unsafe { v128_load(bytes.as_ptr().add(at) as *const v128) }
}

/// The five filters' sums over one row: for each byte, |byte − predictor| unwrapped, as pngjs
/// adds them. `up` is the row above, all zeros for the first. 16 bytes at a time in i16 lanes;
/// the first pixel (no left neighbour) and the tail are added one byte at a time.
#[target_feature(enable = "simd128")]
fn filter_sums(line: &[u8], up: &[u8]) -> [u64; 5] {
    let mut sums = [0u64; 5];
    let add = |sums: &mut [u64; 5], x: usize| {
        let (cur, left, above, up_left) = neighbours(line, up, x);
        for (f, sum) in sums.iter_mut().enumerate() {
            *sum += (cur - predict(f, left, above, up_left)).unsigned_abs() as u64;
        }
    };
    let row = line.len();
    let head = BPP.min(row);
    (0..head).for_each(|x| add(&mut sums, x));
    let mut x = head;
    // Each step adds at most 4 × 255 to a u32 lane, so lanes are flushed to `sums` well before
    // they could wrap.
    const FLUSH: usize = 1 << 20;
    while x + 16 <= row {
        let mut acc = [u32x4_splat(0); 5];
        let mut steps = 0;
        while x + 16 <= row && steps < FLUSH {
            let (cur, left) = (load(line, x), load(line, x - BPP));
            let (above, up_left) = (load(up, x), load(up, x - BPP));
            for high in [false, true] {
                let (c, l) = (widen(cur, high), widen(left, high));
                let (a, ul) = (widen(above, high), widen(up_left, high));
                let avg = i16x8_shr(i16x8_add(l, a), 1);
                let preds = [i16x8_splat(0), l, a, avg, paeth_v(l, a, ul)];
                for (lane, pred) in acc.iter_mut().zip(preds) {
                    let diff = i16x8_abs(i16x8_sub(c, pred));
                    *lane = i32x4_add(*lane, i32x4_extadd_pairwise_i16x8(diff));
                }
            }
            x += 16;
            steps += 1;
        }
        for (sum, lane) in sums.iter_mut().zip(acc) {
            let total = u32x4_extract_lane::<0>(lane) as u64
                + u32x4_extract_lane::<1>(lane) as u64
                + u32x4_extract_lane::<2>(lane) as u64
                + u32x4_extract_lane::<3>(lane) as u64;
            *sum += total;
        }
    }
    (x..row).for_each(|x| add(&mut sums, x));
    sums
}

/// One row filtered with `filter` into `to`, each byte wrapped to u8 as pngjs's Buffer stores it.
#[target_feature(enable = "simd128")]
fn filter_row(filter: usize, line: &[u8], up: &[u8], to: &mut [u8]) {
    let row = line.len();
    let one = |x: usize, to: &mut [u8]| {
        let (cur, left, above, up_left) = neighbours(line, up, x);
        to[x] = (cur - predict(filter, left, above, up_left)) as u8;
    };
    if filter == 0 {
        to.copy_from_slice(line);
        return;
    }
    let head = BPP.min(row);
    (0..head).for_each(|x| one(x, to));
    let mut x = head;
    while x + 16 <= row {
        let (cur, left) = (load(line, x), load(line, x - BPP));
        let (above, up_left) = (load(up, x), load(up, x - BPP));
        let pred = |high: bool| {
            let (l, a, ul) = (widen(left, high), widen(above, high), widen(up_left, high));
            match filter {
                1 => l,
                2 => a,
                3 => i16x8_shr(i16x8_add(l, a), 1),
                _ => paeth_v(l, a, ul),
            }
        };
        let pred = u8x16_narrow_i16x8(pred(false), pred(true));
        unsafe { v128_store(to.as_mut_ptr().add(x) as *mut v128, u8x16_sub(cur, pred)) };
        x += 16;
    }
    (x..row).for_each(|x| one(x, to));
}

/// pngjs's adaptive filter for an 8-bit RGBA image (`PNG.sync.write`'s default, PS-205): for each
/// row, the sum of the absolute differences between each byte and its predictor, unwrapped, under
/// None, Sub, Up, Average and Paeth, and the first filter with the smallest sum wins. Writes the
/// filtered rows (`(width * 4 + 1) * height` bytes, each led by its filter type) to `dst`. 0 on
/// success, 1 when memory for the zero row above the first ran out.
#[unsafe(no_mangle)]
pub extern "C" fn filter(src: usize, width: u32, height: u32, dst: usize) -> u32 {
    let (w, h) = (width as usize, height as usize);
    let row = w * 4;
    let scratch = mark();
    let zeros = alloc(row);
    if zeros == 0 {
        return 1;
    }
    let zeros = bytes_mut(zeros, row);
    zeros.fill(0);
    let data = bytes(src, row * h);
    let out = bytes_mut(dst, (row + 1) * h);
    for y in 0..h {
        let line = &data[y * row..(y + 1) * row];
        let up: &[u8] = if y == 0 { zeros } else { &data[(y - 1) * row..y * row] };
        // wasm SIMD: workerd's V8 and Bun both run it, and a runtime without it refuses the module.
        let sums = filter_sums(line, up);
        let mut best = 0;
        for f in 1..5 {
            if sums[f] < sums[best] {
                best = f;
            }
        }
        let (kind, to) = out[y * (row + 1)..(y + 1) * (row + 1)].split_first_mut().unwrap();
        *kind = best as u8;
        filter_row(best, line, up, to);
    }
    rewind(scratch);
    0
}

/// Largest YIQ delta (squared, weighted) between black and white; `MAX_YIQ_DELTA` in diff.ts.
const MAX_YIQ_DELTA: f64 = 35215.0;
const PIXEL_CHANGED: u8 = 1;
const PIXEL_ANTIALIASED: u8 = 2;

struct Img<'a> {
    d: &'a [u8],
    w: usize,
    h: usize,
}

/// The pixel at `i` blended over white when it is not opaque, as `lumaIq` does.
#[inline(always)]
fn blended(d: &[u8], i: usize) -> (f64, f64, f64) {
    let mut r = d[i] as f64;
    let mut g = d[i + 1] as f64;
    let mut b = d[i + 2] as f64;
    let a = d[i + 3] as f64 / 255.0;
    if a < 1.0 {
        r = 255.0 + (r - 255.0) * a;
        g = 255.0 + (g - 255.0) * a;
        b = 255.0 + (b - 255.0) * a;
    }
    (r, g, b)
}

#[inline(always)]
fn luma(d: &[u8], i: usize) -> f64 {
    let (r, g, b) = blended(d, i);
    r * 0.29889531 + g * 0.58662247 + b * 0.11448223
}

#[inline(always)]
fn luma_iq(d: &[u8], i: usize) -> (f64, f64, f64) {
    let (r, g, b) = blended(d, i);
    (
        r * 0.29889531 + g * 0.58662247 + b * 0.11448223,
        r * 0.59597799 - g * 0.2741761 - b * 0.32180189,
        r * 0.21147017 - g * 0.52261711 + b * 0.31114694,
    )
}

/// `colourDelta`: signed perceptual distance, negative when `b` is the lighter one.
#[inline(always)]
fn colour_delta(a: &[u8], ia: usize, b: &[u8], ib: usize) -> f64 {
    if a[ia..ia + 4] == b[ib..ib + 4] {
        return 0.0;
    }
    let (ya, iq_a, qa) = luma_iq(a, ia);
    let (yb, iq_b, qb) = luma_iq(b, ib);
    let dy = ya - yb;
    let di = iq_a - iq_b;
    let dq = qa - qb;
    let delta = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
    if dy > 0.0 { -delta } else { delta }
}

/// The in-bounds 3x3 window around (x, y): `(y0, y1, x0, x1)`, inclusive.
#[inline(always)]
fn window(img: &Img, x: usize, y: usize) -> (usize, usize, usize, usize) {
    (y.saturating_sub(1), (y + 1).min(img.h - 1), x.saturating_sub(1), (x + 1).min(img.w - 1))
}

/// `hasManySiblings`: more than two of the 8 neighbours have the pixel's exact RGBA.
fn has_many_siblings(img: &Img, x: usize, y: usize) -> bool {
    let at = (y * img.w + x) * 4;
    let centre = &img.d[at..at + 4];
    let (y0, y1, x0, x1) = window(img, x, y);
    let mut same = 0;
    for ny in y0..=y1 {
        for nx in x0..=x1 {
            if nx == x && ny == y {
                continue;
            }
            let i = (ny * img.w + nx) * 4;
            if &img.d[i..i + 4] == centre {
                same += 1;
                if same > 2 {
                    return true;
                }
            }
        }
    }
    false
}

/// `isAntialiased`: (x, y) is an anti-aliased edge pixel of `img`.
fn is_antialiased(img: &Img, x: usize, y: usize, other: &Img) -> bool {
    let centre = luma(img.d, (y * img.w + x) * 4);
    let mut equal = 0;
    let (mut min, mut min_x, mut min_y) = (0.0f64, 0, 0);
    let (mut max, mut max_x, mut max_y) = (0.0f64, 0, 0);
    let (y0, y1, x0, x1) = window(img, x, y);
    for ny in y0..=y1 {
        for nx in x0..=x1 {
            if nx == x && ny == y {
                continue;
            }
            let delta = centre - luma(img.d, (ny * img.w + nx) * 4);
            if delta == 0.0 {
                equal += 1;
                if equal > 2 {
                    return false;
                }
            } else if delta < min {
                (min, min_x, min_y) = (delta, nx, ny);
            } else if delta > max {
                (max, max_x, max_y) = (delta, nx, ny);
            }
        }
    }
    if min == 0.0 || max == 0.0 {
        return false;
    }
    let flat_both = |ex, ey| has_many_siblings(img, ex, ey) && has_many_siblings(other, ex, ey);
    flat_both(min_x, min_y) || flat_both(max_x, max_y)
}

/// `Math.round` for the non-negative values the amplitude takes: halves round up.
#[inline(always)]
fn js_round(v: f64) -> f64 {
    let r = v.floor();
    if v - r >= 0.5 { r + 1.0 } else { r }
}

/// The pixel loop of `diffOverlap`. `a` and `b` are RGBA; the overlap is their smaller width and
/// height. `skip` (overlap-sized, or 0 for none) marks ignored pixels. Writes the field
/// (`kind`, `amplitude`, `lighter`, overlap-sized, zeroed here) and paints the changed pixels
/// magenta on `overlay` (the larger size, zeroed here). `out` gets [changed, antialiased].
#[unsafe(no_mangle)]
pub extern "C" fn diff(
    a: usize,
    aw: u32,
    ah: u32,
    b: usize,
    bw: u32,
    bh: u32,
    skip: usize,
    max_delta: f64,
    field: usize,
    overlay: usize,
    out: usize,
) {
    let a = Img { d: bytes(a, aw as usize * ah as usize * 4), w: aw as usize, h: ah as usize };
    let b = Img { d: bytes(b, bw as usize * bh as usize * 4), w: bw as usize, h: bh as usize };
    let (ow, oh) = (a.w.min(b.w), a.h.min(b.h));
    let n = ow * oh;
    let fields = bytes_mut(field, n * 3);
    fields.fill(0);
    let (kind, rest) = fields.split_at_mut(n);
    let (amplitude, lighter) = rest.split_at_mut(n);
    let paint_w = a.w.max(b.w);
    let paint = bytes_mut(overlay, paint_w * a.h.max(b.h) * 4);
    paint.fill(0);
    let skip = if skip == 0 { None } else { Some(bytes(skip, n)) };
    let (mut changed, mut antialiased) = (0u32, 0u32);
    for y in 0..oh {
        for x in 0..ow {
            let at = y * ow + x;
            if let Some(s) = skip {
                if s[at] != 0 {
                    continue;
                }
            }
            let delta = colour_delta(a.d, (y * a.w + x) * 4, b.d, (y * b.w + x) * 4);
            let size = if delta < 0.0 { -delta } else { delta };
            if size <= max_delta {
                continue;
            }
            if is_antialiased(&a, x, y, &b) || is_antialiased(&b, x, y, &a) {
                kind[at] = PIXEL_ANTIALIASED;
                antialiased += 1;
                continue;
            }
            kind[at] = PIXEL_CHANGED;
            let level = js_round((size / MAX_YIQ_DELTA).sqrt() * 255.0);
            amplitude[at] = if level > 255.0 { 255 } else { level as u8 };
            lighter[at] = if delta < 0.0 { 1 } else { 0 };
            changed += 1;
            let p = (y * paint_w + x) * 4;
            paint[p..p + 4].copy_from_slice(&[255, 0, 255, 255]);
        }
    }
    let out = unsafe { slice::from_raw_parts_mut(out as *mut u32, 2) };
    out[0] = changed;
    out[1] = antialiased;
}

/// `blobBoxes(field, dilatedChanged(field, gap))`: the changed pixels of `kind` (`w` x `h`)
/// dilated by `gap` in x then y, and for each 8-connected blob in index order of its first cell,
/// the box of its changed pixels as [x0, y0, x1, y1]. Writes the boxes' address to `out` and
/// returns how many there are, or u32::MAX when memory ran out.
#[unsafe(no_mangle)]
pub extern "C" fn blob_boxes(kind: usize, w: u32, h: u32, gap: f64, out: usize) -> u32 {
    let (w, h) = (w as usize, h as usize);
    let n = w * h;
    let kind = bytes(kind, n);
    let (first, second, lasts, stack) = (alloc(n), alloc(n), alloc(w * 8), alloc(n * 4));
    if first == 0 || second == 0 || lasts == 0 || stack == 0 {
        return u32::MAX;
    }
    let changed = bytes_mut(first, n);
    for i in 0..n {
        changed[i] = (kind[i] == PIXEL_CHANGED) as u8;
    }
    // x: each row on its own, forward then backward, as `dilateAxis` does.
    let wide = bytes_mut(second, n);
    wide.fill(0);
    for y in 0..h {
        let src = &changed[y * w..(y + 1) * w];
        let dst = &mut wide[y * w..(y + 1) * w];
        let mut last = f64::NEG_INFINITY;
        for p in 0..w {
            if src[p] != 0 {
                last = p as f64;
            }
            if p as f64 - last <= gap {
                dst[p] = 1;
            }
        }
        last = f64::INFINITY;
        for p in (0..w).rev() {
            if src[p] != 0 {
                last = p as f64;
            }
            if last - p as f64 <= gap {
                dst[p] = 1;
            }
        }
    }
    // y: every column at once, a row at a time, which is the same per-column scan in cache order.
    let blob = bytes_mut(first, n);
    blob.fill(0);
    let lasts = unsafe { slice::from_raw_parts_mut(lasts as *mut f64, w) };
    lasts.fill(f64::NEG_INFINITY);
    for y in 0..h {
        for x in 0..w {
            if wide[y * w + x] != 0 {
                lasts[x] = y as f64;
            }
            if y as f64 - lasts[x] <= gap {
                blob[y * w + x] = 1;
            }
        }
    }
    lasts.fill(f64::INFINITY);
    for y in (0..h).rev() {
        for x in 0..w {
            if wide[y * w + x] != 0 {
                lasts[x] = y as f64;
            }
            if lasts[x] - y as f64 <= gap {
                blob[y * w + x] = 1;
            }
        }
    }
    // Flood each blob; a box is the bounds of a set, so the visiting order does not change it.
    let seen = bytes_mut(second, n);
    seen.fill(0);
    let stack = unsafe { slice::from_raw_parts_mut(stack as *mut u32, n) };
    let boxes = mark().next_multiple_of(8);
    let mut count = 0u32;
    for start in 0..n {
        if blob[start] == 0 || seen[start] != 0 {
            continue;
        }
        seen[start] = 1;
        stack[0] = start as u32;
        let mut depth = 1;
        let mut found = false;
        let (mut x0, mut y0, mut x1, mut y1) = (0, 0, 0, 0);
        while depth > 0 {
            depth -= 1;
            let at = stack[depth] as usize;
            let (x, y) = (at % w, at / w);
            if kind[at] == PIXEL_CHANGED {
                if found {
                    (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
                } else {
                    (x0, y0, x1, y1, found) = (x, y, x, y, true);
                }
            }
            for ny in y.saturating_sub(1)..=(y + 1).min(h - 1) {
                for nx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                    let next = ny * w + nx;
                    if blob[next] == 0 || seen[next] != 0 {
                        continue;
                    }
                    seen[next] = 1;
                    stack[depth] = next as u32;
                    depth += 1;
                }
            }
        }
        if found {
            let at = alloc(16);
            if at == 0 {
                return u32::MAX;
            }
            let cell = unsafe { slice::from_raw_parts_mut(at as *mut u32, 4) };
            cell.copy_from_slice(&[x0 as u32, y0 as u32, x1 as u32, y1 as u32]);
            count += 1;
        }
    }
    unsafe { *(out as *mut u32) = boxes as u32 };
    count
}
