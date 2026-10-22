/**
 * The live page `pixelslash dev` serves (ob 1740). Static: it reads `/api/state` every 400 ms and
 * redraws only when something changed. Text goes in through `textContent`, never as markup.
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
    </span>
  </header>
  <section><p id="note" class="warn" hidden></p><div id="shots"></div></section>
  <section><h2>Timeline</h2><ol id="timeline"></ol></section>
  <section><h2>Pins</h2><p id="pins" class="muted">none</p></section>
  <section><h2>Judge</h2><div id="judge" class="muted">not asked for (--judge)</div></section>
<script>
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const secs = (ms) => (ms / 1000).toFixed(1) + " s";
let root = "";
let seen = "";
const fileUrl = (abs) => abs && abs.startsWith(root + "/") ? "/files/" + abs.slice(root.length + 1).split("/").map(encodeURIComponent).join("/") : null;
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
function draw(s) {
  root = s.root;
  $("title").textContent = "pixelslash dev · " + s.target;
  $("against").textContent = s.against === "main" ? "Against previous (m)" : "Against main (m)";
  const it = s.latest;
  $("line").textContent = s.running ? "running…" : it ? line(it) : "waiting for the first run…";
  const note = it && it.note ? it.note : s.note;
  $("note").hidden = !note;
  $("note").textContent = note || "";
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
}
async function tick() {
  try {
    const s = await (await fetch("/api/state", { cache: "no-store" })).json();
    const key = JSON.stringify([s.running, s.against, s.note, s.pins, s.latest && s.latest.id, s.latest && s.latest.judge]);
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
