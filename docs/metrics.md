# Layout metrics file (version 1)

A snapshot can carry a second file next to its PNG: the **layout metrics** of the screen at the moment of the shot. A PNG says what the screen looks like; the metrics file says what each named part measured and was styled with, so two shots of one screen on two platforms (a web page and an Android or iOS build of it) can be read part by part.

This page is the contract. A web capture writes the file itself (`"metrics": true`, below); a native test suite writes it with its own emitter, against this schema. PixelSlash reads, stores and shows the file; nothing in this version compares two of them.

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

## What a reader does

- **Unknown fields are ignored**, at any level: a reader keeps what it knows. **Unknown parts are ignored** too: a part is a name the reader has no opinion about.
- **A higher minor version is read** as the version it knows, ignoring what it does not recognise: `"1.7"` is read by a reader that knows `1.0`. A different **major** version (`"2.0"`) is refused.
- **A malformed file is refused**, naming the file and the field: not JSON, not an object, `version` not `"<major>.<minor>"`, `root` missing or not a part, a part without a `box`, a number that is not finite or is negative where it cannot be, a colour that is not `#rrggbb` or `#rrggbbaa`, a weight outside 1 to 1000, a name over 200 characters. `import` and `upload` exit 2; the server answers `400` with the same words.

## Where it is used

- **Capture** (`"metrics": true` in the config, off by default): see [Layout metrics in capture](cli.md#layout-metrics-per-shot). It reads every `[data-part]` element's box and computed style in the settled page at the moment of the shot.
- **Import**: `pixelslash import` takes `<name>.metrics.json` beside `<name>.png` ([Snapshots from PNGs you already have](cli.md#snapshots-from-pngs-you-already-have)).
- **Upload and API**: `pixelslash upload` sends the file with its snapshot and the server stores it ([Uploading to a server](cli.md#uploading-to-a-server)); the snapshot read gives a short-lived URL for it as `metrics_url` ([API](cli.md#api)); `pixelslash mcp` shows it on a snapshot read.
- **Review UI**: the snapshot side panel lists each part with its measurements when the snapshot has metrics.
