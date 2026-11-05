# Exit codes in plain words

Every command ends with a number from 0 to 8, and CI reads that number. The numbers are a contract: none of them changes meaning. This page says what each one tells a runner, and what to do about it.

## 0: it worked

The command did its job. For a comparison that means the report was written, whether or not anything changed. For `status` it means every changed shot was accepted, or nothing changed at all.

## 1: a verdict, and only one

`1` is the verdict number: **new design-system violations on Branch**. A run that found them fails the build, and a run that found none passes.

A few failures use the same number, and none of them is a visual result:

- `capture` and `check` exit 1 when the capture itself fails: a page that will not load, a `start` command that cannot come up, a `setup` that throws.
- `upload` exits 1 when the upload fails: the server refuses the build or a shot, the token is refused, the server has an error, or the build it opened ends `errored`.
- `project create` exits 1 when the server refuses the project.

No command exits 1 because a shot changed. If you are looking for "the page looks different", that is not this number.

## 2: the command line was wrong

A flag it does not know, a value that is not a number where one is needed, a missing argument, a config file that will not parse, no server named, not logged in, more than one build picked. Nothing was measured and nothing was uploaded.

The message names the flag or the file. Fix the invocation and run it again.

## 3: the server did not give what was asked

The token was refused, expired or revoked (401), the id is not one this token can reach (404), the server had an error, or it could not be reached at all. For `status` it also means the build `errored`, or there is no build at the commit or on the branch.

This is the remote reads' number, and the number of the wait phase of `upload --wait` once the build has been sent. The upload itself is different: every failure while `upload` is opening the build, sending a shot or finalising is 1, because the answer is about that upload.

`install-browser` exits 3 when the browser download fails.

This is not a verdict on your page. Check the server address and the token, then run it again.

## 4: a reviewer rejected a shot

`status` exits 4 when somebody rejected a change, so the build is `failed`. Fix what they saw and push a new commit. Accepting another shot in that build does not undo the rejection.

## 5: it is still waiting

`status` exits 5 while the build waits, either for the server to process it or for a person to review it. Under `--wait`, it also exits 5 when `--timeout` runs out with the build still waiting.

This is the normal answer from a CI job that is waiting for a review. Run the job again, or wait with a longer `--timeout`.

## 6: the flake is still there

`flake` exits 6 when the shot is still unstable on your machine: at least one run differed from the first. It is not 1, because 1 stays reserved for new violations.

A stable shot exits 0. Fix the cause, then `--resolve`.

## 7: a bug in PixelSlash

A crash, or a `compare` shot the diff could not measure. It is never a problem with your page or your config, and never a visual result.

**A runner that sees 7 must escalate, not retry.** Read the `FAILED` line, keep the stack, and report it. Do not read exit 7 as "the page changed" and do not paper over it with a retry.

## 8: a twin pair drifted

`parity --build` exits 8 when a twin pair's layout metrics differ beyond tolerance and the manifest does not declare it. With `--release`, it also exits 8 when a twin is stale on that platform.

It never exits 1: 1 is for new design-system violations.

## The `FAILED` line

Any error PixelSlash did not expect writes this to stderr, and then exits 7:

```
pixelslash: FAILED <command>: <stage>: <message>
nothing was uploaded
a runner seeing exit 7 must escalate to the PixelSlash planner: this is a bug in pixelslash
<the stack>
```

- The first line is one plain line to grep for. `<stage>` is the step that was running: `capture`, `compare` or `upload`. `check` and `dev` have no stage, so their line has no stage either.
- The second line says what reached the server. Before the build opened it is `nothing was uploaded`; after some PNGs went it is `upload incomplete: 2/5 shots sent`; after the server finalised the build it is `the upload had finished: 5/5 shots sent`.
- The third line is the instruction: this is a bug, so escalate.

An `upload` that fails ends differently. The last two lines of stderr are the upload line and `UPLOAD FAILED: <reason>`, no build link is printed, and the exit is 1: whoever refused the upload and whatever the answer, an upload that did not finish is not a verdict. The one exception is `upload --wait`, which exits as `status` does once the build has been sent. A build the server could not measure is an upload failure too, and also exits 1.

## What CI should read

| Command | Exits you will see |
| --- | --- |
| `capture` | 0, 1, 2, 7 |
| `compare` | 0, 2, 7 |
| `check` | 0, 1, 2, 3, 7 |
| `upload` | 0, 1, 2, 7 |
| `upload --wait` | 0, 1, 2, 3, 4, 5, 7 |
| `status` | 0, 2, 3, 4, 5, 7 |
| `builds`, `build`, `flakes` | 0, 2, 3, 7 |

`capture` and `compare` exit 0 whether or not anything changed: they measure. `upload` exits 0 when the upload worked, not when the change is approved. Only `status` turns a review into a pass or a fail, which is why [the review flow](../concepts/review-flow.md) ends on it. Any exit not in a command's row is 7, a bug.

## Next

- [The review flow](../concepts/review-flow.md): where 4 and 5 come from.
- [Troubleshooting](troubleshooting.md): the exact message behind each failure.
- [Exit codes and the `FAILED` line](../cli.md#exit-codes-and-the-failed-line): the same contract, next to the commands.
