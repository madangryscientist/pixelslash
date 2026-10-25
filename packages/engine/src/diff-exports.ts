/** The exports of `engines/wasm/src/lib.rs`; addresses and sizes are byte offsets in `memory`. */
export type DiffExports = {
  memory: WebAssembly.Memory;
  reset(): void;
  mark(): number;
  rewind(to: number): void;
  alloc(len: number): number;
  crc32(ptr: number, len: number): number;
  unfilter(src: number, width: number, height: number, channels: number, dst: number): number;
  inflated_len(
    width: number,
    height: number,
    depth: number,
    colour: number,
    interlace: number,
  ): number;
  decode(
    src: number,
    width: number,
    height: number,
    depth: number,
    colour: number,
    interlace: number,
    palette: number,
    entries: number,
    transN: number,
    t0: number,
    t1: number,
    t2: number,
    dst: number,
  ): number;
  filter(src: number, width: number, height: number, dst: number): number;
  diff(
    a: number,
    aw: number,
    ah: number,
    b: number,
    bw: number,
    bh: number,
    skip: number,
    maxDelta: number,
    field: number,
    overlay: number,
    out: number,
  ): void;
  blob_boxes(kind: number, width: number, height: number, gap: number, out: number): number;
  tile_map_len(width: number, height: number): number;
  tiles(a: number, aw: number, ah: number, b: number, bw: number, bh: number, map: number): number;
  diff_tiled(
    a: number,
    aw: number,
    ah: number,
    b: number,
    bw: number,
    bh: number,
    skip: number,
    maxDelta: number,
    field: number,
    overlay: number,
    out: number,
    map: number,
  ): void;
  blob_boxes_tiled(
    kind: number,
    width: number,
    height: number,
    gap: number,
    map: number,
    out: number,
  ): number;
};

const EXPORTS = [
  "reset",
  "mark",
  "rewind",
  "alloc",
  "crc32",
  "unfilter",
  "inflated_len",
  "decode",
  "filter",
  "diff",
  "blob_boxes",
  "tile_map_len",
  "tiles",
  "diff_tiled",
  "blob_boxes_tiled",
];

/** Whether `exports` is the whole ABI: the memory and every function above. */
export function isDiffExports(exports: WebAssembly.Instance["exports"]): exports is DiffExports {
  return (
    exports["memory"] instanceof WebAssembly.Memory &&
    EXPORTS.every((name) => typeof exports[name] === "function")
  );
}
