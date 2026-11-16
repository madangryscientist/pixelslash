import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { checkPersonas, PERSONAS_DIR, type PersonasFile, readPersonas } from "../personas";

const root = mkdtempSync(join(tmpdir(), "personas-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A copy of the real personas dir, with `edit` applied to its JSON and the README left as it was. */
function fixture(edit: (f: PersonasFile) => void): string {
  const dir = join(root, String(n++));
  cpSync(PERSONAS_DIR, dir, { recursive: true });
  const f = readPersonas(dir).file!;
  edit(f);
  writeFileSync(join(dir, "personas.json"), JSON.stringify(f, null, 2));
  return dir;
}

describe("personas", () => {
  test("the repo's own personas are valid and the table is current", () => {
    expect(checkPersonas()).toEqual([]);
  });

  test("a table that no longer matches the JSON is stale", () => {
    const dir = fixture((f) => {
      f.personas[0]!.name = "Priyanka";
    });
    expect(checkPersonas(dir)).toEqual([expect.stringContaining("the table is stale")]);
  });

  test("four personas fail", () => {
    const dir = fixture((f) => {
      f.personas.pop();
    });
    expect(checkPersonas(dir)).toEqual([
      expect.stringContaining("need exactly 5 personas, found 4"),
    ]);
  });

  test("malformed JSON is reported as an error, not thrown", () => {
    const dir = fixture(() => {});
    writeFileSync(join(dir, "personas.json"), "{ not json");
    expect(checkPersonas(dir)).toEqual([expect.stringContaining("cannot be read as JSON")]);
  });

  test("a bad id, group, model, focus, pipe or dash is named", () => {
    const dir = fixture((f) => {
      const p = f.personas[0]!;
      p.id = "Priya";
      p.group = "nobody";
      p.model = "gpt";
      p.focus.cli = "";
      p.focus.review = "a | b";
      f.personas[1]!.id = f.personas[2]!.id;
      f.personas[3]!.profile = `x ${String.fromCharCode(0x2014)} y`;
    });
    const errs = checkPersonas(dir).join("\n");
    for (const want of [
      "persona Priya: id must be lower-case kebab",
      'group "nobody" is not in groups',
      'model "gpt" is not in models',
      "focus.cli is empty",
      "focus.review has a",
      "duplicate id",
      "an em or en dash is not allowed",
    ])
      expect(errs).toContain(want);
  });
});
