# Baselines and branches

A baseline is the image a new shot is measured against. Where it comes from depends on whether you compare on your own machine or on a server.

## On your own machine: the two sides you name

Locally there is no baseline to look up. You name both sides, and that is the comparison:

```
npx pixelslash compare snapshots/main snapshots/branch --out compare
```

Nothing is remembered between runs. Comparing against a different image means naming a different directory.

## On a server: what it looks up

A server you run stores every build, so it has to choose the baseline. It chooses one per shot. A shot's identity is its name, platform, browser, viewport and theme, so the mobile dark shot of a page has its own baseline.

The server tries two things, in this order:

1. **This branch's previous shot.** It takes the newest earlier build of this branch that holds the shot and was not rejected, whether or not anyone has reviewed it yet. A second run of one commit therefore reports nothing new, and the history carries across a rebase or an amend.
2. **The accepted shot at the merge-base or its ancestors.** The CLI sends the merge-base with your base branch and up to 200 of its ancestors. The server takes the nearest of those commits with an accepted shot, and the newest build if a commit has several. A commit newer than your merge-base is not considered, so work that landed after you branched does not appear in your diff.

An accepted shot is one in a build that passed, or a shot someone accepted by hand. On the default branch, every shot is accepted as it arrives.

A previous shot with an undecided change is not accepted, so it only counts as a baseline for a shot that matches it. That shot stays open and carries the undecided change with it. A shot that differs is measured against the accepted shot from step 2, so accepting a shot never approves a change nobody was shown.

## The first build

The first upload of a project's default branch has nothing to compare against. Every shot is new and accepted, and the build passes:

```
npx pixelslash capture --upload --out snapshots/main
npx pixelslash status --dir snapshots/main
```

```
passed: 0 waiting · 2 accepted · 0 rejected
```

## The first build on a branch

A branch with no build of its own goes straight to step 2, the accepted shots at its merge-base. Here a branch changed its button, and that showed up on both of its pages:

```
npx pixelslash capture --upload --out snapshots/branch
npx pixelslash status --dir snapshots/branch
```

```
changes: 2 waiting · 0 accepted · 0 rejected
```

`status` exits 5 while shots wait. [The review flow](review-flow.md) follows this build through to a decision.

## A shot not seen before

A shot with no baseline from either step is `new`. On a branch, it waits for review like a change does, because somebody should look at it once. Adding a third route to that branch gave:

```
changes: 1 waiting · 0 accepted · 0 rejected
```

A shot that the baseline had and this build does not is `removed`. It is listed, and it never blocks a build.

## Accepting

Accepting records that a person looked at a change and meant it. The accepted image then serves as the baseline in step 2 for commits that descend from it.

An acceptance reaches other builds that carry the same change, and it survives a rebase or an amend. A new commit on the branch that changes nothing visible has nothing to review:

```
passed: 0 waiting · 0 accepted · 0 rejected
```

`passed` means nothing is left to decide. It does not mean nothing differed.

## Why a rejected build is never a baseline

A baseline must be an image somebody could still approve of. So a build with a rejected shot ends `failed`, and failed builds are not candidates for a baseline, on this branch or any other. A build that errored is `failed`-equivalent here too: it is not a candidate either.

This has a useful effect. If you reject a change and upload the same pixels again, the new build is measured against the last good shot, and the change is back in front of you:

```
failed: 1 waiting · 0 accepted · 1 rejected
```

and after the next upload:

```
changes: 2 waiting · 0 accepted · 0 rejected
```

A rejection can't be undone by accepting another shot in that build. A rejected build can no longer be reviewed. The next build is what can pass.

## Flaky and unmeasured shots

Two more kinds of shot don't become baselines:

- A flaky shot under the `skip` policy, unless a reviewer accepted it by hand. See [Making shots stable](flaky-shots.md).
- A branch shot with no result, such as one from [another environment](fingerprints.md).

## Next

- [The review flow](review-flow.md): upload, wait, accept, reject.
- [Fingerprints and environments](fingerprints.md): when a server refuses to compare.
- [Uploading to a server](../cli.md#uploading-to-a-server): what the CLI sends.
