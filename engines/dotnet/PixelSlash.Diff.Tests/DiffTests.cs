using System.Text.Json;
using PixelSlash.Diff;

namespace PixelSlash.Diff.Tests;

public class DiffTests
{
    /// <summary>A `width` x `height` RGBA raster filled with one opaque colour.</summary>
    static Raster Solid(int width, int height, byte r, byte g, byte b)
    {
        var data = new byte[width * height * 4];
        for (var i = 0; i < data.Length; i += 4) (data[i], data[i + 1], data[i + 2], data[i + 3]) = (r, g, b, 255);
        return new Raster(data, width, height);
    }

    static Raster Paint(Raster img, int x0, int y0, int w, int h, byte r, byte g, byte b)
    {
        var data = (byte[])img.Data.Clone();
        for (var y = y0; y < y0 + h; y++)
            for (var x = x0; x < x0 + w; x++)
                (data[(y * img.Width + x) * 4], data[(y * img.Width + x) * 4 + 1], data[(y * img.Width + x) * 4 + 2]) = (r, g, b);
        return img with { Data = data };
    }

    static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "global.json"))) dir = dir.Parent;
        return dir?.FullName ?? throw new DirectoryNotFoundException("no global.json above the test binary");
    }

    [Fact]
    public void IdenticalShotsAreUnchanged()
    {
        var result = PixelDiff.Run(Solid(40, 30, 250, 250, 250), Solid(40, 30, 250, 250, 250));
        Assert.False(result.Changed);
        Assert.Empty(result.Regions);
    }

    [Fact]
    public void AFilledBlockIsOneChangeRegionAroundIt()
    {
        var main = Solid(64, 48, 255, 255, 255);
        var result = PixelDiff.Run(main, Paint(main, 10, 12, 8, 5, 200, 0, 0));
        Assert.True(result.Changed);
        var region = Assert.Single(result.Regions);
        Assert.Equal((10, 12, 8, 5, RegionKind.Change), (region.X, region.Y, region.W, region.H, region.Kind));
        Assert.Equal(40, region.ChangedPixels);
    }

    [Fact]
    public void ADifferenceUnderTheThresholdIsNotAChange()
    {
        var main = Solid(20, 20, 128, 128, 128);
        var result = PixelDiff.Run(main, Paint(main, 2, 2, 10, 10, 128, 128, 129));
        Assert.False(result.Changed);
        Assert.Equal(0, result.ChangedPixels);
    }

    [Fact]
    public void ASinglePixelIsASpeckNotARegion()
    {
        var main = Solid(20, 20, 255, 255, 255);
        var result = PixelDiff.Run(main, Paint(main, 5, 5, 1, 1, 0, 0, 0));
        Assert.Equal(1, result.ChangedPixels);
        Assert.Empty(result.Regions);
        Assert.False(result.Changed);
    }

    [Fact]
    public void ChangesWithin24PixelsMergeIntoOneBox()
    {
        var main = Solid(100, 40, 255, 255, 255);
        var head = Paint(Paint(main, 5, 5, 4, 4, 0, 0, 0), 30, 5, 4, 4, 0, 0, 0);
        var region = Assert.Single(PixelDiff.Run(main, head).Regions);
        Assert.Equal((5, 5, 29, 4), (region.X, region.Y, region.W, region.H));
    }

    [Fact]
    public void SizeMismatchIsChangedButOnlyTheOverlapIsMeasured()
    {
        // Invariant 1: the extra rows are not painted as changed; the overlap is identical.
        var result = PixelDiff.Run(Solid(30, 20, 255, 255, 255), Solid(30, 26, 255, 255, 255));
        Assert.True(result.Changed);
        Assert.Empty(result.Regions);
        Assert.Equal(0, result.ChangedPixels);
    }

    [Fact]
    public void AShorterShotIsNeverReadPastItsEnd()
    {
        // The anti-alias test reads a neighbour of the taller shot in the shorter one, past its end;
        // TS reads undefined there. Three greys on a shot two rows taller reach it.
        var random = new Random(1910);
        byte[] greys = [0, 128, 255];
        Raster Noise(int width, int height)
        {
            var data = new byte[width * height * 4];
            for (var i = 0; i < data.Length; i += 4)
            {
                var g = greys[random.Next(greys.Length)];
                (data[i], data[i + 1], data[i + 2], data[i + 3]) = (g, g, g, 255);
            }
            return new Raster(data, width, height);
        }
        for (var i = 0; i < 2000; i++)
        {
            var (tall, low) = (Noise(4, 6), Noise(4, 4));
            PixelDiff.Run(tall, low);
            PixelDiff.Run(low, tall);
        }
    }

    [Fact]
    public void ContractJsonHasTheFourFields()
    {
        var main = Solid(64, 48, 255, 255, 255);
        var json = Contract.Json(PixelDiff.Run(main, Paint(main, 10, 12, 8, 5, 0, 0, 0)), 1.5, 2.25);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        Assert.Equal("changed", root.GetProperty("verdict").GetString());
        var box = Assert.Single(root.GetProperty("regions").EnumerateArray().ToList());
        Assert.Equal(10, box.GetProperty("x").GetInt32());
        Assert.Equal(5, box.GetProperty("h").GetInt32());
        Assert.Equal(1.5, root.GetProperty("decode_ms").GetDouble());
        Assert.Equal(2.25, root.GetProperty("diff_ms").GetDouble());
    }

    [Fact]
    public void DecodesARealPngAndFindsNothingAgainstItself()
    {
        var path = Path.Combine(RepoRoot(), "fixtures", "ds", "button.png");
        var image = Contract.Decode(path);
        Assert.Equal(image.Width * image.Height * 4, image.Data.Length);
        Assert.False(PixelDiff.Run(image, Contract.Decode(path)).Changed);
    }
}
