using System.Diagnostics;

namespace PixelSlash.Diff;

/// <summary>Decoded RGBA, 8 bits a channel, rows top to bottom.</summary>
public sealed record Raster(byte[] Data, int Width, int Height);

/// <summary>What the contract asks for: the verdict and the boxes of the `change` regions.</summary>
public sealed record DiffResult(bool Changed, IReadOnlyList<Region> Regions, int ChangedPixels, int Antialiased);

/// <summary>
/// Where a diff spent its time, in ms (ob 1932): the YIQ threshold loop without the anti-alias test,
/// the anti-alias test, and the region grouping with the speck, noise and shift rules. There is no
/// overlay image, so no overlay_encode phase.
/// </summary>
public sealed class DiffPhases
{
    public double PixelCompare;
    public double AntiAlias;
    public double Regions;
}

/// <summary>
/// The pixel diff of packages/engine/src/diff.ts at its defaults: YIQ distance with alpha over
/// white, anti-aliased edges set aside, only the overlapping rectangle measured (invariant 1), and
/// a size mismatch always `changed`. Ignore areas and the overlay image are not ported: the
/// contract asks for neither.
/// </summary>
public static class PixelDiff
{
    /// <summary>The engine's DEFAULT_THRESHOLD.</summary>
    public const double DefaultThreshold = 0.01;

    /// <summary>Largest YIQ delta (squared, weighted) between black and white.</summary>
    public const double MaxYiqDelta = 35215;

    /// <param name="phases">When given, filled with the time of each phase; null costs one check per pixel that reaches the anti-alias test.</param>
    public static DiffResult Run(Raster a, Raster b, double threshold = DefaultThreshold, DiffPhases? phases = null)
    {
        var loopStarted = phases is null ? 0 : Stopwatch.GetTimestamp();
        long antialiasTicks = 0;
        var width = Math.Min(a.Width, b.Width);
        var height = Math.Min(a.Height, b.Height);
        var field = new DiffField(width, height);
        var maxDelta = MaxYiqDelta * threshold * threshold;
        var changedPixels = 0;
        var antialiased = 0;
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var at = y * width + x;
                var delta = ColourDelta(a.Data, (y * a.Width + x) << 2, b.Data, (y * b.Width + x) << 2);
                if (Math.Abs(delta) <= maxDelta) continue;
                bool edge;
                if (phases is null)
                {
                    edge = IsAntialiased(a, x, y, b) || IsAntialiased(b, x, y, a);
                }
                else
                {
                    var started = Stopwatch.GetTimestamp();
                    edge = IsAntialiased(a, x, y, b) || IsAntialiased(b, x, y, a);
                    antialiasTicks += Stopwatch.GetTimestamp() - started;
                }
                if (edge)
                {
                    field.Kind[at] = DiffField.Antialiased;
                    antialiased++;
                    continue;
                }
                field.Kind[at] = DiffField.Changed;
                field.Amplitude[at] = (byte)Math.Min(255, RoundHalfUp(Math.Sqrt(Math.Abs(delta) / MaxYiqDelta) * 255));
                field.Lighter[at] = (byte)(delta < 0 ? 1 : 0);
                changedPixels++;
            }
        }

        var regionsStarted = phases is null ? 0 : Stopwatch.GetTimestamp();
        if (phases is not null)
        {
            var loopTicks = regionsStarted - loopStarted;
            phases.AntiAlias = antialiasTicks * 1000.0 / Stopwatch.Frequency;
            phases.PixelCompare = (loopTicks - antialiasTicks) * 1000.0 / Stopwatch.Frequency;
        }
        var regions = Regions.Find(field);
        var sizeChanged = a.Width != b.Width || a.Height != b.Height;
        if (!sizeChanged) regions = Shift.Label(regions, a, b, maxDelta);
        var surviving = regions.Where(r => r.Kind == RegionKind.Change).Sum(r => r.ChangedPixels);
        if (phases is not null) phases.Regions = (Stopwatch.GetTimestamp() - regionsStarted) * 1000.0 / Stopwatch.Frequency;
        return new DiffResult(sizeChanged || surviving > 0, regions, changedPixels, antialiased);
    }

    /// <summary>JavaScript's Math.round for the non-negative values used here (C# rounds half to even).</summary>
    static int RoundHalfUp(double v) => (int)Math.Floor(v + 0.5);

    static double Luma(byte[] d, int i, out double inPhase, out double quadrature)
    {
        double r = d[i];
        double g = d[i + 1];
        double b = d[i + 2];
        var alpha = d[i + 3] / 255.0;
        if (alpha < 1)
        {
            r = 255 + (r - 255) * alpha;
            g = 255 + (g - 255) * alpha;
            b = 255 + (b - 255) * alpha;
        }
        inPhase = r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
        quadrature = r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
        return r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
    }

    static double Luma(byte[] d, int i) => Luma(d, i, out _, out _);

    /// <summary>Perceptual distance between two pixels, signed: negative when `b` is the lighter one.</summary>
    public static double ColourDelta(byte[] a, int ia, byte[] b, int ib)
    {
        if (a[ia] == b[ib] && a[ia + 1] == b[ib + 1] && a[ia + 2] == b[ib + 2] && a[ia + 3] == b[ib + 3]) return 0;
        var ya = Luma(a, ia, out var ia_, out var qa);
        var yb = Luma(b, ib, out var ib_, out var qb);
        var dy = ya - yb;
        var di = ia_ - ib_;
        var dq = qa - qb;
        var delta = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
        return dy > 0 ? -delta : delta;
    }

    static bool SameRgba(byte[] d, int a, int b) =>
        d[a] == d[b] && d[a + 1] == d[b + 1] && d[a + 2] == d[b + 2] && d[a + 3] == d[b + 3];

    /// <summary>More than two of the 8 neighbours share the pixel's exact colour: it sits in a flat area.</summary>
    static bool HasManySiblings(Raster img, int x, int y)
    {
        var at = (y * img.Width + x) << 2;
        // A taller shot's neighbour can lie below a shorter one; TS reads undefined there, which
        // matches no colour, so it has no siblings.
        if (at >= img.Data.Length) return false;
        var same = 0;
        for (var ny = Math.Max(y - 1, 0); ny <= Math.Min(y + 1, img.Height - 1); ny++)
        {
            for (var nx = Math.Max(x - 1, 0); nx <= Math.Min(x + 1, img.Width - 1); nx++)
            {
                if ((nx != x || ny != y) && SameRgba(img.Data, at, (ny * img.Width + nx) << 2)) same++;
            }
        }
        return same > 2;
    }

    /// <summary>
    /// Whether (x, y) is an anti-aliased edge pixel of `img` (Vysniauskas, 2009): neighbours run
    /// both darker and lighter, few match it, and the extreme neighbour is flat in both shots.
    /// </summary>
    static bool IsAntialiased(Raster img, int x, int y, Raster other)
    {
        var centre = (y * img.Width + x) << 2;
        var centreLuma = Luma(img.Data, centre);
        var equal = 0;
        double minDelta = 0, maxDelta = 0;
        int minX = 0, minY = 0, maxX = 0, maxY = 0;
        for (var ny = Math.Max(y - 1, 0); ny <= Math.Min(y + 1, img.Height - 1); ny++)
        {
            for (var nx = Math.Max(x - 1, 0); nx <= Math.Min(x + 1, img.Width - 1); nx++)
            {
                if (nx == x && ny == y) continue;
                var delta = centreLuma - Luma(img.Data, (ny * img.Width + nx) << 2);
                if (delta == 0) equal++;
                else if (delta < minDelta) (minDelta, minX, minY) = (delta, nx, ny);
                else if (delta > maxDelta) (maxDelta, maxX, maxY) = (delta, nx, ny);
            }
        }
        if (equal > 2 || minDelta == 0 || maxDelta == 0) return false;
        return (HasManySiblings(img, minX, minY) && HasManySiblings(other, minX, minY))
            || (HasManySiblings(img, maxX, maxY) && HasManySiblings(other, maxX, maxY));
    }
}
