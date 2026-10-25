# Decoders and overlay encoders, 2026-10-25 (PS-168)

Written by `bun run bench:decoders`; do not edit by hand. Each row is one `--impl` of `bench:perf`,
all rows interleaved in one run, so the numbers compare with each other and with no other run.
`self` is the implementation's own decode + diff ms; `wall` is the whole process. Peak RSS is what
the process reports (`peak_rss_bytes`), runtime included: compare it within an engine, not across. Install weight is the files the candidate adds on disk. `workerd` is
from each package's docs (a native addon cannot load there), not run here.

    env: dedicated · AMD Ryzen 5 5600X 6-Core Processor · kernel 7.2.8-9-omarchy · bun 1.4.2 · dotnet 10.0.402
    boost off · governor performance · host load 1.12 at start, 2.31 at end
    reserved CPUs 4-5,10-11 (host kept 0-3,6-9) · memory min 4294967296 max 4294967296
    reserved cores ran at 3121 MHz (min 1738, max 3688)
    other tasks seen on the reserved CPUs: 0; kernel threads: kworker/11:7+events, kworker/u48:11+kcryptd-253:0-1, kworker/u48:21+btrfs-endio-meta, kworker/u48:21+btrfs-endio-write

## Headline: diff-long (1440x6000)

| candidate | engine | self median | self p95 | vs baseline | decode | peak RSS MB | licence | ships? |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| stb sequential | C# | 318.7 | 320.1 | 0% | 189.5 | 168.6 | Unlicense or MIT (StbImageSharp) | permissive |
| stb parallel | C# | 253.1 | 279.1 | -21% | 120.5 | 228.6 | Unlicense or MIT (StbImageSharp) | permissive |
| spng parallel | C# | 215.1 | 233.6 | -33% | 84.6 | 158.2 | BSD-2-Clause (libspng) + zlib (system zlib) | permissive |
| spng-zlibng parallel | C# | 147.6 | 151.5 | -54% | 16.9 | 158.3 | BSD-2-Clause (libspng) + zlib (zlib-ng, static) | permissive |
| wuffs parallel | C# | 156.6 | 160.4 | -51% | 26.1 | 163.7 | Apache-2.0 or MIT (Wuffs) | permissive |
| skia parallel | C# | 163.7 | 167.6 | -49% | 32.7 | 161.1 | MIT (SkiaSharp) + BSD-3-Clause (Skia) | permissive |
| imagesharp parallel | C# | 271.2 | 287.9 | -15% | 141.2 | 235.9 | Six Labors Split License 1.0 (3.1.12) | never: Six Labors Split: a paid licence for commercial use over $1M revenue; 3.2+ needs a key to build |
| pngjs sequential | TS | 656.6 | 684.9 | 0% | 282.3 | 411.0 | MIT | permissive |
| pngjs parallel | TS | 523.8 | 553.1 | -20% | 166.0 | 398.1 | MIT | permissive |
| fast-png sequential | TS | 1188.6 | 1214.8 | 81% | 823.2 | 399.0 | MIT | permissive |
| fast-png parallel | TS | 809.2 | 857.6 | 23% | 442.7 | 374.5 | MIT | permissive |
| upng sequential | TS | 795.3 | 823.6 | 21% | 435.5 | 281.0 | MIT | permissive |
| upng parallel | TS | 715.4 | 732.6 | 9% | 344.5 | 319.4 | MIT | permissive |
| sharp sequential | TS | 465.7 | 476.8 | -29% | 90.2 | 274.2 | Apache-2.0 (libvips LGPL-3.0, dynamically linked) | never: libvips is LGPL-3.0 |
| sharp parallel | TS | 485.7 | 502.2 | -26% | 118.3 | 286.7 | Apache-2.0 (libvips LGPL-3.0, dynamically linked) | never: libvips is LGPL-3.0 |
| napi-image sequential | TS | 402.6 | 412.5 | -39% | 29.8 | 308.6 | MIT | permissive |
| napi-image parallel | TS | 449.2 | 457.6 | -32% | 81.1 | 316.3 | MIT | permissive |
| jsquash sequential | TS | 584.6 | 596.2 | -11% | 221.8 | 276.7 | Apache-2.0 | permissive |
| jsquash parallel | TS | 528.9 | 550.3 | -19% | 163.1 | 282.7 | Apache-2.0 | permissive |
| cf-wasm sequential | TS | 3556.9 | 3687.0 | 442% | 3168.4 | 633.4 | MIT | permissive |
| cf-wasm parallel | TS | 2043.2 | 2230.3 | 211% | 1657.1 | 1175.8 | MIT | permissive |
| overlay pngjs | TS | 1065.2 | 1095.5 | 62% | 274.7 | 410.4 | MIT | permissive |
| overlay pngjs-l6 | TS | 1071.6 | 1088.7 | 63% | 272.7 | 411.2 | MIT | permissive |
| overlay pngjs-l1 | TS | 1065.5 | 1098.3 | 62% | 280.1 | 416.3 | MIT | permissive |
| overlay sharp | TS | 684.6 | 705.7 | 4% | 276.3 | 424.2 | Apache-2.0 (libvips LGPL-3.0, dynamically linked) | never: libvips is LGPL-3.0 |
| overlay napi-image | TS | 677.3 | 703.8 | 3% | 275.8 | 424.9 | MIT | permissive |
| overlay cf-wasm | TS | 892.9 | 910.2 | 36% | 273.9 | 416.7 | MIT | permissive |
| pngjs sequential, bun build --compile | TS | 643.1 | 654.5 | -2% | 284.4 | 472.0 | MIT | permissive |

## Every row, every page

| candidate | engine | page | self median | self p95 | wall | startup | decode read / inflate / unfilter / other | pixel_compare / regions / overlay_encode | peak RSS MB | licence | workerd | CLI (Bun) | C# | install MB |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | --- | --- | --- | ---: |
| stb sequential | C# | diff-phone | 70.7 | 72.1 | 107.1 | 16.7 | 3.8 / 7.9 / 21.3 / 6.2 | 10.2 / 18.8 / - | 39.0 | Unlicense or MIT (StbImageSharp) | no | no | yes | 0.1 |
| stb sequential | C# | diff-desktop | 100.2 | 104.5 | 136.8 | 16.7 | 3.9 / 11.2 / 36.3 / 8.1 | 14.7 / 23.3 / - | 50.7 | Unlicense or MIT (StbImageSharp) | no | no | yes | 0.1 |
| stb sequential | C# | diff-long | 318.7 | 320.1 | 356.1 | 16.6 | 3.9 / 33.0 / 123.8 / 26.9 | 46.9 / 77.1 / - | 168.6 | Unlicense or MIT (StbImageSharp) | no | no | yes | 0.1 |
| stb parallel | C# | diff-phone | 70.4 | 74.5 | 106.5 | 16.1 | 4.0 / 14.4 / 34.1 / 11.8 | 10.8 / 18.8 / - | 39.0 | Unlicense or MIT (StbImageSharp) | no | no | yes | 0.1 |
| stb parallel | C# | diff-desktop | 88.2 | 100.7 | 124.5 | 16.1 | 4.2 / 18.7 / 46.4 / 14.2 | 14.2 / 23.7 / - | 57.4 | Unlicense or MIT (StbImageSharp) | no | no | yes | 0.1 |
| stb parallel | C# | diff-long | 253.1 | 279.1 | 290.7 | 16.4 | 4.2 / 40.4 / 145.5 / 34.0 | 46.7 / 80.3 / - | 228.6 | Unlicense or MIT (StbImageSharp) | no | no | yes | 0.1 |
| spng parallel | C# | diff-phone | 43.6 | 44.6 | 90.2 | 16.3 | 1.0 / - / - / 8.2 | 12.0 / 19.3 / - | 38.1 | BSD-2-Clause (libspng) + zlib (system zlib) | no | no | yes | 0.1 |
| spng parallel | C# | diff-desktop | 59.7 | 61.8 | 106.5 | 16.1 | 1.1 / - / - / 25.4 | 15.5 / 23.7 / - | 49.9 | BSD-2-Clause (libspng) + zlib (system zlib) | no | no | yes | 0.1 |
| spng parallel | C# | diff-long | 215.1 | 233.6 | 262.5 | 16.1 | 1.1 / - / - / 156.4 | 48.3 / 76.6 / - | 158.2 | BSD-2-Clause (libspng) + zlib (system zlib) | no | no | yes | 0.1 |
| spng-zlibng parallel | C# | diff-phone | 40.7 | 42.2 | 87.1 | 16.5 | 1.1 / - / - / 3.0 | 12.0 / 19.5 / - | 38.2 | BSD-2-Clause (libspng) + zlib (zlib-ng, static) | no | no | yes | 0.3 |
| spng-zlibng parallel | C# | diff-desktop | 49.4 | 50.4 | 95.1 | 16.1 | 1.0 / - / - / 5.0 | 15.5 / 23.7 / - | 50.0 | BSD-2-Clause (libspng) + zlib (zlib-ng, static) | no | no | yes | 0.3 |
| spng-zlibng parallel | C# | diff-long | 147.6 | 151.5 | 195.0 | 16.6 | 1.1 / - / - / 21.1 | 48.0 / 76.9 / - | 158.3 | BSD-2-Clause (libspng) + zlib (zlib-ng, static) | no | no | yes | 0.3 |
| wuffs parallel | C# | diff-phone | 41.3 | 43.4 | 87.9 | 16.5 | 1.1 / - / - / 4.3 | 12.0 / 19.5 / - | 38.1 | Apache-2.0 or MIT (Wuffs) | no | no | yes | 0.4 |
| wuffs parallel | C# | diff-desktop | 51.3 | 52.1 | 97.1 | 16.2 | 1.0 / - / - / 8.2 | 15.6 / 23.8 / - | 50.0 | Apache-2.0 or MIT (Wuffs) | no | no | yes | 0.4 |
| wuffs parallel | C# | diff-long | 156.6 | 160.4 | 202.9 | 16.3 | 1.1 / - / - / 39.2 | 48.3 / 76.6 / - | 163.7 | Apache-2.0 or MIT (Wuffs) | no | no | yes | 0.4 |
| skia parallel | C# | diff-phone | 52.2 | 54.0 | 95.3 | 16.4 | 4.2 / - / - / 21.8 | 12.0 / 19.0 / - | 40.9 | MIT (SkiaSharp) + BSD-3-Clause (Skia) | no | no | yes | 12.8 |
| skia parallel | C# | diff-desktop | 61.8 | 63.5 | 105.7 | 16.3 | 4.1 / - / - / 25.2 | 15.7 / 23.9 / - | 52.7 | MIT (SkiaSharp) + BSD-3-Clause (Skia) | no | no | yes | 12.8 |
| skia parallel | C# | diff-long | 163.7 | 167.6 | 207.2 | 16.0 | 4.4 / - / - / 48.5 | 48.1 / 76.4 / - | 161.1 | MIT (SkiaSharp) + BSD-3-Clause (Skia) | no | no | yes | 12.8 |
| imagesharp parallel | C# | diff-phone | 126.6 | 131.9 | 165.2 | 16.1 | 4.1 / - / - / 178.3 | 10.1 / 18.3 / - | 47.4 | Six Labors Split License 1.0 (3.1.12) | no | no | yes | 2.1 |
| imagesharp parallel | C# | diff-desktop | 142.9 | 145.9 | 182.3 | 16.3 | 4.3 / - / - / 193.4 | 13.9 / 23.1 / - | 68.5 | Six Labors Split License 1.0 (3.1.12) | no | no | yes | 2.1 |
| imagesharp parallel | C# | diff-long | 271.2 | 287.9 | 313.7 | 16.1 | 4.4 / - / - / 265.8 | 47.1 / 80.4 / - | 235.9 | Six Labors Split License 1.0 (3.1.12) | no | no | yes | 2.1 |
| pngjs sequential | TS | diff-phone | 78.1 | 81.0 | 105.5 | 21.2 | 0.1 / 2.6 / 11.5 / 9.9 | 13.5 / 27.6 / 0.0 | 71.4 | MIT | yes | yes | no | 0.7 |
| pngjs sequential | TS | diff-desktop | 133.4 | 137.1 | 163.3 | 21.2 | 0.1 / 8.8 / 27.9 / 15.9 | 30.9 / 39.8 / 0.0 | 103.1 | MIT | yes | yes | no | 0.7 |
| pngjs sequential | TS | diff-long | 656.6 | 684.9 | 706.4 | 21.4 | 0.1 / 71.7 / 154.2 / 53.9 | 171.1 / 162.3 / 0.0 | 411.0 | MIT | yes | yes | no | 0.7 |
| pngjs parallel | TS | diff-phone | 86.2 | 89.5 | 114.0 | 21.0 | 0.1 / 2.8 / 16.3 / 14.0 | 13.6 / 27.6 / 0.0 | 78.9 | MIT | yes | yes | no | 0.7 |
| pngjs parallel | TS | diff-desktop | 132.7 | 142.2 | 163.7 | 21.0 | 0.1 / 12.2 / 38.0 / 19.9 | 31.1 / 41.6 / 0.0 | 113.5 | MIT | yes | yes | no | 0.7 |
| pngjs parallel | TS | diff-long | 523.8 | 553.1 | 573.9 | 21.3 | 0.2 / 77.4 / 166.2 / 55.8 | 168.5 / 157.8 / 0.0 | 398.1 | MIT | yes | yes | no | 0.7 |
| fast-png sequential | TS | diff-phone | 104.9 | 107.5 | 132.9 | 21.0 | 0.1 / 0.0 / 0.0 / 51.0 | 13.7 / 27.5 / 0.0 | 75.0 | MIT | yes | yes | no | 1.0 |
| fast-png sequential | TS | diff-desktop | 222.3 | 239.8 | 252.8 | 21.1 | 0.1 / 0.0 / 0.0 / 138.4 | 31.3 / 42.2 / 0.0 | 108.3 | MIT | yes | yes | no | 1.0 |
| fast-png sequential | TS | diff-long | 1188.6 | 1214.8 | 1242.3 | 21.2 | 0.1 / 0.0 / 0.0 / 823.1 | 167.8 / 165.8 / 0.0 | 399.0 | MIT | yes | yes | no | 1.0 |
| fast-png parallel | TS | diff-phone | 103.6 | 107.6 | 132.7 | 21.0 | 0.1 / 0.0 / 0.0 / 69.1 | 13.8 / 27.2 / 0.0 | 88.0 | MIT | yes | yes | no | 1.0 |
| fast-png parallel | TS | diff-desktop | 184.2 | 190.0 | 214.0 | 20.9 | 0.1 / 0.0 / 0.0 / 179.8 | 30.2 / 42.2 / 0.0 | 107.8 | MIT | yes | yes | no | 1.0 |
| fast-png parallel | TS | diff-long | 809.2 | 857.6 | 853.3 | 21.2 | 0.2 / 0.0 / 0.0 / 854.2 | 165.7 / 171.8 / 0.0 | 374.5 | MIT | yes | yes | no | 1.0 |
| upng sequential | TS | diff-phone | 103.3 | 109.3 | 130.3 | 21.1 | 0.1 / 0.0 / 0.0 / 48.9 | 14.6 / 27.8 / 0.0 | 77.1 | MIT | yes | yes | no | 0.8 |
| upng sequential | TS | diff-desktop | 178.2 | 183.8 | 208.0 | 20.9 | 0.1 / 0.0 / 0.0 / 94.9 | 31.3 / 42.9 / 0.0 | 100.1 | MIT | yes | yes | no | 0.8 |
| upng sequential | TS | diff-long | 795.3 | 823.6 | 838.1 | 21.2 | 0.1 / 0.0 / 0.0 / 435.4 | 168.3 / 162.2 / 0.0 | 281.0 | MIT | yes | yes | no | 0.8 |
| upng parallel | TS | diff-phone | 141.7 | 148.5 | 170.2 | 21.0 | 0.1 / 0.0 / 0.0 / 116.3 | 15.3 / 27.5 / 0.0 | 90.2 | MIT | yes | yes | no | 0.8 |
| upng parallel | TS | diff-desktop | 198.6 | 214.4 | 229.8 | 21.0 | 0.1 / 0.0 / 0.0 / 199.1 | 30.8 / 41.5 / 0.0 | 118.6 | MIT | yes | yes | no | 0.8 |
| upng parallel | TS | diff-long | 715.4 | 732.6 | 763.5 | 21.2 | 0.2 / 0.0 / 0.0 / 661.1 | 173.6 / 164.4 / 0.0 | 319.4 | MIT | yes | yes | no | 0.8 |
| sharp sequential | TS | diff-phone | 82.4 | 84.7 | 110.2 | 21.1 | 0.1 / 0.0 / 0.0 / 26.7 | 13.3 / 27.2 / 0.0 | 82.7 | Apache-2.0 (libvips LGPL-3.0, dynamically linked) | no | yes | no | 77.0 |
| sharp sequential | TS | diff-desktop | 122.0 | 125.1 | 151.9 | 21.4 | 0.1 / 0.0 / 0.0 / 35.8 | 31.8 / 42.1 / 0.0 | 103.7 | Apache-2.0 (libvips LGPL-3.0, dynamically linked) | no | yes | no | 77.0 |
| sharp sequential | TS | diff-long | 465.7 | 476.8 | 504.0 | 21.4 | 0.1 / 0.0 / 0.0 / 90.1 | 174.2 / 167.9 / 0.0 | 274.2 | Apache-2.0 (libvips LGPL-3.0, dynamically linked) | no | yes | no | 77.0 |
| sharp parallel | TS | diff-phone | 88.8 | 93.4 | 118.5 | 21.0 | 0.1 / 0.0 / 0.0 / 43.1 | 15.0 / 27.2 / 0.0 | 92.6 | Apache-2.0 (libvips LGPL-3.0, dynamically linked) | no | yes | no | 77.0 |
| sharp parallel | TS | diff-desktop | 127.6 | 131.4 | 158.4 | 21.1 | 0.1 / 0.0 / 0.0 / 53.7 | 31.6 / 41.4 / 0.0 | 124.0 | Apache-2.0 (libvips LGPL-3.0, dynamically linked) | no | yes | no | 77.0 |
| sharp parallel | TS | diff-long | 485.7 | 502.2 | 527.1 | 21.2 | 0.2 / 0.0 / 0.0 / 114.9 | 168.5 / 164.2 / 0.0 | 286.7 | Apache-2.0 (libvips LGPL-3.0, dynamically linked) | no | yes | no | 77.0 |
| napi-image sequential | TS | diff-phone | 60.8 | 64.5 | 88.0 | 21.3 | 0.1 / 0.0 / 0.0 / 5.3 | 13.5 / 27.6 / 0.0 | 74.7 | MIT | no | yes | no | 18.1 |
| napi-image sequential | TS | diff-desktop | 94.1 | 97.3 | 122.2 | 21.0 | 0.1 / 0.0 / 0.0 / 8.9 | 31.8 / 43.5 / 0.0 | 97.6 | MIT | no | yes | no | 18.1 |
| napi-image sequential | TS | diff-long | 402.6 | 412.5 | 438.6 | 21.3 | 0.1 / 0.0 / 0.0 / 29.7 | 170.1 / 170.0 / 0.0 | 308.6 | MIT | no | yes | no | 18.1 |
| napi-image parallel | TS | diff-phone | 75.4 | 76.9 | 103.0 | 21.2 | 0.2 / 0.0 / 0.0 / 6.8 | 14.0 / 27.9 / 0.0 | 80.8 | MIT | no | yes | no | 18.1 |
| napi-image parallel | TS | diff-desktop | 111.2 | 117.9 | 141.0 | 21.1 | 0.1 / 0.0 / 0.0 / 10.6 | 32.5 / 41.8 / 0.0 | 112.5 | MIT | no | yes | no | 18.1 |
| napi-image parallel | TS | diff-long | 449.2 | 457.6 | 491.5 | 21.1 | 0.2 / 0.0 / 0.0 / 31.2 | 170.3 / 163.9 / 0.0 | 316.3 | MIT | no | yes | no | 18.1 |
| jsquash sequential | TS | diff-phone | 75.9 | 78.4 | 104.1 | 21.2 | 0.1 / 0.0 / 0.0 / 19.7 | 14.8 / 27.5 / 0.0 | 87.0 | Apache-2.0 | yes | yes | no | 0.2 |
| jsquash sequential | TS | diff-desktop | 133.3 | 150.1 | 163.6 | 21.2 | 0.1 / 0.0 / 0.0 / 47.3 | 33.4 / 42.6 / 0.0 | 104.6 | Apache-2.0 | yes | yes | no | 0.2 |
| jsquash sequential | TS | diff-long | 584.6 | 596.2 | 628.2 | 21.1 | 0.1 / 0.0 / 0.0 / 221.7 | 166.8 / 165.9 / 0.0 | 276.7 | Apache-2.0 | yes | yes | no | 0.2 |
| jsquash parallel | TS | diff-phone | 93.4 | 96.4 | 123.2 | 20.9 | 0.2 / 0.0 / 0.0 / 35.1 | 14.7 / 27.4 / 0.0 | 101.4 | Apache-2.0 | yes | yes | no | 0.2 |
| jsquash parallel | TS | diff-desktop | 144.6 | 154.5 | 175.5 | 21.3 | 0.1 / 0.0 / 0.0 / 88.0 | 31.7 / 42.0 / 0.0 | 109.6 | Apache-2.0 | yes | yes | no | 0.2 |
| jsquash parallel | TS | diff-long | 528.9 | 550.3 | 572.2 | 21.2 | 0.2 / 0.0 / 0.0 / 300.8 | 169.0 / 164.4 / 0.0 | 282.7 | Apache-2.0 | yes | yes | no | 0.2 |
| cf-wasm sequential | TS | diff-phone | 183.2 | 190.2 | 212.3 | 21.1 | 0.1 / 0.0 / 0.0 / 129.5 | 13.4 / 26.8 / 0.0 | 97.2 | MIT | yes | yes | no | 0.6 |
| cf-wasm sequential | TS | diff-desktop | 569.7 | 610.0 | 604.1 | 20.9 | 0.1 / 0.0 / 0.0 / 487.3 | 33.0 / 39.3 / 0.0 | 195.0 | MIT | yes | yes | no | 0.6 |
| cf-wasm sequential | TS | diff-long | 3556.9 | 3687.0 | 3606.1 | 21.2 | 0.1 / 0.0 / 0.0 / 3168.2 | 183.5 / 173.8 / 0.0 | 633.4 | MIT | yes | yes | no | 0.6 |
| cf-wasm parallel | TS | diff-phone | 152.0 | 156.1 | 181.9 | 21.1 | 0.1 / 0.0 / 0.0 / 160.9 | 13.7 / 27.4 / 0.0 | 128.6 | MIT | yes | yes | no | 0.6 |
| cf-wasm parallel | TS | diff-desktop | 379.4 | 428.5 | 419.5 | 21.3 | 0.1 / 0.0 / 0.0 / 556.4 | 32.2 / 40.7 / 0.0 | 297.5 | MIT | yes | yes | no | 0.6 |
| cf-wasm parallel | TS | diff-long | 2043.2 | 2230.3 | 2087.9 | 21.2 | 0.2 / 0.0 / 0.0 / 3265.8 | 172.4 / 171.9 / 0.0 | 1175.8 | MIT | yes | yes | no | 0.6 |
| overlay pngjs | TS | diff-phone | 100.4 | 105.0 | 128.1 | 21.1 | 0.1 / 2.6 / 12.7 / 10.2 | 13.4 / 26.7 / 23.4 | 71.4 | MIT | yes | yes | no | 0.7 |
| overlay pngjs | TS | diff-desktop | 217.1 | 226.4 | 247.4 | 21.1 | 0.1 / 9.0 / 27.5 / 16.0 | 31.3 / 41.9 / 80.8 | 111.3 | MIT | yes | yes | no | 0.7 |
| overlay pngjs | TS | diff-long | 1065.2 | 1095.5 | 1114.8 | 21.1 | 0.1 / 70.0 / 154.1 / 48.7 | 171.8 / 158.6 / 415.8 | 410.4 | MIT | yes | yes | no | 0.7 |
| overlay pngjs-l6 | TS | diff-phone | 103.5 | 106.8 | 131.5 | 21.1 | 0.1 / 2.6 / 12.8 / 10.3 | 13.4 / 27.2 / 23.4 | 71.4 | MIT | yes | yes | no | 0.7 |
| overlay pngjs-l6 | TS | diff-desktop | 214.2 | 221.7 | 244.5 | 21.2 | 0.1 / 9.1 / 27.8 / 15.9 | 30.1 / 40.8 / 79.1 | 113.8 | MIT | yes | yes | no | 0.7 |
| overlay pngjs-l6 | TS | diff-long | 1071.6 | 1088.7 | 1121.9 | 21.0 | 0.1 / 70.2 / 153.1 / 48.3 | 172.1 / 163.8 / 414.6 | 411.2 | MIT | yes | yes | no | 0.7 |
| overlay pngjs-l1 | TS | diff-phone | 102.0 | 107.7 | 129.3 | 21.0 | 0.1 / 2.6 / 12.3 / 10.1 | 13.8 / 27.5 / 23.8 | 71.5 | MIT | yes | yes | no | 0.7 |
| overlay pngjs-l1 | TS | diff-desktop | 216.4 | 220.1 | 246.3 | 20.9 | 0.1 / 8.9 / 26.1 / 15.7 | 31.1 / 40.8 / 82.4 | 113.0 | MIT | yes | yes | no | 0.7 |
| overlay pngjs-l1 | TS | diff-long | 1065.5 | 1098.3 | 1117.1 | 21.1 | 0.1 / 70.5 / 154.3 / 53.9 | 170.4 / 166.5 / 404.1 | 416.3 | MIT | yes | yes | no | 0.7 |
| overlay sharp | TS | diff-phone | 102.1 | 105.5 | 127.0 | 21.3 | 0.1 / 2.7 / 12.9 / 10.2 | 13.7 / 27.1 / 23.1 | 84.8 | Apache-2.0 (libvips LGPL-3.0, dynamically linked) | no | yes | no | 77.0 |
| overlay sharp | TS | diff-desktop | 160.4 | 165.7 | 186.6 | 20.9 | 0.1 / 9.0 / 27.8 / 16.0 | 31.2 / 41.2 / 24.6 | 119.2 | Apache-2.0 (libvips LGPL-3.0, dynamically linked) | no | yes | no | 77.0 |
| overlay sharp | TS | diff-long | 684.6 | 705.7 | 733.6 | 21.1 | 0.1 / 70.4 / 154.1 / 49.1 | 168.7 / 160.9 / 35.3 | 424.2 | Apache-2.0 (libvips LGPL-3.0, dynamically linked) | no | yes | no | 77.0 |
| overlay napi-image | TS | diff-phone | 84.9 | 87.3 | 113.5 | 22.3 | 0.1 / 2.7 / 12.4 / 10.2 | 13.8 / 27.7 / 4.7 | 74.2 | MIT | no | yes | no | 18.1 |
| overlay napi-image | TS | diff-desktop | 142.2 | 147.8 | 172.5 | 22.4 | 0.1 / 9.1 / 27.8 / 15.9 | 31.1 / 43.4 / 5.9 | 112.9 | MIT | no | yes | no | 18.1 |
| overlay napi-image | TS | diff-long | 677.3 | 703.8 | 732.0 | 21.1 | 0.1 / 70.1 / 153.7 / 48.4 | 168.3 / 163.3 / 27.3 | 424.9 | MIT | no | yes | no | 18.1 |
| overlay cf-wasm | TS | diff-phone | 103.3 | 113.1 | 132.5 | 21.4 | 0.1 / 2.7 / 12.7 / 10.2 | 13.8 / 26.9 / 23.9 | 88.1 | MIT | yes | yes | no | 0.6 |
| overlay cf-wasm | TS | diff-desktop | 187.7 | 196.8 | 218.8 | 21.1 | 0.1 / 9.0 / 27.8 / 15.8 | 31.0 / 41.7 / 53.9 | 128.0 | MIT | yes | yes | no | 0.6 |
| overlay cf-wasm | TS | diff-long | 892.9 | 910.2 | 944.9 | 21.0 | 0.1 / 70.3 / 154.7 / 48.5 | 172.4 / 163.4 / 231.2 | 416.7 | MIT | yes | yes | no | 0.6 |
| pngjs sequential, bun build --compile | TS | diff-phone | 79.1 | 84.0 | 111.7 | 26.8 | 0.2 / 0.0 / 0.0 / 24.6 | 14.1 / 27.0 / 0.2 | 72.2 | MIT | no | yes | no | 117.9 |
| pngjs sequential, bun build --compile | TS | diff-desktop | 135.6 | 145.5 | 171.3 | 26.3 | 0.2 / 0.0 / 0.0 / 52.3 | 32.0 / 42.7 / 0.2 | 109.3 | MIT | no | yes | no | 117.9 |
| pngjs sequential, bun build --compile | TS | diff-long | 643.1 | 654.5 | 705.4 | 26.4 | 0.2 / 0.0 / 0.0 / 284.1 | 162.3 / 159.3 / 0.2 | 472.0 | MIT | no | yes | no | 117.9 |

## Could not build

- **libspng or Wuffs as WASM (TS)**: no maintained npm build of either; building one is a new toolchain (emscripten) for a bench row
- **ImageSharp 3.2 / 4.x (C#)**: the build stops without a Six Labors licence key; buying one is not ours to do, so 3.1.12 is measured
- **jsquash under bun build --compile (TS)**: its .wasm is loaded by path and is not embedded: ENOENT on /$bunfs/root/squoosh_png_bg.wasm
- **sharp under bun build --compile (TS)**: its native addon and libvips are not embedded: "Could not load the sharp module"
