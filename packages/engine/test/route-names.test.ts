import { describe, expect, test } from "vitest";
import { routeOutNames, routeSlug } from "../src/routes.ts";

const names = (paths: string[]) => routeOutNames(paths).map((r) => r.name);

describe("routeOutNames", () => {
  test("a route that never collides keeps its slug", () => {
    expect(names(["/", "/pricing", "/a/b"])).toEqual(["index", "pricing", "a-b"]);
    expect(routeSlug("/index.html")).toBe("index.html");
  });

  test("/index.html is not the run's index report", () => {
    expect(names(["/", "/index.html"])).toEqual(["index", "index.html-2"]);
    expect(names(["/index.html"])).toEqual(["index.html-2"]);
  });

  test("two routes that slug alike get distinct names, first come first served", () => {
    expect(names(["/", "/index"])).toEqual(["index", "index-2"]);
    expect(names(["/a-b", "/a/b"])).toEqual(["a-b", "a-b-2"]);
    expect(names(["/index", "/", "/index-2"])).toEqual(["index", "index-2", "index-2-2"]);
  });

  test("a dot slug never names the run's own directory or its parent", () => {
    expect(names(["/.", "/.."])).toEqual([".-2", "..-2"]);
  });
});
