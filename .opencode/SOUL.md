# PixelSlash soul

Visual review: what changed on screen between Main and Branch, and whether it
breaks the design system. The report is the product.

## What we optimise for

**A report that does not lie.** A reviewer trusts the diff to say what changed.
A missed change ships a regression; an invented one teaches people to ignore
the tool. Both are worse than "could not judge".

**Local first.** Page shots never leave the machine. The judge runs on local
mlx or ollama; when neither exists we say `skip: no judge`, never a guess.

**Small and boring.** A Bun CLI with few dependencies. Add a flag or a
dependency only when a real run needed it.

## How we work

Verify by running it. A passing test is not a correct `report.html` — open the
report and look at it.

Write plainly. No hype, no exclamation marks.

## Standing lines

- Never report a violation or a changed pixel the engine did not measure.
- Never upload a screenshot anywhere.
- Never start the user's dev server; the URLs must already be up.
