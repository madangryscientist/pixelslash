import { describe, expect, test } from "vitest";
import { renderCompareIndex, type CompareRow } from "../src/compare-report.ts";

function row(name: string, over: Partial<CompareRow> = {}): CompareRow {
  return {
    name,
    shot: "chromium 800x400",
    report: undefined,
    changedPixels: 0,
    mismatch: [],
    key: `${name} / chromium / 800x400`,
    regions: [],
    ...over,
  };
}

const none = { changed: [], unchanged: [], added: [], removed: [], mismatched: [] };

/** The counts line is the one `<p>` that carries `unchanged`. */
function countsLine(html: string): string {
  const m = /<p>(\d+ changed · [^<]*)<\/p>/.exec(html);
  if (!m?.[1]) throw new Error("no counts line in the index");
  return m[1];
}

/** The `<section>` under a heading, or "" when the index has none. */
function section(html: string, heading: string): string {
  const m = new RegExp(`<section><h2>${heading} \\(\\d+\\)</h2>[\\s\\S]*?</section>`).exec(html);
  return m?.[0] ?? "";
}

describe("renderCompareIndex counts", () => {
  test("the counts line is the length of each row array it was given", () => {
    const html = renderCompareIndex({
      ...none,
      changed: [row("a", { changedPixels: 10 }), row("b", { changedPixels: 3 })],
      unchanged: [row("c"), row("d"), row("e")],
      added: [row("f")],
      removed: [row("g"), row("h")],
    });
    expect(countsLine(html)).toBe("2 changed · 3 unchanged · 1 new · 2 removed");
  });

  test("an empty compare says zero for each, and prints no other count", () => {
    const html = renderCompareIndex(none);
    expect(countsLine(html)).toBe("0 changed · 0 unchanged · 0 new · 0 removed");
    expect(html).not.toContain("not compared");
    expect(html).not.toMatch(/<h2>/);
  });

  test("`not compared` is on the line only when failed has rows", () => {
    expect(countsLine(renderCompareIndex({ ...none, failed: [] }))).not.toContain("not compared");
    const html = renderCompareIndex({
      ...none,
      changed: [row("a")],
      failed: [row("x", { error: "boom" }), row("y", { error: "bang" })],
    });
    expect(countsLine(html)).toBe("1 changed · 0 unchanged · 0 new · 0 removed · 2 not compared");
  });

  test("each section heading carries the count of its own rows", () => {
    const html = renderCompareIndex({
      ...none,
      changed: [row("a")],
      unchanged: [row("b"), row("c")],
      added: [row("d"), row("e"), row("f")],
      removed: [row("g")],
      failed: [row("h", { error: "e" })],
    });
    expect(html).toContain("<h2>Changed (1)</h2>");
    expect(html).toContain("<h2>Unchanged (2)</h2>");
    expect(html).toContain("<h2>New on Branch (3)</h2>");
    expect(html).toContain("<h2>Removed from Branch (1)</h2>");
    expect(html).toContain("<h2>Not compared (1)</h2>");
    expect(countsLine(html)).toBe("1 changed · 2 unchanged · 3 new · 1 removed · 1 not compared");
  });

  test("a count that was not passed in is never printed: only the given sections exist", () => {
    const html = renderCompareIndex({ ...none, unchanged: [row("a")] });
    expect(countsLine(html)).toBe("0 changed · 1 unchanged · 0 new · 0 removed");
    for (const heading of ["Changed", "New on Branch", "Removed from Branch", "Not compared"]) {
      expect(html).not.toContain(`<h2>${heading}`);
    }
    expect(html).not.toContain('class="names"');
  });
});

describe("renderCompareIndex fingerprint warning", () => {
  test("is absent when nothing is mismatched", () => {
    const html = renderCompareIndex({ ...none, changed: [row("a")], unchanged: [row("b")] });
    expect(html).not.toContain('class="warn"');
    expect(html).not.toContain("different environments");
  });

  test("a row's own mismatch does not raise it: only the `mismatched` array does", () => {
    const html = renderCompareIndex({
      ...none,
      changed: [row("a", { mismatch: ["fonts"] })],
    });
    expect(html).not.toContain("different environments");
  });

  test("names each mismatched shot with its fields, and counts them", () => {
    const html = renderCompareIndex({
      ...none,
      changed: [row("home"), row("pricing")],
      mismatched: [
        row("home", { mismatch: ["fonts", "browser"] }),
        row("pricing", { mismatch: ["image"] }),
      ],
    });
    expect(html).toContain("different environments for 2 snapshots:");
    expect(html).toContain("home (fonts, browser); pricing (image)");
  });

  test("one mismatched shot says snapshot, not snapshots", () => {
    const html = renderCompareIndex({
      ...none,
      mismatched: [row("home", { mismatch: ["fonts"] })],
    });
    expect(html).toContain("different environments for 1 snapshot:");
  });

  test("escapes a shot name in the warning", () => {
    const html = renderCompareIndex({
      ...none,
      mismatched: [row("<img src=x>", { mismatch: ["fonts"] })],
    });
    expect(html).toContain("&lt;img src=x&gt; (fonts)");
    expect(html).not.toContain("<img src=x>");
  });
});

describe("renderCompareIndex not compared", () => {
  const html = renderCompareIndex({
    ...none,
    changed: [row("moved", { changedPixels: 12 })],
    unchanged: [row("same")],
    failed: [row("broken", { error: "diff blew up" })],
  });

  test("a failed row is listed under Not compared with its error", () => {
    const failed = section(html, "Not compared");
    expect(failed).toContain("broken");
    expect(failed).toContain('<span class="warn">diff blew up</span>');
  });

  test("and is in neither Changed nor Unchanged", () => {
    expect(section(html, "Changed")).not.toContain("broken");
    expect(section(html, "Unchanged")).not.toContain("broken");
    expect(section(html, "Changed")).toContain("moved");
    expect(section(html, "Unchanged")).toContain("same");
  });

  test("the top list of changes does not name it", () => {
    const nav = /<nav class="names">[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    expect(nav).toContain("moved");
    expect(nav).not.toContain("broken");
  });

  test("its error is escaped", () => {
    const out = renderCompareIndex({
      ...none,
      failed: [row("broken", { error: "<script>alert(1)</script> & more" })],
    });
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
    expect(out).not.toContain("<script>");
  });

  test("a failed row with no error prints an empty warning, not the word undefined", () => {
    const out = renderCompareIndex({ ...none, failed: [row("broken")] });
    expect(out).toContain('<span class="warn"></span>');
    expect(out).not.toContain("undefined");
  });
});

describe("renderCompareIndex escaping", () => {
  const hostile = `<b>"x"</b> & <script>1</script>`;
  const escaped = "&lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; &lt;script&gt;1&lt;/script&gt;";

  test("the title is escaped in <title> and <h1>", () => {
    const html = renderCompareIndex({ ...none, title: hostile });
    expect(html).toContain(`<title>${escaped}</title>`);
    expect(html).toContain(`<h1>${escaped}</h1>`);
    expect(html).not.toContain("<script>");
  });

  test("the default title is used without one", () => {
    expect(renderCompareIndex(none)).toContain("<title>PixelSlash compare</title>");
  });

  test("the note is escaped", () => {
    const html = renderCompareIndex({ ...none, note: hostile });
    expect(html).toContain(`<p>${escaped}</p>`);
    expect(html).not.toContain("<script>");
  });

  test("no note prints no note paragraph", () => {
    expect(renderCompareIndex(none)).not.toMatch(/<p><\/p>/);
  });

  test("a row's name and shot are escaped wherever they are listed", () => {
    const html = renderCompareIndex({
      ...none,
      changed: [row(hostile, { shot: hostile, changedPixels: 1 })],
      unchanged: [row(hostile, { shot: hostile, key: "other" })],
    });
    expect(html).toContain(escaped);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
  });

  test("a report link and the flake link are escaped in their attributes", () => {
    const html = renderCompareIndex({
      ...none,
      changed: [row("a", { report: `r"><i>.html`, changedPixels: 1 })],
      flakes: `f"><i>.html`,
    });
    expect(html).toContain('href="r&quot;&gt;&lt;i&gt;.html"');
    expect(html).toContain('href="f&quot;&gt;&lt;i&gt;.html"');
    expect(html).not.toContain("<i>");
  });
});
