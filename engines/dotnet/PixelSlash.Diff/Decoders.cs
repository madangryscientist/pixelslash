using System.Diagnostics;
using System.Runtime.InteropServices;
using SkiaSharp;
#if DECODER_CANDIDATES
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
#endif

namespace PixelSlash.Diff;

/// <summary>
/// The PNG decoders the engine can run (PS-168), behind `--decoder &lt;name&gt;`. Each one reads the file
/// and returns 8-bit RGBA, not premultiplied, with no colour or gamma conversion, so every one of them
/// must give the bytes StbImageSharp gives (a test holds it on every corpus PNG). Only `stb` splits its
/// decode into phases; the others report `decode_read` and `decode_other`.
///
/// The default is `skia`: of the permissive decoders, the fastest that comes from NuGet, so a fresh
/// checkout runs it with no build step. `spng-zlibng` and `wuffs` measured faster still (bench/PERF.md),
/// but they and `spng` are native libraries built from upstream by `native/build.sh`, which needs gcc
/// and the network. `imagesharp` is compiled in only with `-p:DecoderCandidates=true` (its licence is
/// not permissive). A decoder whose library is not there is a usage error, never a silent fallback.
/// </summary>
public static unsafe class Decoders
{
    public const string Default = "skia";

    /// <summary>Every name, in the order the bench lists them.</summary>
    public static readonly string[] Names = ["stb", "spng", "spng-zlibng", "wuffs", "skia", "imagesharp"];

    static double Ms(long from, long to) => (to - from) * 1000.0 / Stopwatch.Frequency;

    /// <summary>Why `name` cannot run in this build or on this machine; null when it can.</summary>
    public static string? Unavailable(string name) => name switch
    {
        "stb" => null,
        "spng" => Native.Spng("libspng-zlib.so").Missing,
        "spng-zlibng" => Native.Spng("libspng-zlibng.so").Missing,
        "wuffs" => Native.Wuffs.Missing,
        "skia" => null,
#if DECODER_CANDIDATES
        "imagesharp" => null,
#else
        "imagesharp" => $"{name} is compiled in only with -p:DecoderCandidates=true",
#endif
        _ => $"unknown decoder {name} (one of {string.Join(", ", Names)})",
    };

    /// <summary>Read and decode one PNG with `name`; throws when it cannot.</summary>
    public static (Raster Image, DecodeTimes Times) Read(string name, string path)
    {
        if (name == "stb") return PngDecode.Read(path);
        var started = Stopwatch.GetTimestamp();
        var file = File.ReadAllBytes(path);
        var read = Stopwatch.GetTimestamp();
        var image = name switch
        {
            "spng" => Native.Spng("libspng-zlib.so").Decode(file),
            "spng-zlibng" => Native.Spng("libspng-zlibng.so").Decode(file),
            "wuffs" => Native.Wuffs.Decode(file),
            "skia" => Skia(file),
#if DECODER_CANDIDATES
            "imagesharp" => ImageSharp(file),
#endif
            _ => throw new ArgumentException(Unavailable(name) ?? $"no decoder {name}"),
        } ?? throw new InvalidDataException($"{name} cannot decode {path}");
        var end = Stopwatch.GetTimestamp();
        return (image, new DecodeTimes(Ms(started, read), 0, 0, Ms(read, end), false));
    }

    static Raster? Skia(byte[] file)
    {
        using var data = SKData.CreateCopy(file);
        using var codec = SKCodec.Create(data);
        if (codec is null) return null;
        // No colour space on the target: Skia then converts nothing, as stb converts nothing.
        var info = new SKImageInfo(codec.Info.Width, codec.Info.Height, SKColorType.Rgba8888, SKAlphaType.Unpremul);
        var pixels = new byte[info.BytesSize];
        fixed (byte* to = pixels)
            if (codec.GetPixels(info, (IntPtr)to) != SKCodecResult.Success) return null;
        return new Raster(pixels, info.Width, info.Height);
    }

#if DECODER_CANDIDATES
    static Raster ImageSharp(byte[] file)
    {
        using var image = Image.Load<Rgba32>(file);
        var pixels = new byte[image.Width * image.Height * 4];
        image.CopyPixelDataTo(pixels);
        return new Raster(pixels, image.Width, image.Height);
    }
#endif

    /// <summary>The native libraries in native/out/, loaded on first use and resolved by name.</summary>
    static class Native
    {
        /// <summary>The first `native/out/` above the binary (engines/dotnet/native/out).</summary>
        static string? Locate(string file)
        {
            for (var at = new DirectoryInfo(AppContext.BaseDirectory); at is not null; at = at.Parent)
            {
                var candidate = Path.Combine(at.FullName, "native", "out", file);
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }

        static readonly Dictionary<string, SpngLib> Spngs = [];

        public static SpngLib Spng(string file)
        {
            lock (Spngs)
            {
                if (!Spngs.TryGetValue(file, out var lib)) Spngs[file] = lib = new SpngLib(Locate(file), file);
                return lib;
            }
        }

        public static readonly WuffsLib Wuffs = new(Locate("libwuffs-png.so"));

        static string NotBuilt(string file) => $"{file} is not built (run engines/dotnet/native/build.sh)";

        /// <summary>libspng's decode-to-buffer API: SPNG_FMT_RGBA8 with tRNS applied and no gamma, as stb decodes.</summary>
        public sealed class SpngLib
        {
            const int FmtRgba8 = 1, DecodeTrns = 1;
            readonly delegate* unmanaged<int, IntPtr> ctxNew;
            readonly delegate* unmanaged<IntPtr, void> ctxFree;
            readonly delegate* unmanaged<IntPtr, byte*, nuint, int> setBuffer;
            readonly delegate* unmanaged<IntPtr, uint*, int> getIhdr;
            readonly delegate* unmanaged<IntPtr, int, nuint*, int> imageSize;
            readonly delegate* unmanaged<IntPtr, byte*, nuint, int, int, int> decode;
            public string? Missing { get; }

            public SpngLib(string? path, string file)
            {
                if (path is null)
                {
                    Missing = NotBuilt(file);
                    return;
                }
                var lib = NativeLibrary.Load(path);
                ctxNew = (delegate* unmanaged<int, IntPtr>)NativeLibrary.GetExport(lib, "spng_ctx_new");
                ctxFree = (delegate* unmanaged<IntPtr, void>)NativeLibrary.GetExport(lib, "spng_ctx_free");
                setBuffer = (delegate* unmanaged<IntPtr, byte*, nuint, int>)NativeLibrary.GetExport(lib, "spng_set_png_buffer");
                getIhdr = (delegate* unmanaged<IntPtr, uint*, int>)NativeLibrary.GetExport(lib, "spng_get_ihdr");
                imageSize = (delegate* unmanaged<IntPtr, int, nuint*, int>)NativeLibrary.GetExport(lib, "spng_decoded_image_size");
                decode = (delegate* unmanaged<IntPtr, byte*, nuint, int, int, int>)NativeLibrary.GetExport(lib, "spng_decode_image");
            }

            public Raster? Decode(byte[] file)
            {
                if (Missing is not null) throw new ArgumentException(Missing);
                var ctx = ctxNew(0);
                if (ctx == IntPtr.Zero) return null;
                try
                {
                    fixed (byte* source = file)
                    {
                        if (setBuffer(ctx, source, (nuint)file.Length) != 0) return null;
                        // struct spng_ihdr: width, height (uint32), then five bytes; four uints cover it.
                        var ihdr = stackalloc uint[4];
                        nuint size;
                        if (getIhdr(ctx, ihdr) != 0 || imageSize(ctx, FmtRgba8, &size) != 0) return null;
                        var pixels = new byte[(int)size];
                        fixed (byte* to = pixels)
                            if (decode(ctx, to, size, FmtRgba8, DecodeTrns) != 0) return null;
                        return new Raster(pixels, (int)ihdr[0], (int)ihdr[1]);
                    }
                }
                finally
                {
                    ctxFree(ctx);
                }
            }
        }

        /// <summary>`wuffs-shim.c`: the PNG's size, then a decode into a buffer of that size.</summary>
        public sealed class WuffsLib
        {
            readonly delegate* unmanaged<byte*, nuint, uint*, uint*, int> size;
            readonly delegate* unmanaged<byte*, nuint, byte*, nuint, int> decode;
            public string? Missing { get; }

            public WuffsLib(string? path)
            {
                if (path is null)
                {
                    Missing = NotBuilt("libwuffs-png.so");
                    return;
                }
                var lib = NativeLibrary.Load(path);
                size = (delegate* unmanaged<byte*, nuint, uint*, uint*, int>)NativeLibrary.GetExport(lib, "ps_wuffs_png_size");
                decode = (delegate* unmanaged<byte*, nuint, byte*, nuint, int>)NativeLibrary.GetExport(lib, "ps_wuffs_png_rgba");
            }

            public Raster? Decode(byte[] file)
            {
                if (Missing is not null) throw new ArgumentException(Missing);
                fixed (byte* source = file)
                {
                    uint width, height;
                    if (size(source, (nuint)file.Length, &width, &height) != 0) return null;
                    var pixels = new byte[checked((int)(width * height * 4))];
                    fixed (byte* to = pixels)
                        if (decode(source, (nuint)file.Length, to, (nuint)pixels.Length) != 0) return null;
                    return new Raster(pixels, (int)width, (int)height);
                }
            }
        }
    }
}
