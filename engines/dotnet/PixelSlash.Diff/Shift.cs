namespace PixelSlash.Diff;

/// <summary>
/// Shift-aware regions, as packages/engine/src/shift.ts decides them: a `change` region whose
/// content moved a fraction of a pixel, all alike, is relabelled `shift` and does not make the run
/// `changed`. The rule and its four conditions are documented there; the constants are the same.
/// </summary>
public static class Shift
{
    public const double MaxShift = 0.9;
    const double MinShift = 0.2;
    const double MinExplained = 0.25;
    const int Neighbourhood = 24;
    const int Tile = 12;
    const double MinTileEnergy = 2000;
    const int MinTiles = 4;
    const double TileTolerance = 0.35;
    const double MinTileTolerance = 0.1;
    const double MinAgreement = 0.5;
    const double IntegerResidue = 0.1;

    readonly record struct Box(int X0, int Y0, int X1, int Y1);

    readonly record struct Fit(double Sx, double Sy, double Energy, double Explained);

    /// <summary>`change` regions that are a sub-pixel shift become `shift`; equal-size shots only.</summary>
    public static List<Region> Label(List<Region> regions, Raster main, Raster branch, double maxDelta) =>
        [.. regions.Select(r => r.Kind == RegionKind.Change && IsShift(main, branch, maxDelta, r) ? r with { Kind = RegionKind.Shift } : r)];

    /// <summary>Gradient moments of the pair over `box`, then the least-squares shift and what it explains.</summary>
    static Fit FitBox(Raster main, Raster branch, Box box)
    {
        var (width, height) = (main.Width, main.Height);
        int Px(byte[] data, int x, int y, int c) =>
            data[((Math.Clamp(y, 0, height - 1) * width + Math.Clamp(x, 0, width - 1)) << 2) + c];
        double sxx = 0, sxy = 0, syy = 0, sxd = 0, syd = 0, dd = 0;
        var (m, b) = (main.Data, branch.Data);
        for (var y = box.Y0; y < box.Y1; y++)
        {
            for (var x = box.X0; x < box.X1; x++)
            {
                for (var c = 0; c < 3; c++)
                {
                    var gx = (Px(m, x + 1, y, c) + Px(b, x + 1, y, c) - Px(m, x - 1, y, c) - Px(b, x - 1, y, c)) / 4.0;
                    var gy = (Px(m, x, y + 1, c) + Px(b, x, y + 1, c) - Px(m, x, y - 1, c) - Px(b, x, y - 1, c)) / 4.0;
                    double d = Px(b, x, y, c) - Px(m, x, y, c);
                    sxx += gx * gx;
                    sxy += gx * gy;
                    syy += gy * gy;
                    sxd += gx * d;
                    syd += gy * d;
                    dd += d * d;
                }
            }
        }
        var det = sxx * syy - sxy * sxy;
        var energy = sxx + syy;
        if (det < 1e-6 || dd == 0) return new Fit(0, 0, energy, 0);
        var sx = -(syy * sxd - sxy * syd) / det;
        var sy = -(sxx * syd - sxy * sxd) / det;
        var cross = -(sx * sxd + sy * syd);
        var model = sx * sx * sxx + 2 * sx * sy * sxy + sy * sy * syy;
        return new Fit(sx, sy, energy, 1 - (dd - 2 * cross + model) / dd);
    }

    /// <summary>The share of the box's edge energy, by tile, that fits the same shift as the region does.</summary>
    static double? Agreement(Raster main, Raster branch, Box box, Fit own)
    {
        var tolerance = Math.Min(TileTolerance, Math.Max(MinTileTolerance, Math.Max(Math.Abs(own.Sx), Math.Abs(own.Sy)) / 2));
        var tiles = 0;
        double total = 0, agreeing = 0;
        for (var ty = box.Y0; ty < box.Y1; ty += Tile)
        {
            for (var tx = box.X0; tx < box.X1; tx += Tile)
            {
                var t = FitBox(main, branch, new Box(tx, ty, Math.Min(tx + Tile, box.X1), Math.Min(ty + Tile, box.Y1)));
                if (t.Energy < MinTileEnergy) continue;
                tiles++;
                total += t.Energy;
                if (Math.Abs(t.Sx - own.Sx) < tolerance && Math.Abs(t.Sy - own.Sy) < tolerance) agreeing += t.Energy;
            }
        }
        return tiles < MinTiles ? null : agreeing / total;
    }

    /// <summary>Pixels of the box that differ between Main read at (x + dx, y + dy) and Branch at (x, y).</summary>
    static int Differing(Raster main, Raster branch, double maxDelta, Box box, int dx, int dy)
    {
        var n = 0;
        for (var y = box.Y0; y < box.Y1; y++)
        {
            for (var x = box.X0; x < box.X1; x++)
            {
                var (mx, my) = (x + dx, y + dy);
                if (mx < 0 || my < 0 || mx >= main.Width || my >= main.Height) continue;
                var delta = PixelDiff.ColourDelta(main.Data, (my * main.Width + mx) << 2, branch.Data, (y * main.Width + x) << 2);
                if (Math.Abs(delta) > maxDelta) n++;
            }
        }
        return n;
    }

    static bool IsIntegerMove(Raster main, Raster branch, double maxDelta, Box box)
    {
        var unshifted = Differing(main, branch, maxDelta, box, 0, 0);
        if (unshifted == 0) return false;
        (int, int)[] moves = [(1, 0), (-1, 0), (0, 1), (0, -1)];
        return moves.Any(m => Differing(main, branch, maxDelta, box, m.Item1, m.Item2) <= unshifted * IntegerResidue);
    }

    static bool IsShift(Raster main, Raster branch, double maxDelta, Region r)
    {
        var own = new Box(r.X, r.Y, r.X + r.W, r.Y + r.H);
        var grown = new Box(
            Math.Max(0, r.X - Neighbourhood),
            Math.Max(0, r.Y - Neighbourhood),
            Math.Min(main.Width, r.X + r.W + Neighbourhood),
            Math.Min(main.Height, r.Y + r.H + Neighbourhood));
        var fit = FitBox(main, branch, own);
        var reach = Math.Max(Math.Abs(fit.Sx), Math.Abs(fit.Sy));
        if (reach < MinShift || reach > MaxShift || fit.Explained < MinExplained) return false;
        var agrees = Agreement(main, branch, grown, fit);
        if (agrees is not { } share || share < MinAgreement) return false;
        return !IsIntegerMove(main, branch, maxDelta, own);
    }
}
