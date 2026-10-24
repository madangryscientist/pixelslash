namespace PixelSlash.Diff;

/// <summary>Per-pixel result of the diff over the overlapping rectangle.</summary>
public sealed class DiffField(int width, int height)
{
    public const byte Changed = 1;
    public const byte Antialiased = 2;

    public int Width { get; } = width;
    public int Height { get; } = height;
    public byte[] Kind { get; } = new byte[width * height];
    /// <summary>Colour distance of a changed pixel, 0 to 255.</summary>
    public byte[] Amplitude { get; } = new byte[width * height];
    /// <summary>1 when Branch is lighter than Main at a changed pixel.</summary>
    public byte[] Lighter { get; } = new byte[width * height];
}

public enum RegionKind { Change, Noise, Shift }

public sealed record Region(int X, int Y, int W, int H, int ChangedPixels, int AntialiasedPixels, RegionKind Kind);

/// <summary>
/// Changed regions as packages/engine/src/regions.ts makes them: changed pixels within 24px form
/// one box, a box under 4px of area is a speck, and a faint, uneven, two-way box is `noise`.
/// </summary>
public static class Regions
{
    public const int MergeDistance = 24;
    public const int MinRegionArea = 4;
    public const double NoiseAmplitude = 0.25;
    const double MinMixedShare = 0.2;
    const double MinAmplitudeSpread = 0.3;

    record struct Box(int X0, int Y0, int X1, int Y1);

    /// <summary>Dilate a mask by `gap` along one axis.</summary>
    static byte[] DilateAxis(byte[] src, int lines, int len, int lineStride, int stride, int gap)
    {
        var output = new byte[src.Length];
        for (var line = 0; line < lines; line++)
        {
            var origin = line * lineStride;
            var last = int.MinValue / 2;
            for (var p = 0; p < len; p++)
            {
                if (src[origin + p * stride] != 0) last = p;
                if (p - last <= gap) output[origin + p * stride] = 1;
            }
            last = int.MaxValue / 2;
            for (var p = len - 1; p >= 0; p--)
            {
                if (src[origin + p * stride] != 0) last = p;
                if (last - p <= gap) output[origin + p * stride] = 1;
            }
        }
        return output;
    }

    static byte[] DilatedChanged(DiffField field, int gap)
    {
        var changed = new byte[field.Kind.Length];
        for (var i = 0; i < changed.Length; i++) changed[i] = field.Kind[i] == DiffField.Changed ? (byte)1 : (byte)0;
        var wide = DilateAxis(changed, field.Height, field.Width, field.Width, 1, gap);
        return DilateAxis(wide, field.Width, field.Height, 1, field.Width, gap);
    }

    /// <summary>Bounding boxes of the changed pixels in each 8-connected blob of `blob`.</summary>
    static List<Box> BlobBoxes(DiffField field, byte[] blob)
    {
        var (width, height) = (field.Width, field.Height);
        var seen = new byte[blob.Length];
        var boxes = new List<Box>();
        var stack = new Stack<int>();
        for (var start = 0; start < blob.Length; start++)
        {
            if (blob[start] == 0 || seen[start] != 0) continue;
            seen[start] = 1;
            stack.Push(start);
            Box? box = null;
            while (stack.Count > 0)
            {
                var at = stack.Pop();
                var x = at % width;
                var y = at / width;
                if (field.Kind[at] == DiffField.Changed)
                    box = box is { } b ? new Box(Math.Min(b.X0, x), Math.Min(b.Y0, y), Math.Max(b.X1, x), Math.Max(b.Y1, y)) : new Box(x, y, x, y);
                for (var ny = Math.Max(y - 1, 0); ny <= Math.Min(y + 1, height - 1); ny++)
                {
                    for (var nx = Math.Max(x - 1, 0); nx <= Math.Min(x + 1, width - 1); nx++)
                    {
                        var next = ny * width + nx;
                        if (blob[next] == 0 || seen[next] != 0) continue;
                        seen[next] = 1;
                        stack.Push(next);
                    }
                }
            }
            if (box is { } found) boxes.Add(found);
        }
        return boxes;
    }

    static bool Near(Box a, Box b, int gap) =>
        a.X0 - gap <= b.X1 && b.X0 - gap <= a.X1 && a.Y0 - gap <= b.Y1 && b.Y0 - gap <= a.Y1;

    /// <summary>Merge boxes that overlap or sit within `gap` of one another, until none do.</summary>
    static List<Box> MergeBoxes(List<Box> boxes, int gap)
    {
        var output = new List<Box>(boxes);
        while (true)
        {
            var merged = false;
            for (var i = 0; i < output.Count && !merged; i++)
            {
                for (var j = i + 1; j < output.Count; j++)
                {
                    if (!Near(output[i], output[j], gap)) continue;
                    var (a, b) = (output[i], output[j]);
                    output[i] = new Box(Math.Min(a.X0, b.X0), Math.Min(a.Y0, b.Y0), Math.Max(a.X1, b.X1), Math.Max(a.Y1, b.Y1));
                    output.RemoveAt(j);
                    merged = true;
                    break;
                }
            }
            if (!merged) return output;
        }
    }

    sealed class BoxStats
    {
        public int ChangedPixels;
        public int AntialiasedPixels;
        public int LighterPixels;
        public readonly int[] Amplitudes = new int[256];
    }

    static BoxStats Stats(DiffField field, Box box)
    {
        var stats = new BoxStats();
        for (var y = box.Y0; y <= box.Y1; y++)
        {
            for (var x = box.X0; x <= box.X1; x++)
            {
                var at = y * field.Width + x;
                var k = field.Kind[at];
                if (k == DiffField.Antialiased) stats.AntialiasedPixels++;
                if (k != DiffField.Changed) continue;
                stats.ChangedPixels++;
                stats.LighterPixels += field.Lighter[at];
                stats.Amplitudes[field.Amplitude[at]]++;
            }
        }
        return stats;
    }

    /// <summary>The amplitude (0 to 255) at or below which `share` of the changed pixels fall.</summary>
    static int AmplitudeAt(BoxStats stats, double share)
    {
        var target = Math.Ceiling(stats.ChangedPixels * share);
        var seen = 0;
        for (var a = 0; a < 256; a++)
        {
            seen += stats.Amplitudes[a];
            if (seen >= target) return a;
        }
        return 255;
    }

    static double AmplitudeSpread(BoxStats stats)
    {
        double sum = 0, sumSquares = 0;
        for (var a = 0; a < 256; a++)
        {
            double n = stats.Amplitudes[a];
            sum += n * a;
            sumSquares += n * a * a;
        }
        var mean = sum / stats.ChangedPixels;
        if (mean == 0) return 0;
        return Math.Sqrt(Math.Max(sumSquares / stats.ChangedPixels - mean * mean, 0)) / mean;
    }

    static bool IsNoise(BoxStats stats)
    {
        if (stats.ChangedPixels == 0) return false;
        if (AmplitudeSpread(stats) < MinAmplitudeSpread) return false;
        var mixed = Math.Min(stats.LighterPixels, stats.ChangedPixels - stats.LighterPixels);
        if ((double)mixed / stats.ChangedPixels < MinMixedShare) return false;
        var limit = NoiseAmplitude * 255;
        return AmplitudeAt(stats, 0.9) <= limit && AmplitudeAt(stats, 1) <= limit * 2;
    }

    /// <summary>The regions of a field, largest first; specks are dropped.</summary>
    public static List<Region> Find(DiffField field)
    {
        var regions = new List<Region>();
        foreach (var box in MergeBoxes(BlobBoxes(field, DilatedChanged(field, MergeDistance)), MergeDistance))
        {
            var w = box.X1 - box.X0 + 1;
            var h = box.Y1 - box.Y0 + 1;
            if (w * h < MinRegionArea) continue;
            var stats = Stats(field, box);
            var kind = IsNoise(stats) ? RegionKind.Noise : RegionKind.Change;
            regions.Add(new Region(box.X0, box.Y0, w, h, stats.ChangedPixels, stats.AntialiasedPixels, kind));
        }
        // OrderByDescending is stable, like Array.prototype.sort.
        return [.. regions.OrderByDescending(r => r.W * r.H)];
    }
}
