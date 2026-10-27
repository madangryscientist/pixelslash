#!/usr/bin/env python3
"""Render docs/capabilities/matrix.html from data.json.

Run from anywhere:  python3 docs/capabilities/build.py
No dependencies. The page is a single self-contained file (no images, inline data), so it can be
opened as file:// or committed and diffed.
"""
import json
import pathlib
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
# The repo URL lives once, in the GitHub App manifest; a commit link is that URL plus /commit/.
MANIFEST = HERE.parents[1] / "apps" / "web" / "github-app" / "manifest.json"
REPO = json.loads(MANIFEST.read_text())["url"].rstrip("/") + "/commit/"
DATA = json.loads((HERE / "data.json").read_text())
OUT = HERE / "matrix.html"

TOOLS = DATA["tools"]
COMPETITORS = [t["key"] for t in TOOLS if t["key"] != "ps"]
SCORE = {"y": 2, "p": 1, "n": 0, "?": 0}

rows = DATA["rows"]
for r in rows:
    best = max(SCORE[r["t"][k]] for k in COMPETITORS)
    r["behind"] = SCORE[r["ps"]["v"]] < best
    # The short sha in data.json names the land; the link needs the full one. An unknown sha stops the build.
    r["ps"]["sha"] = subprocess.run(
        ["git", "rev-parse", "--verify", r["ps"]["commit"] + "^{commit}"],
        cwd=HERE, capture_output=True, text=True, check=True,
    ).stdout.strip()
# A public comparison: every cell that says a rival lacks or only partly has something, or that the docs
# were silent, names why and links the page it was read from. The build stops on one that does not.
LINKS = DATA["links"]
for r in rows:
    for k in COMPETITORS:
        if r["t"][k] == "y":
            continue
        cell = f"{k}:{r['k']}"
        for what, table in (("note", DATA["notes"]), ("link", LINKS)):
            if not table.get(cell, "").strip():
                raise SystemExit(f"{cell} is {r['t'][k]!r} and has no {what}")
        if not LINKS[cell].startswith("https://"):
            raise SystemExit(f"{cell}: the link must be an https URL, got {LINKS[cell]!r}")
behind = [r for r in rows if r["behind"]]
for r in behind:
    if not r.get("gap"):
        raise SystemExit(f"{r['k']} is behind and has no gap sentence for the 'What is actually missing' card")
level = len(rows) - len(behind)
# "Nothing we have is unique" is prose below. A row only we have (we say y, every rival says n) would make
# it false, so the build stops until the text is changed because a landing changed it.
unique = [r for r in rows if r["ps"]["v"] == "y" and all(SCORE[r["t"][k]] == 0 and r["t"][k] != "?" for k in COMPETITORS)]
if unique:
    raise SystemExit("rows only we have: " + ", ".join(r["k"] for r in unique) + "; rewrite the 'Nothing we have is unique' section")

payload = json.dumps({
    "rows": rows,
    "notes": DATA["notes"],
    "links": LINKS,
    "src": {t["key"]: t.get("src", "") for t in TOOLS},
    "names": {t["key"]: t["name"] for t in TOOLS},
    "competitors": COMPETITORS,
    "repo": REPO,
})

METHOD = DATA["method"].replace("{commit}", f'<code>{DATA["ours_commit"]}</code> (audited {DATA["audited"]})').replace("{date}", DATA["updated"])

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
  td.row small a.sha {{ font: 9.5px/1 var(--font-mono, monospace); color: var(--dim); opacity: .75; }}
  td.c {{ text-align: center; font-size: 12px; }}
  td.c a {{ color: inherit; text-decoration: none; }} td.c a:hover {{ text-decoration: underline; }}
  .foot a {{ color: inherit; }}
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
  <div class="stat"><b>{len(unique)}</b><span>nobody else has</span></div>
</div>

<div class="bar">
  <div class="legend">
    <span><i class="v-y">●</i> yes</span><span><i class="v-p">◐</i> partial</span>
    <span><i class="v-n">○</i> no</span><span><i class="v-?">?</i> not documented</span>
  </div>
  <label class="toggle"><input type="checkbox" id="onlyDiff" checked> only where we're behind</label>
</div>

<table><colgroup><col class="c0"><col span="{len(TOOLS)}"></colgroup>
<thead><tr><th></th>{HEAD_HTML}</tr></thead><tbody id="tb"></tbody></table>

<h2>Nothing we have is unique</h2>
<p class="lede">Every capability in the table exists somewhere else. Two are rare rather than unique: a
local-only mode where nothing is uploaded (one other tool, and it is archived), and an AI judgement
against design-system rasters (Applitools checks a build against a Figma design and Percy's AI reviews
changes against a PR summary; no docs page we read describes checking a design-system ruleset). The diff's own accuracy is the other claim, and it is measured, not asserted: 35/37 real
changes caught with 12/30 noise flagged, against Argos at 30/37 and 19/30
(<code>bench/results/2026-10-20.md</code>).</p>

<h2>What is actually missing</h2>
<div class="cards" id="cards"></div>

<h2>The field, today</h2>
<ul>
  <li><b>Lost Pixel is gone.</b> The repository was archived on 22 April 2026; the README says it is joining
    Figma and sunsetting the product. Its column is a historical comparison, not a live competitor.</li>
  <li><b>Argos is the closest thing to us</b>: MIT-licensed, a free hobby tier, merge-base
    baselines, and a diff its docs call deterministic, with no AI step. Its weakness is capture: it runs in
    your CI, so the renderer is whatever your runner has, and its ignore is per change fingerprint, not a
    region you draw.</li>
  <li><b>Chromatic</b> is the benchmark for the review loop (modes, diff inspector, checks, flake filter) and
    the one whose free plan is 5,000 snapshots a month.</li>
  <li><b>Percy</b> (BrowserStack) sells cross-browser cloud rendering and Intelli Ignore; sensitivity is set per
    project, per snapshot or per region, and its AI review is paid-plan only.</li>
  <li><b>Applitools</b> has the deepest match-level surface (a level per checkpoint or region, in place of a numeric threshold), accessibility
    checks, on-premises deployment sold as an add-on, and no free tier: the price is the opening for a cheap, honest diff.</li>
</ul>

<div class="foot">
  Our column: README.md, packages/engine/src, packages/cli/src, apps/web/src at <b>{DATA["ours_commit"]}</b>,
  audited {DATA["audited"]}; each of our cells names the land that made it true.<br>
  Theirs: the public docs of each tool, fetched {DATA["updated"]}; every cell that is not a yes links the page it was read from, and its note says what that page says. Starting points: {" · ".join(f'<a href="{t["src"]}">{t["name"]}</a>' for t in TOOLS if t["key"] != "ps")}.<br>
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
    g.innerHTML = '<td colspan="{len(TOOLS) + 1}">' + r.g + '</td>';
    tb.appendChild(g);
  }}
  const tr = document.createElement('tr');
  tr.dataset.behind = r.behind ? '1' : '0';
  tr.innerHTML = '<td class="row">' + r.label +
    (r.behind && r.plan ? ' <small class="plan">' + r.plan + '</small>' : '') +
    '<small>' + r.ps.note + ' <a class="sha" href="' + D.repo + r.ps.sha + '">' + r.ps.commit + '</a></small></td>' +
    '<td class="c psc v-' + r.ps.v + '" title="' + r.ps.note.replace(/"/g, '') + '">' + GLYPH[r.ps.v] + '</td>' +
    D.competitors.map(k => {{
      const v = r.t[k];
      const cell = k + ':' + r.k;
      const note = D.notes[cell] || (k + ': ' + v);
      const url = D.links[cell];
      const mark = url ? '<a href="' + url + '" rel="noopener">' + GLYPH[v] + '</a>' : GLYPH[v];
      return '<td class="c v-' + v + '" title="' + note.replace(/"/g, '') + '">' + mark + '</td>';
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

const BEHIND = D.rows.filter(r => r.behind).map(r => [r.label, r.gap, r.plan]);
document.getElementById('cards').innerHTML = BEHIND.map(([t, d, ref]) =>
  '<div class="card"><b>' + t + '</b><span>' + d + '</span> <em>' + ref + '</em></div>').join('');
</script>
"""

OUT.write_text(html)
print(f"wrote {OUT} ({len(html)} bytes): {len(rows)} rows, {level} level or ahead, {len(behind)} behind")
