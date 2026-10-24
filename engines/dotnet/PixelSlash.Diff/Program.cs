// The diff contract (bench/README.md, "The diff contract") in C#:
//
//   PixelSlash.Diff diff <base.png> <head.png> --json
//
// One JSON object on stdout. decode_ms is reading and decoding both PNGs, diff_ms is the rest,
// both on this process's clock, so runtime start-up is in neither. Exit 2 on bad usage, 1 when a
// file cannot be read or decoded.
using System.Diagnostics;
using System.Globalization;
using System.Text;
using PixelSlash.Diff;
using StbImageSharp;

const string Usage = "usage: PixelSlash.Diff diff <base.png> <head.png> --json";

if (args is not ["diff", var basePath, var headPath, "--json"])
{
    Console.Error.WriteLine(Usage);
    return 2;
}

Raster baseImage, headImage;
var clock = Stopwatch.StartNew();
try
{
    baseImage = Contract.Decode(basePath);
    headImage = Contract.Decode(headPath);
}
catch (Exception e)
{
    Console.Error.WriteLine($"PixelSlash.Diff: {e.Message}");
    return 1;
}
var decodeMs = clock.Elapsed.TotalMilliseconds;
clock.Restart();
var result = PixelDiff.Run(baseImage, headImage);
var diffMs = clock.Elapsed.TotalMilliseconds;

Console.Out.Write(Contract.Json(result, decodeMs, diffMs));
Console.Out.Write('\n');
return 0;

namespace PixelSlash.Diff
{
    public static class Contract
    {
        /// <summary>Read and decode a PNG to 8-bit RGBA; throws when it cannot.</summary>
        public static Raster Decode(string path)
        {
            var image = ImageResult.FromMemory(File.ReadAllBytes(path), ColorComponents.RedGreenBlueAlpha)
                ?? throw new InvalidDataException($"cannot decode {path}");
            return new Raster(image.Data, image.Width, image.Height);
        }

        /// <summary>The contract's object: only `change` regions, as bench/src/pixelslash.ts reports them.</summary>
        public static string Json(DiffResult result, double decodeMs, double diffMs)
        {
            var inv = CultureInfo.InvariantCulture;
            var regions = result.Regions.Where(r => r.Kind == RegionKind.Change);
            var sb = new StringBuilder();
            sb.Append("{\"verdict\":\"").Append(result.Changed ? "changed" : "unchanged").Append("\",\"regions\":[");
            sb.AppendJoin(',', regions.Select(r => string.Create(inv, $"{{\"x\":{r.X},\"y\":{r.Y},\"w\":{r.W},\"h\":{r.H}}}")));
            sb.Append(inv, $"],\"decode_ms\":{decodeMs:0.###},\"diff_ms\":{diffMs:0.###}}}");
            return sb.ToString();
        }
    }
}
