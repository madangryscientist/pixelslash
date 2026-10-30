using System.Buffers.Binary;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using StbImageSharp;

namespace PixelSlash.Diff;

/// <summary>
/// Where a decode spent its time, in ms. `Read` is the file read, `Inflate` the zlib stream, `Unfilter`
/// the per-row PNG filters, `Other` the rest (chunk walk, copying out, RGB to RGBA). `Split` is false
/// when the PNG was outside what the timed path takes and the whole decode went through StbImageSharp
/// unsplit: only `Read` and `Other` are then set.
/// </summary>
public readonly record struct DecodeTimes(double Read, double Inflate, double Unfilter, double Other, bool Split)
{
    public double Total => Read + Inflate + Unfilter + Other;

    public static DecodeTimes operator +(DecodeTimes a, DecodeTimes b) =>
        new(a.Read + b.Read, a.Inflate + b.Inflate, a.Unfilter + b.Unfilter, a.Other + b.Other, a.Split && b.Split);
}

/// <summary>
/// StbImageSharp's PNG decode with its boundaries timed (ob 1932). `ImageResult.FromMemory` is one
/// call, so this takes the same steps stb takes, through stb's own code: the chunk walk is ours (a
/// few lines), the zlib stream goes through the public `StbImage.stbi_zlib_decode_malloc_guesssize_headerflag`,
/// and the row filters through `StbImage.stbi__create_png_image_raw`, which stb made public but whose
/// first parameter is an internal type, so it is called by reflection. Only what the corpora hold is
/// taken (8-bit, not interlaced, RGB or RGBA, no tRNS); anything else falls back to
/// `ImageResult.FromMemory` and says it did not split. The decoder is not swapped: a test holds the
/// output byte-identical to `FromMemory`.
/// </summary>
public static unsafe class PngDecode
{
    static readonly byte[] Signature = [0x89, (byte)'P', (byte)'N', (byte)'G', 0x0D, 0x0A, 0x1A, 0x0A];

    /// <summary>StbImageSharp's private members, resolved on first use: if a package bump moves one,
    /// the type initialiser throws and <see cref="Read"/> falls back to the unsplit decode.</summary>
    static class Stb
    {
        internal static readonly Type PngType = typeof(StbImage).GetNestedType("stbi__png", BindingFlags.NonPublic | BindingFlags.Public)!;
        internal static readonly Type ContextType = typeof(StbImage).Assembly.GetType("StbImageSharp.StbImage+stbi__context")
            ?? typeof(StbImage).Assembly.GetTypes().First(t => t.Name == "stbi__context");
        internal static readonly FieldInfo OutField = PngType.GetField("_out_")!;
        internal static readonly FieldInfo ContextField = PngType.GetField("s")!;
        internal static readonly FieldInfo ImgN = ContextType.GetField("img_n")!;
        internal static readonly FieldInfo ImgOutN = ContextType.GetField("img_out_n")!;
        internal static readonly FieldInfo ImgX = ContextType.GetField("img_x")!;
        internal static readonly FieldInfo ImgY = ContextType.GetField("img_y")!;
        internal static readonly ConstructorInfo ContextCtor = ContextType.GetConstructor([typeof(Stream)])!;
        internal static readonly MethodInfo UnfilterRaw = typeof(StbImage).GetMethod("stbi__create_png_image_raw")!;
    }

    static double Ms(long from, long to) => (to - from) * 1000.0 / Stopwatch.Frequency;

    /// <summary>Read and decode a PNG to 8-bit RGBA, timing the parts of it.</summary>
    public static (Raster Image, DecodeTimes Times) Read(string path)
    {
        var started = Stopwatch.GetTimestamp();
        var file = File.ReadAllBytes(path);
        var read = Stopwatch.GetTimestamp();
        var thin = TrySplit(file, read);
        if (thin is { } done) return (done.Image, done.Times with { Read = Ms(started, read) });
        var image = ImageResult.FromMemory(file, ColorComponents.RedGreenBlueAlpha)
            ?? throw new InvalidDataException($"cannot decode {path}");
        var end = Stopwatch.GetTimestamp();
        return (new Raster(image.Data, image.Width, image.Height), new DecodeTimes(Ms(started, read), 0, 0, Ms(read, end), false));
    }

    static (Raster Image, DecodeTimes Times)? TrySplit(byte[] file, long begun)
    {
        try
        {
            return Split(file, begun);
        }
        catch (TypeInitializationException)
        {
            // StbImageSharp moved a private member: decode without the split, which stays correct.
            return null;
        }
    }

    static (Raster Image, DecodeTimes Times)? Split(byte[] file, long begun)
    {
        if (file.Length < 8 || !file.AsSpan(0, 8).SequenceEqual(Signature)) return null;
        int width = 0, height = 0, colour = -1, idatLength = 0;
        var idat = new List<(int At, int Length)>();
        for (var at = 8; at + 12 <= file.Length;)
        {
            var length = (int)BinaryPrimitives.ReadUInt32BigEndian(file.AsSpan(at, 4));
            var type = System.Text.Encoding.ASCII.GetString(file, at + 4, 4);
            if (length < 0 || at + 12L + length > file.Length) return null;
            var body = at + 8;
            switch (type)
            {
                case "IHDR":
                    if (length != 13) return null;
                    width = (int)BinaryPrimitives.ReadUInt32BigEndian(file.AsSpan(body, 4));
                    height = (int)BinaryPrimitives.ReadUInt32BigEndian(file.AsSpan(body + 4, 4));
                    // 8-bit, deflate, filter method 0, not interlaced; colour type 2 (RGB) or 6 (RGBA).
                    if (file[body + 8] != 8 || file[body + 10] != 0 || file[body + 11] != 0 || file[body + 12] != 0) return null;
                    colour = file[body + 9];
                    if (colour != 2 && colour != 6) return null;
                    break;
                case "IDAT":
                    idat.Add((body, length));
                    idatLength += length;
                    break;
                case "tRNS" or "CgBI":
                    return null;
            }
            if (type == "IEND") break;
            at += 12 + length;
        }
        if (width <= 0 || height <= 0 || colour < 0 || idat.Count == 0) return null;

        var stream = new byte[idatLength];
        for (int i = 0, to = 0; i < idat.Count; to += idat[i].Length, i++)
            Buffer.BlockCopy(file, idat[i].At, stream, to, idat[i].Length);
        var channels = colour == 6 ? 4 : 3;
        var walked = Stopwatch.GetTimestamp();

        sbyte* inflated;
        int inflatedLength;
        fixed (byte* source = stream)
            inflated = StbImage.stbi_zlib_decode_malloc_guesssize_headerflag((sbyte*)source, stream.Length, (width * channels + 1) * height, &inflatedLength, 1);
        if (inflated == null) return null;
        var inflatedAt = Stopwatch.GetTimestamp();
        try
        {
            var context = Stb.ContextCtor.Invoke([new MemoryStream(0)]);
            Stb.ImgN.SetValue(context, channels);
            Stb.ImgOutN.SetValue(context, channels);
            Stb.ImgX.SetValue(context, (uint)width);
            Stb.ImgY.SetValue(context, (uint)height);
            var png = Activator.CreateInstance(Stb.PngType)!;
            Stb.ContextField.SetValue(png, context);
            var ok = (int)Stb.UnfilterRaw.Invoke(null, [png, Pointer.Box(inflated, typeof(byte*)), (uint)inflatedLength, channels, (uint)width, (uint)height, 8, colour])!;
            if (ok == 0) return null;
            var rows = (byte*)Pointer.Unbox(Stb.OutField.GetValue(png)!);
            var unfilteredAt = Stopwatch.GetTimestamp();
            var data = new byte[width * height * 4];
            var pixels = width * height;
            if (channels == 4)
                new ReadOnlySpan<byte>(rows, pixels * 4).CopyTo(data);
            else
                for (int i = 0, o = 0; i < pixels; i++, o += 4)
                    (data[o], data[o + 1], data[o + 2], data[o + 3]) = (rows[i * 3], rows[i * 3 + 1], rows[i * 3 + 2], 255);
            Marshal.FreeHGlobal((IntPtr)rows);
            var end = Stopwatch.GetTimestamp();
            return (new Raster(data, width, height),
                new DecodeTimes(0, Ms(walked, inflatedAt), Ms(inflatedAt, unfilteredAt), Ms(begun, walked) + Ms(unfilteredAt, end), true));
        }
        finally
        {
            Marshal.FreeHGlobal((IntPtr)inflated);
        }
    }
}
