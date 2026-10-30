// A two-function C API over Wuffs' PNG decoder (PS-168), so the C# engine can P/Invoke it the way it
// calls libspng: read a PNG's size, then decode it in memory into the caller's RGBA buffer.
// Wuffs is compiled into this file from its upstream single-file release (build.sh fetches it).
#define WUFFS_IMPLEMENTATION
#define WUFFS_CONFIG__MODULES
#define WUFFS_CONFIG__MODULE__BASE
#define WUFFS_CONFIG__MODULE__ADLER32
#define WUFFS_CONFIG__MODULE__CRC32
#define WUFFS_CONFIG__MODULE__DEFLATE
#define WUFFS_CONFIG__MODULE__PNG
#define WUFFS_CONFIG__MODULE__ZLIB
#include "wuffs-v0.4.c"

#include <stdlib.h>

// The PNG's size, from its header: 0, or a negative number when it is not a PNG Wuffs can read.
__attribute__((visibility("default"))) int ps_wuffs_png_size(const uint8_t* src, size_t len, uint32_t* width,
                                                             uint32_t* height) {
  wuffs_png__decoder* dec = wuffs_png__decoder__alloc();
  if (!dec) return -1;
  wuffs_base__io_buffer in = wuffs_base__ptr_u8__reader((uint8_t*)src, len, true);
  wuffs_base__image_config ic = {0};
  int rc = wuffs_png__decoder__decode_image_config(dec, &ic, &in).repr ? -2 : 0;
  *width = wuffs_base__pixel_config__width(&ic.pixcfg);
  *height = wuffs_base__pixel_config__height(&ic.pixcfg);
  free(dec);
  return rc;
}

// Decode the PNG into `out`, which holds width * height * 4 bytes: 8-bit RGBA, not premultiplied.
// 0 on success, a negative number when it cannot.
__attribute__((visibility("default"))) int ps_wuffs_png_rgba(const uint8_t* src, size_t len, uint8_t* out,
                                                             size_t out_len) {
  wuffs_png__decoder* dec = wuffs_png__decoder__alloc();
  if (!dec) return -1;
  int rc = -2;
  uint8_t* work = NULL;
  wuffs_base__io_buffer in = wuffs_base__ptr_u8__reader((uint8_t*)src, len, true);
  wuffs_base__image_config ic = {0};
  if (wuffs_png__decoder__decode_image_config(dec, &ic, &in).repr) goto done;
  uint32_t w = wuffs_base__pixel_config__width(&ic.pixcfg);
  uint32_t h = wuffs_base__pixel_config__height(&ic.pixcfg);
  if ((uint64_t)w * h * 4 != out_len) goto done;
  wuffs_base__pixel_config__set(&ic.pixcfg, WUFFS_BASE__PIXEL_FORMAT__RGBA_NONPREMUL,
                                WUFFS_BASE__PIXEL_SUBSAMPLING__NONE, w, h);
  uint64_t work_len = wuffs_png__decoder__workbuf_len(dec).max_incl;
  work = malloc(work_len ? work_len : 1);
  if (!work) goto done;
  wuffs_base__pixel_buffer pb = {0};
  if (wuffs_base__pixel_buffer__set_from_slice(&pb, &ic.pixcfg, wuffs_base__make_slice_u8(out, out_len)).repr)
    goto done;
  if (wuffs_png__decoder__decode_frame(dec, &pb, &in, WUFFS_BASE__PIXEL_BLEND__SRC,
                                       wuffs_base__make_slice_u8(work, work_len), NULL).repr)
    goto done;
  rc = 0;
done:
  free(work);
  free(dec);
  return rc;
}
