// The diff contract (bench/README.md, "The diff contract") in C#:
//
//   PixelSlash.Diff diff <base.png> <head.png> --json [--decode parallel|sequential]
//
// One JSON object on stdout. decode_ms is reading and decoding both PNGs, diff_ms is the rest,
// both on this process's clock, so runtime start-up is in neither; `phases` splits them (ob 1932)
// and `startup_ms` is the time from the harness's spawn to this line. Exit 2 on bad usage, 1 when
// a file cannot be read or decoded.
using System.Diagnostics;
using System.Globalization;
using System.Text;
using PixelSlash.Diff;
using StbImageSharp;

var startedAt = Contract.EpochMs();
const string Usage = "usage: PixelSlash.Diff diff <base.png> <head.png> --json [--decode parallel|sequential]";

if (!Contract.TryParse(args, out var basePath, out var headPath, out var parallel))
{
    Console.Error.WriteLine(Usage);
    return 2;
}

Raster baseImage, headImage;
DecodeTimes decodeTimes;
var clock = Stopwatch.StartNew();
try
{
    if (parallel)
    {
        // Both files at once; the split below is then summed work, while decode_ms is the wall.
        var pair = Task.WhenAll(Task.Run(() => PngDecode.Read(basePath)), Task.Run(() => PngDecode.Read(headPath))).GetAwaiter().GetResult();
        (baseImage, headImage) = (pair[0].Image, pair[1].Image);
        decodeTimes = pair[0].Times + pair[1].Times;
    }
    else
    {
        var (b, bt) = PngDecode.Read(basePath);
        var (h, ht) = PngDecode.Read(headPath);
        (baseImage, headImage, decodeTimes) = (b, h, bt + ht);
    }
}
catch (Exception e)
{
    Console.Error.WriteLine($"PixelSlash.Diff: {e.Message}");
    return 1;
}
var decodeMs = clock.Elapsed.TotalMilliseconds;
clock.Restart();
var phases = new DiffPhases();
var result = PixelDiff.Run(baseImage, headImage, phases: phases);
var diffMs = clock.Elapsed.TotalMilliseconds;

Console.Out.Write(Contract.Json(result, decodeMs, diffMs, Contract.PhaseMap(decodeTimes, phases), Contract.StartupMs(startedAt)));
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

        /// <summary>Milliseconds since the Unix epoch on the wall clock, with sub-ms resolution: the clock the harness stamps the spawn with.</summary>
        public static double EpochMs() => (DateTime.UtcNow - DateTime.UnixEpoch).TotalMilliseconds;

        /// <summary>The harness's spawn stamp (PS_BENCH_SPAWN_AT, epoch ms); absent when run by hand.</summary>
        public static double? StartupMs(double startedAt) =>
            double.TryParse(Environment.GetEnvironmentVariable("PS_BENCH_SPAWN_AT"), NumberStyles.Float, CultureInfo.InvariantCulture, out var spawned)
                ? Math.Max(0, startedAt - spawned)
                : null;

        /// <summary>`diff base head --json`, then optionally `--decode parallel|sequential`.</summary>
        public static bool TryParse(string[] args, out string basePath, out string headPath, out bool parallel)
        {
            (basePath, headPath, parallel) = ("", "", false);
            if (args is not ["diff", var b, var h, "--json", .. var rest]) return false;
            (basePath, headPath) = (b, h);
            switch (rest)
            {
                case []:
                case ["--decode", "sequential"]:
                    return true;
                case ["--decode", "parallel"]:
                    parallel = true;
                    return true;
                default:
                    return false;
            }
        }

        /// <summary>Every phase, named as in the contract. The inflate and unfilter ones are left out when the PNG could not be split.</summary>
        public static IReadOnlyDictionary<string, double> PhaseMap(DecodeTimes decode, DiffPhases diff)
        {
            var phases = new Dictionary<string, double> { ["decode_read"] = decode.Read, ["decode_other"] = decode.Other };
            if (decode.Split)
            {
                phases["decode_inflate"] = decode.Inflate;
                phases["decode_unfilter"] = decode.Unfilter;
            }
            phases["pixel_compare"] = diff.PixelCompare;
            phases["anti_alias"] = diff.AntiAlias;
            phases["regions"] = diff.Regions;
            return phases;
        }

        /// <summary>The contract's object: only `change` regions, as bench/src/pixelslash.ts reports them.</summary>
        public static string Json(DiffResult result, double decodeMs, double diffMs, IReadOnlyDictionary<string, double>? phases = null, double? startupMs = null)
        {
            var inv = CultureInfo.InvariantCulture;
            var regions = result.Regions.Where(r => r.Kind == RegionKind.Change);
            var sb = new StringBuilder();
            sb.Append("{\"verdict\":\"").Append(result.Changed ? "changed" : "unchanged").Append("\",\"regions\":[");
            sb.AppendJoin(',', regions.Select(r => string.Create(inv, $"{{\"x\":{r.X},\"y\":{r.Y},\"w\":{r.W},\"h\":{r.H}}}")));
            sb.Append(inv, $"],\"decode_ms\":{decodeMs:0.###},\"diff_ms\":{diffMs:0.###}");
            if (startupMs is { } startup) sb.Append(inv, $",\"startup_ms\":{startup:0.###}");
            if (phases is not null)
            {
                sb.Append(",\"phases\":{");
                sb.AppendJoin(',', phases.Select(p => string.Create(inv, $"\"{p.Key}\":{p.Value:0.###}")));
                sb.Append('}');
            }
            sb.Append('}');
            return sb.ToString();
        }
    }
}
