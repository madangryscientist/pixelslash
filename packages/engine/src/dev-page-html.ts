/**
 * The live page `pixelslash dev` serves (ob 1740). Static: it reads `/api/state` every 400 ms and
 * redraws only when something changed. Text goes in through `textContent`, never as markup.
 * The Feature section (ob 1741) shows a target's refs beside and over the shot, the judge's
 * numbered differences and the spec. It puts no number on how close the shot is to a ref.
 */
export const DEV_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>pixelslash dev</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; background: #111; color: #eee; }
    header { padding: 16px 24px; border-bottom: 1px solid #333; display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
    h1 { font-size: 16px; font-weight: 600; margin: 0; }
    h2 { font-size: 14px; margin: 0 0 12px; }
    section { padding: 16px 24px; border-bottom: 1px solid #333; }
    button { background: #222; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
    button:hover { border-color: #9cf; }
    .muted { color: #888; }
    .warn { color: #ffd400; }
    .line { font-variant-numeric: tabular-nums; }
    .shot { margin: 0 0 24px; }
    .sides { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    figure { margin: 0; }
    figcaption { color: #888; margin: 0 0 4px; }
    img { max-width: 100%; border: 1px solid #333; background: #fff; }
    ol { display: flex; gap: 6px; flex-wrap: wrap; list-style: none; margin: 0; padding: 0; }
    ol li { border: 1px solid #333; border-radius: 4px; padding: 4px 8px; font-variant-numeric: tabular-nums; }
    ol li.changed { border-color: #f66; }
    ol li.pin { box-shadow: inset 0 -2px 0 #9cf; }
    ol li.current { background: #223; }
    a { color: #9cf; }
    h3 { font-size: 13px; margin: 16px 0 8px; }
    pre { white-space: pre-wrap; background: #181818; border: 1px solid #333; padding: 12px; margin: 0; }
    .pair { margin: 0 0 24px; }
    .two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .boxed { position: relative; display: inline-block; max-width: 100%; line-height: 0; }
    .boxed img { display: block; max-width: 100%; }
    .box { position: absolute; border: 2px solid #f0f; box-sizing: border-box; }
    .box span { position: absolute; top: 0; left: 0; background: #f0f; color: #000; font: 600 11px/1.4 ui-sans-serif, system-ui, sans-serif; padding: 0 4px; }
    .onion { position: relative; overflow: hidden; max-width: 100%; border: 1px solid #333; background: #fff; margin: 8px 0 4px; }
    .onion img { position: absolute; top: 0; left: 0; max-width: none; border: 0; background: none; }
    .slider { display: flex; gap: 8px; align-items: center; color: #888; }
    ul.diffs { margin: 0; padding-left: 0; list-style: none; }
  </style>
</head>
<body>
  <header>
    <h1 id="title">pixelslash dev</h1>
    <span id="line" class="line muted">waiting for the first run…</span>
    <span>
      <button data-act="run" title="r">Run (r)</button>
      <button data-act="pin" title="p">Pin (p)</button>
      <button data-act="unpin" title="u">Unpin (u)</button>
      <button data-act="against" title="m" id="against">Against main (m)</button>
      <button data-act="refs" title="f" id="refs" hidden>Refetch refs (f)</button>
    </span>
  </header>
  <section><p id="note" class="warn" hidden></p><div id="shots"></div></section>
  <section><h2>Timeline</h2><ol id="timeline"></ol></section>
  <section><h2>Pins</h2><p id="pins" class="muted">none</p></section>
  <section><h2>Judge</h2><div id="judge" class="muted">not asked for (--judge)</div></section>
  <section id="feature" hidden>
    <h2>Feature</h2>
    <p class="muted">Each reference is shown beside the shot and over it. Nothing is measured against it: the overlay is for looking, and the judge lists differences without a verdict.</p>
    <ul id="refskips" class="warn"></ul>
    <div id="pairs"></div>
    <h3>Differences</h3><div id="diffs" class="muted">not asked for (--judge)</div>
    <h3>Spec</h3><pre id="spec"></pre>
  </section>
<script>
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const secs = (ms) => (ms / 1000).toFixed(1) + " s";
let root = "";
let seen = "";
let onion = 50;
const fileUrl = (abs) => abs && abs.startsWith(root + "/") ? "/files/" + abs.slice(root.length + 1).split("/").map(encodeURIComponent).join("/") : null;
// The mtime in the query, so a refetched ref is loaded again rather than read from the cache.
const refUrl = (r) => "/ref/" + Number(r.index) + "?v=" + Number(r.modified);
const label = (a) => a.kind === "main" ? "main" : a.kind === "none" ? "nothing (first run)" : (a.kind === "pin" ? "pin #" : "#") + Number(a.iteration);
function line(it) {
  const c = it.counts;
  const what = c.changed + c.new + c.removed === 0 ? "no change" : it.regions + " regions changed · " + it.changedPixels + " px" + (c.new ? " · " + c.new + " new" : "");
  return "#" + Number(it.id) + " vs " + label(it.against) + ": " + what + " · ours " + secs(it.timings.oursMs) + " · settle " + secs(it.timings.settleMs);
}
function figure(caption, abs) {
  const f = el("figure");
  f.append(el("figcaption", caption));
  const url = fileUrl(abs);
  if (url) { const img = el("img"); img.src = url + "?v=" + seen.length; img.alt = caption; f.append(img); } else f.append(el("p", "—", "muted"));
  return f;
}
function drawShots(it) {
  const box = $("shots");
  box.replaceChildren();
  for (const s of it.shots) {
    const d = el("div", undefined, "shot");
    const title = el("h2", s.name + " · " + s.shot + " · " + s.status + (s.changedPixels ? " · " + s.changedPixels + " px in " + s.regions.length + " regions" : ""));
    d.append(title);
    const sides = el("div", undefined, "sides");
    sides.append(figure("now", s.files.shot), figure("diff", s.files.diff), figure("against " + label(it.against), s.files.against));
    d.append(sides);
    if (s.files.report) { const a = el("a", "full report"); a.href = fileUrl(s.files.report); a.target = "_blank"; d.append(a); }
    box.append(d);
  }
}
function drawJudge(j) {
  const box = $("judge");
  box.replaceChildren();
  if (!j) { box.textContent = "not asked for (--judge)"; return; }
  if (j.status !== "done") { box.textContent = j.status === "skipped" ? "skip: " + j.reason : "failed: " + j.reason; return; }
  if (j.notes.length === 0) { box.textContent = "no violations"; return; }
  const ul = el("ul");
  for (const n of j.notes) ul.append(el("li", n.name + " (" + n.shot + "): " + n.component + " — " + n.reason));
  box.append(ul);
}
function px(r) { return Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.width) + "×" + Math.round(r.height); }
function boxed(abs, size, diffs) {
  const b = el("div", undefined, "boxed");
  const url = fileUrl(abs);
  if (url) { const img = el("img"); img.src = url + "?v=" + seen.length; img.alt = "now"; b.append(img); }
  for (const d of diffs) {
    const box = el("div", undefined, "box");
    box.style.left = (100 * d.area.x / size.width) + "%";
    box.style.top = (100 * d.area.y / size.height) + "%";
    box.style.width = (100 * d.area.width / size.width) + "%";
    box.style.height = (100 * d.area.height / size.height) + "%";
    box.title = d.what;
    box.append(el("span", String(d.n)));
    b.append(box);
  }
  return b;
}
function overlay(p) {
  const o = el("div", undefined, "onion");
  o.style.width = p.overlap.width + "px";
  o.style.aspectRatio = p.overlap.width + " / " + p.overlap.height;
  const now = el("img");
  now.src = fileUrl(p.file) + "?v=" + seen.length;
  now.alt = "now";
  const ref = el("img");
  ref.src = refUrl(p.ref);
  ref.alt = "reference";
  // Both at one scale, so a pixel of each lands on the same spot; the box is the overlap.
  now.style.width = (100 * p.size.width / p.overlap.width) + "%";
  ref.style.width = (100 * p.ref.size.width / p.overlap.width) + "%";
  ref.style.opacity = String(onion / 100);
  o.append(now, ref);
  const slider = el("label", undefined, "slider");
  const range = el("input");
  range.type = "range"; range.min = "0"; range.max = "100"; range.value = String(onion);
  range.addEventListener("input", () => { onion = Number(range.value); ref.style.opacity = String(onion / 100); });
  slider.append(el("span", "now"), range, el("span", "reference"));
  const f = el("div");
  f.append(o, slider);
  return f;
}
function drawFeature(s) {
  const f = s.feature;
  $("feature").hidden = !f;
  if (!f) return;
  const skips = $("refskips");
  skips.replaceChildren();
  for (const r of f.refs) if (r.skip) skips.append(el("li", "skip: " + r.skip + " (" + r.source + ", " + r.variant + ")"));
  const d = s.latest && s.latest.differences;
  const items = d && d.status === "done" ? d.items : [];
  const pairs = $("pairs");
  pairs.replaceChildren();
  for (const p of s.pairs) {
    const box = el("div", undefined, "pair");
    const refName = p.ref ? p.ref.source.split("/").slice(-1)[0] : "spec only";
    box.append(el("h3", p.name + " · " + p.shot + " · " + refName));
    const mine = items.filter((i) => i.name === p.name && i.shot === p.shot && i.ref === (p.ref ? p.ref.source : null));
    const two = el("div", undefined, "two");
    const left = el("figure");
    left.append(el("figcaption", "reference"));
    if (p.ref) { const img = el("img"); img.src = refUrl(p.ref); img.alt = "reference"; left.append(img); } else left.append(el("p", "no reference for this viewport; the spec is below", "muted"));
    const right = el("figure");
    right.append(el("figcaption", "now"), boxed(p.file, p.size, mine));
    two.append(left, right);
    box.append(two);
    if (p.ref && p.overlap) { box.append(el("h3", "Overlay")); box.append(overlay(p)); }
    if (p.sizes) box.append(el("p", p.sizes, p.sizes.includes("differ") ? "warn" : "muted"));
    pairs.append(box);
  }
  const dl = $("diffs");
  dl.replaceChildren();
  if (!d) dl.textContent = "not asked for (--judge)";
  else if (d.status !== "done") dl.textContent = d.status === "skipped" ? "skip: " + d.reason : "failed: " + d.reason;
  else if (items.length === 0) dl.textContent = "the judge listed no differences";
  else {
    const ul = el("ul", undefined, "diffs");
    for (const i of items) ul.append(el("li", i.n + ". " + i.name + " (" + i.shot + "): " + i.what + " — at " + px(i.area)));
    dl.append(ul);
  }
  $("spec").textContent = f.spec ? f.spec.text : "no spec";
}
function draw(s) {
  root = s.root;
  $("title").textContent = "pixelslash dev · " + s.target;
  $("against").textContent = s.against === "main" ? "Against previous (m)" : "Against main (m)";
  const it = s.latest;
  $("line").textContent = s.running ? "running…" : it ? line(it) : "waiting for the first run…";
  const note = it && it.note ? it.note : s.note;
  $("note").hidden = !note;
  $("note").textContent = note || "";
  $("refs").hidden = !s.feature;
  $("pins").textContent = s.pins.length ? s.pins.map((p) => "#" + Number(p)).join(", ") : "none";
  const tl = $("timeline");
  tl.replaceChildren();
  for (const t of s.timeline) {
    const changed = t.counts.changed + t.counts.new + t.counts.removed > 0;
    const li = el("li", "#" + Number(t.id) + " " + (changed ? t.changedPixels + " px" : "same"));
    li.className = [changed && "changed", s.pins.includes(t.id) && "pin", it && t.id === it.id && "current"].filter(Boolean).join(" ");
    li.title = new Date(t.at).toLocaleTimeString() + " · vs " + label(t.against);
    tl.append(li);
  }
  if (it) drawShots(it); else $("shots").replaceChildren();
  drawJudge(it ? it.judge : null);
  drawFeature(s);
}
async function tick() {
  try {
    const s = await (await fetch("/api/state", { cache: "no-store" })).json();
    const key = JSON.stringify([s.running, s.against, s.note, s.pins, s.latest && s.latest.id, s.latest && s.latest.judge, s.latest && s.latest.differences, s.feature]);
    if (key !== seen) { seen = key; draw(s); }
  } catch { $("line").textContent = "the dev session has stopped"; }
}
for (const b of document.querySelectorAll("button[data-act]"))
  b.addEventListener("click", () => fetch("/api/" + b.dataset.act, { method: "POST", headers: { "x-pixelslash-dev": "1" } }).then(tick));
setInterval(tick, 400);
tick();
</script>
</body>
</html>
`;
