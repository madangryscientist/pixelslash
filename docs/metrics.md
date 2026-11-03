# Layout metrics file (version 1)

A snapshot can carry a second file next to its PNG: the **layout metrics** of the screen at the moment of the shot. A PNG says what the screen looks like; the metrics file says what each named part measured and was styled with, so two shots of one screen on two platforms (a web page and an Android or iOS build of it) can be read part by part.

This page is the contract. A web capture writes the file itself (`"metrics": true`, below); a native test suite writes it with its own emitter, against this schema. PixelSlash reads, stores and shows the file, and `pixelslash parity` compares the two files of a [twin pair](cli.md#twins-across-platforms) ([Parity](#parity), below).

- It is **optional** everywhere. A snapshot without one is exactly as it was.
- It is **data about the shot, never part of its identity**: the pixel diff, the fingerprint, the snapshot's identity and every exit code are the same with or without it.
- The file is `<name>.metrics.json`, UTF-8 JSON, beside `<name>.png` in a dir you `import`; in a snapshot dir `capture` writes it as `<route>/<variant>.metrics.json` next to `<route>/<variant>.png`.

## Shape

```json
{
  "version": "1.0",
  "root": "button",
  "parts": {
    "button": {
      "box": { "x": 0, "y": 0, "w": 96, "h": 40 },
      "padding": { "top": 8, "right": 16, "bottom": 8, "left": 16 },
      "gap": 8,
      "color": { "bg": "#2563eb", "border": "#1d4ed8" }
    },
    "button.icon": {
      "box": { "x": 16, "y": 12, "w": 16, "h": 16 },
      "color": { "bg": "#ffffff" }
    },
    "button.label": {
      "box": { "x": 40, "y": 10, "w": 40, "h": 20 },
      "font": { "size": 14, "weight": 600, "lineHeight": 20 },
      "color": { "fg": "#ffffff" }
    }
  }
}
```

A button 96 × 40 with a 16 px icon and a label, 8 px apart (the icon ends at x 32, the label starts at 40).

| Field | Meaning |
| --- | --- |
| `version` | `"<major>.<minor>"`, a string. This page is `"1.0"`. |
| `root` | The name of the part everything is measured from. Required, and it must be a key of `parts`. |
| `parts` | An object: part name → part. At least one part. |

### Parts

A **part** is a named piece of the screen: a web element with a `data-part` attribute (`<span data-part="button.label">`), a native view with a `testID` (React Native, Maestro) or an accessibility identifier. The name is whatever the app calls it, kept as given: `button.icon` is one name, the dot is not a path, and nothing here nests parts. A name is 1 to 200 characters.

| Field | Required | Unit | Meaning |
| --- | --- | --- | --- |
| `box` | yes | logical px | `{ x, y, w, h }`: the part's border box. `w` and `h` are 0 or more. |
| `padding` | no | logical px | `{ top, right, bottom, left }`, each 0 or more. |
| `gap` | no | logical px | The flex or stack gap the part **declares between its children**, 0 or more. Left out when it declares none. |
| `font` | no | | `{ size, weight, lineHeight? }`. Only on a part that renders text itself (not one that only contains parts that do). |
| `color` | no | | `{ fg?, bg?, border? }`, each a colour string (below). |

- **Logical px** are CSS px on the web, dp on Android and pt on iOS: the units the app is laid out in, **never device pixels**. A 3x phone screenshot is 1080 px wide for a 360 dp screen; the metrics say 360. Sizes are not scaled by the snapshot's `scale`.
- **`font.size`** is the font size and **`font.lineHeight`** the line box height, both in logical px. `lineHeight` is left out when the platform has no fixed value (CSS `normal`). **`font.weight`** is the numeric weight, 1 to 1000 (400 regular, 700 bold); a platform with names maps them to the CSS numbers.
- **Colours** are lowercase hex, `#rrggbb` or `#rrggbbaa` (the alpha byte last, as in CSS). **Transparent is left out**, never guessed: a part with no background has no `bg`. `fg` is the text colour and is given only on a part with `font`; `border` is the colour of the border, given only when the part has a visible one (the same colour on all four sides, else the top's).
- A field a platform cannot know is left out. A missing field is "not measured", never zero.

### The origin

Every `box` is measured **from the top-left corner of the root part's border box**, which is therefore `0, 0`. `root` names the root part. Those are the whole rules:

- **On the web**, the root is the first `[data-part]` element in document order, and the page is read with its scroll at the top. Two top-level parts are both measured from the first one's corner; a part above or left of it has a negative `x` or `y`.
- **On native**, the root is the screen's outermost named view, or the one the test is about. State which in your emitter's docs.

Measuring from the root and not from the screen means a component that moved 40 px down the page is the same component, and only what moved inside it shows up.

### Two parts with one name

Names are unique in the file. The first part with a name keeps it; the second is `name#2`, the third `name#3`, in document (or view-tree, top to bottom, leading to trailing) order. A list of three `row.item` parts is `row.item`, `row.item#2`, `row.item#3`. A reader that does not know about `#N` sees three separate parts, which is correct.

### Numbers

Every number is rounded to **2 decimal places** by whoever writes the file (`12.345` is `12.35`; whole numbers carry no decimals), and must be finite. A reader rounds again, so a file with more digits is read at 2 and stored as it came.

### Size

A file is at most **1 MiB** and at most **2000 parts**. A bigger one is refused with its size and the cap, not truncated: a metrics file that quietly lost parts would let a missing part look like a part that was never there. A web capture that finds more than 2000 `[data-part]` elements fails the shot and says so.

## Parity

`pixelslash parity --build ID` ([CLI](cli.md#parity-between-twins)) compares the metrics file of every twin pair in a build: the same snapshot name and theme on two platforms. It is a read: it changes no diff, fingerprint or review state, and it fails a run only with its own exit code, **8**. One function in `@hackcove/pixelslash-engine` (`compareParity`) does the comparing, and the CLI and `pixelslash mcp` call it.

### What is compared

Parts match **by name**. A part on one side only is a mismatch (`button.icon missing on android`). For each part on both sides:

| Fields | They match when |
| --- | --- |
| Lengths: `box` `x` `y` `w` `h`, `padding` (each side), `gap`, `font.lineHeight` | `abs(a - b) <= tol`, with `tol = max(1/scale_a, 1/scale_b)` logical px |
| `font.size`, `font.weight` | they are equal |
| Colours: `color.fg`, `color.bg`, `color.border` | they are equal as hex, alpha included, or the manifest allows that exact web-to-native pair |

- **The scale** is what a pixel is worth on that side. A native side's scale is its snapshot's `fingerprint.scale`; a web side's is the `deviceScaleFactor` when one was recorded, else 1. At scale 3 a 0.3 px difference matches and 0.5 does not; scales 2 and 3 give a tolerance of 0.5. `--json` names the scale each side used, and where it came from (`recorded` or `default`).
- **A field missing on either side is "not measured"**: it is not compared and is never a mismatch, and never read as zero. A part that has no `gap` on one platform and `gap: 8` on the other says nothing about parity.
- **Colours have no tolerance.** There is no colour distance (no ΔE): `#2563eb` and `#2564eb` differ. A difference is accepted only through the manifest.
- **A pair where either side has no metrics file is `not measured`**: counted and listed, never drift.

A mismatch reads as a sentence, grouped per snapshot and theme, then per part: `Button/md-primary dark: button height 38 web vs 40 android; button gap 8 vs 6`. The platform is named the first time in a part's list and left out after.

### The parity manifest

`pixelslash.parity.json` in the repo says which differences are on purpose. `pixelslash parity` reads it from the working directory when it exists, or from `--manifest PATH`. With no manifest there are no allowances.

```json
{
  "version": 1,
  "colors": [
    { "web": "#2563eb", "native": "#2461ea" },
    { "web": "#16a34a", "native": "#17a34b", "platform": "ios" }
  ],
  "differences": {
    "Button/md-primary": {
      "button": { "web": { "box.h": 38 }, "android": { "box.h": 40 } }
    },
    "Button/md-primary dark": {
      "button.icon": { "web": { "gap": 8 }, "ios": { "gap": 6 } }
    }
  }
}
```

- **`version`**: `1`.
- **`colors`**: an allowlist of `{ "web": "#rrggbb[aa]", "native": "#rrggbb[aa]" }`, lowercase hex. The pair is allowed when the web side has exactly `web` and the native side exactly `native`. `platform` (`android` or `ios`) narrows an entry to that native platform. The same web colour against a different native hex still fails.
- **`differences`**: keyed by snapshot name, or `name theme` (a space, then the theme) to narrow it to one theme; then the part; then, per platform, the field and the value it is declared to have there. A field of a part must be declared on at least two platforms. A declared field matches when each side equals its declared value within the same tolerance, and a matching difference is reported nowhere but `--json`'s `declared`.
- **Fields** are the table's: `box.x`, `box.y`, `box.w`, `box.h`, `padding.top`, `padding.right`, `padding.bottom`, `padding.left`, `gap`, `font.lineHeight`, `font.size`, `font.weight`, `color.fg`, `color.bg`, `color.border`.
- **A declaration that no longer applies is `stale`**: both sides agree now, or a side no longer has the declared value. It prints a `stale declaration: Button/md-primary button box.h: both sides agree now (40)` line and never fails the run. A declaration is stale only if it applied to no pair in the build.
- **A malformed manifest is exit 2**, naming the file and the field (`pixelslash.parity.json: manifest.colors[0].web must be lowercase hex`), before any request is made. An unknown key is refused too, so a misspelt `colours` cannot silently allow nothing.

## What a reader does

- **Unknown fields are ignored**, at any level: a reader keeps what it knows. **Unknown parts are ignored** too: a part is a name the reader has no opinion about.
- **A higher minor version is read** as the version it knows, ignoring what it does not recognise: `"1.7"` is read by a reader that knows `1.0`. A different **major** version (`"2.0"`) is refused.
- **A malformed file is refused**, naming the file and the field: not JSON, not an object, `version` not `"<major>.<minor>"`, `root` missing or not a part, a part without a `box`, a number that is not finite or is negative where it cannot be, a colour that is not `#rrggbb` or `#rrggbbaa`, a weight outside 1 to 1000, a name over 200 characters. `import` and `upload` exit 2; the server answers `400` with the same words.

## Where it is used

- **Capture** (`"metrics": true` in the config, off by default): see [Layout metrics in capture](cli.md#layout-metrics-per-shot). It reads every `[data-part]` element's box and computed style in the settled page at the moment of the shot.
- **Import**: `pixelslash import` takes `<name>.metrics.json` beside `<name>.png` ([Snapshots from PNGs you already have](cli.md#snapshots-from-pngs-you-already-have)).
- **Upload and API**: `pixelslash upload` sends the file with its snapshot and the server stores it ([Uploading to a server](cli.md#uploading-to-a-server)); the snapshot read gives a short-lived URL for it as `metrics_url` ([API](cli.md#api)); `pixelslash mcp` shows it on a snapshot read.
- **Parity**: `pixelslash parity` and the `get_parity` tool of `pixelslash mcp` compare the two files of each twin pair ([Parity](#parity)).
- **Review UI**: the snapshot side panel lists each part with its measurements when the snapshot has metrics.
