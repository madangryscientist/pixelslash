#!/usr/bin/env bash
# Build the native PNG decoders the C# engine can P/Invoke (PS-168), from their upstream sources:
#
#   libspng-zlib.so     libspng 0.7.4 (BSD-2) on the system zlib
#   libspng-zlibng.so   libspng 0.7.4 on zlib-ng 2.3.3 (zlib licence), compat mode, linked in statically
#   libwuffs-png.so     Wuffs v0.4.0-alpha.9 (Apache-2.0), PNG only, behind wuffs-shim.c
#
# Sources are fetched once into ~/.cache/pixelslash-native (not /tmp), checked against the pinned
# sha256 below, and built with gcc and make (no cmake). The libraries land in native/out/, which is
# gitignored. Bench and dev only: the gate's decoder tests skip a candidate whose library is absent.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/out"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/pixelslash-native"
mkdir -p "$out" "$cache"

fetch() { # url file sha256
  local url="$1" file="$cache/$2" sum="$3"
  if [ ! -f "$file" ]; then
    curl -fsSL -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  echo "$sum  $file" | sha256sum -c --quiet - || { echo "build.sh: $2 does not match its pinned sha256" >&2; exit 1; }
}

fetch https://github.com/randy408/libspng/archive/refs/tags/v0.7.4.tar.gz libspng-0.7.4.tar.gz \
  47ec02be6c0a6323044600a9221b049f63e1953faf816903e7383d4dc4234487
fetch https://github.com/zlib-ng/zlib-ng/archive/refs/tags/2.3.3.tar.gz zlib-ng-2.3.3.tar.gz \
  f9c65aa9c852eb8255b636fd9f07ce1c406f061ec19a2e7d508b318ca0c907d1
fetch https://raw.githubusercontent.com/google/wuffs/v0.4.0-alpha.9/release/c/wuffs-v0.4.c wuffs-v0.4.c \
  51d2f73b757adfab105386fd3641aebd69dabc3a19126d5e060b6996ede94714

work="$cache/build"
rm -rf "$work"
mkdir -p "$work"
tar -xzf "$cache/libspng-0.7.4.tar.gz" -C "$work"
tar -xzf "$cache/zlib-ng-2.3.3.tar.gz" -C "$work"

# Optimised and position-independent. libspng exports its whole API (its header has no visibility
# switch on Linux); zlib-ng's symbols are kept out of the export table, so the runtime's zlib is not
# shadowed. The Wuffs shim exports its two functions only.
cflags=(-O3 -fPIC -DNDEBUG)
spng="$work/libspng-0.7.4/spng/spng.c"
# libspng's own SIMD filters at SSE4.1.
spng_flags=(-DSPNG_SSE=4)

gcc "${cflags[@]}" "${spng_flags[@]}" -shared -o "$out/libspng-zlib.so" "$spng" -lz

(cd "$work/zlib-ng-2.3.3" && CFLAGS="-O3 -fPIC" ./configure --zlib-compat --static >/dev/null && make -j"$(nproc)" libz.a >/dev/null)
gcc "${cflags[@]}" "${spng_flags[@]}" -I"$work/zlib-ng-2.3.3" -shared -o "$out/libspng-zlibng.so" "$spng" \
  "$work/zlib-ng-2.3.3/libz.a" -Wl,--exclude-libs,ALL

gcc "${cflags[@]}" -fvisibility=hidden -I"$cache" -shared -o "$out/libwuffs-png.so" "$here/wuffs-shim.c"

rm -rf "$work"
ls -l "$out"
