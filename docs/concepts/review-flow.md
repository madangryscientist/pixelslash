# The review flow

The diff can tell you that a change happened. Only a person can say whether it was meant. A server records that decision, and CI reads it.

Everything on this page runs on a server you run yourself. [Self-hosting](../../apps/web/SELF-HOST.md) has how to set one up, and [Run a review server](../ci/review-server.md) has the first upload step by step.

## The steps

1. **Upload.** CI captures the shots and sends them to the server, which opens a build.
2. **Wait.** CI waits on the build. Shots that changed wait for a person.
3. **Decide.** Someone accepts or rejects each change in the server's web app.
4. **Exit.** The waiting job exits with the result, and CI passes or fails on it.

## Upload

```
npx pixelslash capture --upload --out snapshots/branch
```

```
pixelslash: uploaded 2 snapshots
build: d834e691-… (94bca17 on new-button)
```

This exits 0: the upload worked. It does not mean the change is approved. The command writes `build.json` into the snapshot directory, which is how the next step finds the build. [Baselines and branches](baselines-and-branches.md) has how each shot gets its baseline.

## Wait

`status` reports where the build stands. With `--wait` it keeps checking until there's a decision or the time runs out:

```
npx pixelslash status --dir snapshots/branch --wait --interval 2s --timeout 6s
```

```
waiting on build d834e691-…: changes: 2 waiting · 0 accepted · 0 rejected
build d834e691-…  http://localhost:4700/projects/f8e1c8c0-…/builds/d834e691-…
changes: 2 waiting · 0 accepted · 0 rejected
still waiting after 6s
```

That exits 5. By default it checks every 15 seconds for up to 30 minutes. You can wait in the upload step itself:

```
npx pixelslash upload snapshots/branch --wait --timeout 30m
```

## Accept or reject

The build's page in the web app shows the change. Each decision records who made it and when.

- **Accept** means the change was meant. `a` accepts a shot, and **Accept all** takes every change in the build.
- **Reject** means it wasn't. `r` rejects a shot.

The CLI has no command for this, and neither does the API or the agent tools. A review decision is a person's.

Accepting all skips a flaky shot under the `skip` policy, so a shot nobody could judge isn't approved by accident.

A decision reaches other builds that carry the same change. Rejecting one shot in a re-run also failed the earlier build of that commit:

```
failed: 1 waiting · 0 accepted · 1 rejected
```

One rejection fails the build, even with other shots still waiting. A rejected build can't be reviewed any further, so the way forward is a new build.

## The exit codes CI reads

| Exit | `status` | What to do |
| --- | --- | --- |
| 0 | Every change accepted, or nothing changed | Carry on |
| 4 | Something was rejected | Fix it and push |
| 5 | Still waiting, or `--timeout` ran out | Review it, or run the job again |
| 3 | The server refused or could not answer, or the build errored | Read the message |

A run after everything was accepted:

```
npx pixelslash status --dir snapshots/branch3 --wait
```

```
passed: 0 waiting · 2 accepted · 0 rejected
```

That exits 0. [Exit codes](../help/exit-codes.md) has all of them, and [Block CI on review](../cli.md#block-ci-on-review) has the flags.

## What counts as blocking

A build ends in one of these states:

- **`passed`**: nothing left to decide. It doesn't mean nothing differed.
- **`changes`**: something is waiting.
- **`failed`**: something was rejected.
- **`errored`**: the server could not measure the build.

These wait for a decision: a shot that changed, a new shot, an unchanged shot that carries an open change, and a flaky shot under `review`. These don't: a removed shot, and a flaky shot under `skip`.

## A build with no snapshot directory

A later job, or a job on another runner, may not have `build.json`. Name the build instead:

```
npx pixelslash status --commit 94bca17… --wait
```

`--commit` takes the full sha, as `$COMMIT_SHA` or similar in CI, and not `HEAD`. `--build ID` and `--branch NAME` work too.

## Next

- [Run it in CI](../ci/github-actions.md): the whole workflow file.
- [Baselines and branches](baselines-and-branches.md): what an accepted shot does next.
- [Troubleshooting](../help/troubleshooting.md): when an upload or a build fails.
