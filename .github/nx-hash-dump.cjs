// Preload: after Nx hashes the task graph, write each task's hash and hashDetails to NX_HASH_DUMP.
const path = require("path");
const fs = require("fs");
const out = process.env.NX_HASH_DUMP;
if (out && /nx/.test(process.argv[1] || "")) {
 try {
  const m = require(path.join(process.cwd(), "node_modules/nx/dist/src/hasher/hash-task.js"));
  const orig = m.hashTasksThatDoNotDependOnOutputsOfOtherTasks;
  m.hashTasksThatDoNotDependOnOutputsOfOtherTasks = async function (hasher, pg, taskGraph, ...rest) {
    const r = await orig.call(this, hasher, pg, taskGraph, ...rest);
    const dump = {};
    for (const t of Object.values(taskGraph.tasks)) dump[t.id] = { hash: t.hash, details: t.hashDetails };
    fs.writeFileSync(out, JSON.stringify(dump, null, 1));
    return r;
  };
 } catch {}
}
