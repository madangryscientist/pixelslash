import { describe, expect, test } from "vitest";
import {
  MAX_METRICS_BYTES,
  MAX_METRICS_PARTS,
  metricsText,
  parseMetrics,
  parseMetricsText,
  round2,
  uniqueNames,
} from "../src/metrics-entry.ts";
import { buildMetrics, hexOf, type RawPart } from "../src/metrics-walk.ts";

const fail = (where: string, what: string): never => {
  throw new Error(`${where} ${what}`);
};

const button = {
  version: "1.0",
  root: "button",
  parts: {
    button: {
      box: { x: 0, y: 0, w: 96, h: 40 },
      padding: { top: 8, right: 16, bottom: 8, left: 16 },
      gap: 8,
      color: { bg: "#2563eb", border: "#1d4ed8" },
    },
    "button.label": {
      box: { x: 40, y: 10, w: 40, h: 20 },
      font: { size: 14, weight: 600, lineHeight: 20 },
      color: { fg: "#ffffff" },
    },
  },
};

describe("parseMetrics", () => {
  test("reads the worked example as written", () => {
    expect(parseMetrics(button, "m", fail)).toEqual(button);
  });

  test("ignores unknown fields at every level and unknown parts' extra fields", () => {
    const rich = {
      ...button,
      note: "x",
      parts: {
        ...button.parts,
        "button.icon": {
          box: { x: 1, y: 2, w: 3, h: 4, z: 9 },
          shadow: "none",
          color: { glow: 1 },
        },
      },
    };
    const read = parseMetrics(rich, "m", fail);
    expect(read).not.toHaveProperty("note");
    expect(read.parts["button.icon"]).toEqual({ box: { x: 1, y: 2, w: 3, h: 4 }, color: {} });
  });

  test("a higher minor reads as the version it knows; a higher major is refused", () => {
    expect(parseMetrics({ ...button, version: "1.7" }, "m", fail).version).toBe("1.7");
    expect(() => parseMetrics({ ...button, version: "2.0" }, "m", fail)).toThrow(/only version 1/);
  });

  test("rounds to two decimals and turns -0 into 0", () => {
    const read = parseMetrics(
      { ...button, parts: { button: { box: { x: -0.001, y: 0, w: 12.345, h: 1 } } } },
      "m",
      fail,
    );
    expect(read.parts["button"]?.box).toEqual({ x: 0, y: 0, w: 12.35, h: 1 });
    expect(round2(1.005)).toBe(1);
  });

  test.each([
    ["version", { ...button, version: 1 }, /version/],
    ["version shape", { ...button, version: "one" }, /version/],
    ["root missing", { version: "1.0", parts: button.parts }, /root/],
    ["root not a part", { ...button, root: "nope" }, /root/],
    ["no parts", { version: "1.0", root: "a", parts: {} }, /at least one part/],
    ["no box", { ...button, parts: { button: {} } }, /box.*required/],
    ["negative width", { ...button, parts: { button: { box: { x: 0, y: 0, w: -1, h: 1 } } } }, /w/],
    [
      "non-finite",
      { ...button, parts: { button: { box: { x: 0, y: 0, w: null, h: 1 } } } },
      /finite/,
    ],
    [
      "bad colour",
      { ...button, parts: { button: { box: button.parts.button.box, color: { bg: "#FFF" } } } },
      /#rrggbb/,
    ],
    [
      "weight",
      {
        ...button,
        parts: { button: { box: button.parts.button.box, font: { size: 1, weight: 0 } } },
      },
      /1 to 1000/,
    ],
    ["empty name", { ...button, parts: { "": button.parts.button }, root: "" }, /name must be/],
    ["not an object", [], /must be an object/],
  ])("refuses %s", (_name, value, message) => {
    expect(() => parseMetrics(value, "m", fail)).toThrow(message);
  });

  test("a part named __proto__ is a part, not the prototype", () => {
    const text = `{"version":"1.0","root":"__proto__","parts":{"__proto__":{"box":{"x":0,"y":0,"w":1,"h":1}}}}`;
    const read = parseMetricsText(text, "m", fail);
    expect(Object.keys(read.parts)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(read.parts)).toBe(Object.prototype);
  });
});

describe("parseMetricsText", () => {
  test("refuses text that is not JSON, naming where", () => {
    expect(() => parseMetricsText("{nope", "a.metrics.json", fail)).toThrow(
      "a.metrics.json is not valid JSON",
    );
  });

  test("refuses a file over the size cap, with the size and the cap", () => {
    expect(() => parseMetricsText("{}", "m", fail, MAX_METRICS_BYTES + 1)).toThrow(
      new RegExp(`${MAX_METRICS_BYTES + 1} bytes.*${MAX_METRICS_BYTES}`),
    );
  });

  test("refuses more parts than the cap", () => {
    const parts: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_METRICS_PARTS; i++)
      parts[`p${i}`] = { box: { x: 0, y: 0, w: 1, h: 1 } };
    expect(() =>
      parseMetricsText(JSON.stringify({ version: "1.0", root: "p0", parts }), "m", fail),
    ).toThrow(/at most 2000/);
  });

  test("what metricsText writes reads back unchanged", () => {
    const read = parseMetrics(button, "m", fail);
    expect(parseMetricsText(metricsText(read), "m", fail)).toEqual(read);
  });
});

describe("uniqueNames", () => {
  test("the first keeps the name, the repeats are name#2, name#3", () => {
    expect(uniqueNames(["row", "row", "x", "row"])).toEqual(["row", "row#2", "x", "row#3"]);
  });

  test("never makes a name another part already has", () => {
    const names = uniqueNames(["a", "a", "a#2"]);
    expect(new Set(names).size).toBe(3);
    expect(names[0]).toBe("a");
    expect(names[2]).toBe("a#2");
  });
});

describe("hexOf", () => {
  test.each([
    ["rgb(37, 99, 235)", "#2563eb"],
    ["rgba(255, 255, 255, 1)", "#ffffff"],
    ["rgba(0, 0, 0, 0.5)", "#00000080"],
    ["rgb(0 0 0 / 50%)", "#00000080"],
    ["rgba(0, 0, 0, 0)", null],
    ["transparent", null],
    ["oklch(0.6 0.2 250)", null],
  ])("%s is %s", (value, hex) => {
    expect(hexOf(value)).toBe(hex);
  });
});

const raw = (over: Partial<RawPart>): RawPart => ({
  name: "a",
  rect: { left: 10, top: 20, width: 30, height: 40 },
  padding: ["0px", "0px", "0px", "0px"],
  display: "block",
  flexDirection: "row",
  rowGap: "normal",
  columnGap: "normal",
  fontSize: "16px",
  fontWeight: "400",
  lineHeight: "normal",
  color: "rgb(0, 0, 0)",
  background: "rgba(0, 0, 0, 0)",
  borderColor: "rgb(0, 0, 0)",
  borderWidth: "0px",
  borderStyle: "none",
  text: false,
  ...over,
});

describe("buildMetrics", () => {
  test("is null with no parts, and measures from the first part's corner", () => {
    expect(buildMetrics([])).toBeNull();
    const m = buildMetrics([
      raw({}),
      raw({ name: "b", rect: { left: 15, top: 25, width: 5, height: 5 } }),
    ]);
    expect(m?.root).toBe("a");
    expect(m?.parts["a"]?.box).toEqual({ x: 0, y: 0, w: 30, h: 40 });
    expect(m?.parts["b"]?.box).toEqual({ x: 5, y: 5, w: 5, h: 5 });
  });

  test("gap is the main-axis gap of a flex part only; font and fg only on a part with text", () => {
    const m = buildMetrics([
      raw({ display: "flex", columnGap: "8px", rowGap: "2px" }),
      raw({ name: "t", text: true, lineHeight: "20px", color: "rgb(255, 255, 255)" }),
    ]);
    expect(m?.parts["a"]?.gap).toBe(8);
    expect(m?.parts["a"]).not.toHaveProperty("font");
    expect(m?.parts["t"]?.font).toEqual({ size: 16, weight: 400, lineHeight: 20 });
    expect(m?.parts["t"]?.color).toEqual({ fg: "#ffffff" });
    expect(m?.parts["t"]).not.toHaveProperty("gap");
  });

  test("border colour only when the border is visible; transparent is left out", () => {
    const m = buildMetrics([
      raw({ borderWidth: "1px", borderStyle: "solid", borderColor: "rgb(29, 78, 216)" }),
      raw({ name: "n", borderWidth: "1px", borderStyle: "none" }),
    ]);
    expect(m?.parts["a"]?.color).toEqual({ border: "#1d4ed8" });
    expect(m?.parts["n"]).not.toHaveProperty("color");
  });

  test("names repeated parts name#2 and refuses a page over the part cap", () => {
    const m = buildMetrics([raw({ name: "row" }), raw({ name: "row" })]);
    expect(Object.keys(m?.parts ?? {})).toEqual(["row", "row#2"]);
    expect(() =>
      buildMetrics(Array.from({ length: MAX_METRICS_PARTS + 1 }, () => raw({}))),
    ).toThrow(/at most 2000/);
  });
});
