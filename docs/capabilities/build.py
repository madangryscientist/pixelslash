#!/usr/bin/env python3
"""Render docs/capabilities/matrix.html from data.json.

Run from anywhere:  python3 docs/capabilities/build.py
No dependencies. The page is a single self-contained file (no images, inline data), so it can be
opened as file:// or committed and diffed.
"""
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
DATA = json.loads((HERE / "data.json").read_text())
OUT = HERE / "matrix.html"

TOOLS = DATA["tools"]
COMPETITORS = [t["key"] for t in TOOLS if t["key"] != "ps"]
SCORE = {"y": 2, "p": 1, "n": 0, "?": 0}

rows = DATA["rows"]
for r in rows:
    best = max(SCORE[r["t"][k]] for k in COMPETITORS)
    r["behind"] = SCORE[r["ps"]["v"]] < best
behind = [r for r in rows if r["behind"]]
level = len(rows) - len(behind)

payload = json.dumps({
    "rows": rows,
    "notes": DATA["notes"],
    "src": {t["key"]: t.get("src", "") for t in TOOLS},
    "names": {t["key"]: t["name"] for t in TOOLS},
    "competitors": COMPETITORS,
})

METHOD = DATA["method"].replace("{commit}", f'<code>{DATA["ours_commit"]}</code>').replace("{date}", DATA["updated"])

HEAD_HTML = "".join(
    f'<th class="{"self" if t["key"] == "ps" else ""}" title="{t.get("src", "read from the code")}">{t["name"]}</th>'
    for t in TOOLS
)

html = f"""<!doctype html>
<meta charset="utf-8">
<title>PixelSlash vs the field</title>
<style>
  :root {{ --ink: var(--foreground, #eee); --dim: var(--muted-foreground, #999); --line: var(--border, #333);
          --yes: #6cc08b; --part: #e5c07b; --no: #6b7280; --unk: #4b5563; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; font: 14px/1.5 var(--font-sans, ui-sans-serif, system-ui, sans-serif); color: var(--ink); background: #111; }}
  h1 {{ font-size: 19px; line-height: 1.3; margin: 0 0 6px; font-weight: 650; letter-spacing: -0.01em; }}
  h2 {{ font-size: 12px; letter-spacing: .07em; text-transform: uppercase; color: var(--dim);
       margin: 26px 0 8px; font-weight: 600; }}
  p {{ margin: 0 0 9px; }}
  .lede {{ color: var(--dim); font-size: 13px; }}
  code {{ font: 11.5px/1.4 var(--font-mono, ui-monospace, monospace); background: rgba(255,255,255,.06);
         padding: 1px 4px; border-radius: 4px; }}
  .stats {{ display: flex; gap: 22px; margin: 14px 0 4px; flex-wrap: wrap; }}
  .stat b {{ display: block; font-size: 21px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.1; }}
  .stat span {{ font: 10.5px/1.3 var(--font-sans, sans-serif); letter-spacing: .05em; text-transform: uppercase; color: var(--dim); }}
  .bar {{ display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 16px 0 6px; }}
  .legend {{ display: flex; gap: 12px; font-size: 11px; color: var(--dim); }}
  .legend i {{ font-style: normal; font-size: 12px; }}
  .toggle {{ font-size: 11.5px; color: var(--dim); display: flex; gap: 6px; align-items: center; cursor: pointer; }}
  table {{ border-collapse: collapse; width: 100%; table-layout: fixed; }}
  col.c0 {{ width: 40%; }}
  th, td {{ padding: 5px 3px; border-top: 1px solid var(--line); vertical-align: middle; }}
  thead th {{ font-size: 9.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--dim);
             font-weight: 600; text-align: center; border-top: 0; padding-bottom: 3px; }}
  thead th.self {{ color: var(--ink); }}
  td.row {{ font-size: 11.5px; line-height: 1.35; }}
  td.row small {{ display: block; font: 10px/1.3 var(--font-mono, monospace); color: var(--dim); }}
  td.c {{ text-align: center; font-size: 12px; }}
  tr.grp td {{ border-top: 1px solid var(--line); padding-top: 12px; font: 9.5px/1 var(--font-sans, sans-serif);
              letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }}
  .v-y {{ color: var(--yes); }} .v-p {{ color: var(--part); }} .v-n {{ color: var(--no); }} .v-? {{ color: var(--unk); }}
  td.psc {{ font-weight: 700; }}
  .plan {{ color: var(--dim); }}
  .cards {{ display: grid; grid-template-columns: 1fr 1fr; gap: 2px 20px; }}
  @media (max-width: 560px) {{ .cards {{ grid-template-columns: 1fr; }} }}
  .card {{ border-top: 1px solid var(--line); padding: 9px 0; }}
  .card b {{ font-size: 12.5px; display: block; }}
  .card span {{ font-size: 12px; color: var(--dim); }}
  .card em {{ font: 10.5px/1.4 var(--font-mono, monospace); color: var(--dim); font-style: normal; }}
  ul {{ margin: 0; padding-left: 16px; }} li {{ margin-bottom: 6px; font-size: 12.5px; }}
  .foot {{ font: 10.5px/1.6 var(--font-mono, monospace); color: var(--dim); margin-top: 22px; }}
</style>

<h1>PixelSlash, against the field</h1>
<p class="lede">{len(rows)} capabilities. {METHOD}</p>

<div class="stats">
  <div class="stat"><b>{len(rows)}</b><span>capabilities</span></div>
  <div class="stat"><b>{level}</b><span>level or ahead</span></div>
  <div class="stat"><b>{len(behind)}</b><span>behind</span></div>
  <div class="stat"><b>0</b><span>nobody else has</span></div>
</div>

<div class="bar">
  <div class="legend">
    <span><i class="v-y">●</i> yes</span><span><i class="v-p">◐</i> partial</span>
    <span><i class="v-n">○</i> no</span><span><i class="v-?">?</i> not documented</span>
  </div>
  <label class="toggle"><input type="checkbox" id="onlyDiff" checked> only where we're behind</label>
</div>

<table><colgroup><col class="c0"><col span="{len(TOOLS) - 1}"></colgroup>
<thead><tr><th></th>{HEAD_HTML}</tr></thead><tbody id="tb"></tbody></table>

<h2>Nothing we have is unique</h2>
<p class="lede">Every capability in the table exists somewhere else. Two are rare rather than unique: a
local-only mode where nothing is uploaded (one other tool, and it is archived), and an AI judgement
against design-system rasters (the others have AI that compares builds, not one that reads a design
system). The diff's own accuracy is the other claim, and it is measured, not asserted: 35/37 real
changes caught with 12/30 noise flagged, against Argos at 30/37 and 19/30
(<code>bench/results/2026-10-20.md</code>).</p>

<h2>What is actually missing</h2>
<div class="cards" id="cards"></div>

<h2>The field, today</h2>
<ul>
  <li><b>Lost Pixel is gone.</b> The repository was archived on 22 April 2026; the README says it is joining
    Figma and sunsetting the product. Its column is a historical comparison, not a live competitor.</li>
  <li><b>Argos is the closest thing to us</b>: MIT-licensed, free hobby tier, deterministic diff, merge-base
    baselines, and the only one whose docs argue against AI. Its weakness is capture: it runs in your CI, so
    the renderer is whatever your runner has, and it has no diff-time ignore region.</li>
  <li><b>Chromatic</b> is the benchmark for the review loop (modes, diff inspector, checks, flake filter) and
    the one with the tightened free tier: 5,000 snapshots on Chrome only.</li>
  <li><b>Percy</b> (BrowserStack) sells cross-browser cloud rendering and Intelli Ignore; sensitivity is set at
    project or region level, not per snapshot.</li>
  <li><b>Applitools</b> has the deepest match-level surface (layout, content, strict, exact), accessibility
    checks, self-hosting via Private Cloud, and no free tier: the price is the opening for a cheap, honest diff.</li>
</ul>

<div class="foot">
  Our column: README.md, packages/engine/src, packages/cli/src, apps/web/src at <b>{DATA["ours_commit"]}</b>,
  {DATA["updated"]}.<br>
  Theirs: {" · ".join(t.get("src", "") for t in TOOLS if t["key"] != "ps")} (all fetched {DATA["updated"]}).<br>
  A "partial" is a documented subset, not a guess: read the note on the cell. Regenerate with
  <code>python3 docs/capabilities/build.py</code> after editing <code>data.json</code>.
</div>

<script id="payload" type="application/json">{payload}</script>
<script>
const D = JSON.parse(document.getElementById('payload').textContent);
const GLYPH = {{ y: '●', p: '◐', n: '○', '?': '?' }};
const tb = document.getElementById('tb');
let lastGroup = null;
D.rows.forEach(r => {{
  if (r.g !== lastGroup) {{
    lastGroup = r.g;
    const g = document.createElement('tr');
    g.className = 'grp';
    g.innerHTML = '<td colspan="{len(TOOLS)}">' + r.g + '</td>';
    tb.appendChild(g);
  }}
  const tr = document.createElement('tr');
  tr.dataset.behind = r.behind ? '1' : '0';
  tr.innerHTML = '<td class="row">' + r.label +
    (r.behind && r.plan ? ' <small class="plan">' + r.plan + '</small>' : '') +
    '<small>' + r.ps.note + '</small></td>' +
    '<td class="c psc v-' + r.ps.v + '" title="' + r.ps.note.replace(/"/g, '') + '">' + GLYPH[r.ps.v] + '</td>' +
    D.competitors.map(k => {{
      const v = r.t[k];
      const note = D.notes[k + ':' + r.k] || (k + ': ' + v);
      return '<td class="c v-' + v + '" title="' + note.replace(/"/g, '') + '">' + GLYPH[v] + '</td>';
    }}).join('');
  tb.appendChild(tr);
}});

const onlyDiff = document.getElementById('onlyDiff');
function apply() {{
  [...tb.querySelectorAll('tr')].forEach(tr => {{
    if (tr.classList.contains('grp')) return;
    tr.style.display = (!onlyDiff.checked || tr.dataset.behind === '1') ? '' : 'none';
  }});
  [...tb.querySelectorAll('tr.grp')].forEach(g => {{
    let n = g.nextElementSibling, any = false;
    while (n && !n.classList.contains('grp')) {{ if (n.style.display !== 'none') any = true; n = n.nextElementSibling; }}
    g.style.display = any ? '' : 'none';
  }});
}}
onlyDiff.onchange = apply;
apply();

const BEHIND = [
  ['Review UI', 'the accept/reject loop on a page — build list, side-by-side, overlay, slider, j/k/a/r', 'ob 1421'],
  ['PR gate', 'a GitHub check that blocks on unreviewed changes', 'ob 1471'],
  ['A Playwright helper', 'so teams using their own tests can call us', 'ob 1498'],
  ['Self-hosting shipped', 'the seams exist; no Docker image or guide yet', 'map: Hosting'],
  ['Flake signal, accessibility, retention, pricing', 'deliberately unbuilt until there is a product to sell', 'ob 1426']
];
document.getElementById('cards').innerHTML = BEHIND.map(([t, d, ref]) =>
  '<div class="card"><b>' + t + '</b><span>' + d + '</span> <em>' + ref + '</em></div>').join('');
</script>
"""

OUT.write_text(html)
print(f"wrote {OUT} ({len(html)} bytes): {len(rows)} rows, {level} level or ahead, {len(behind)} behind")
