# Jenkins

Capture the base branch and this branch in the pinned image, compare them, keep the report as an artifact, and fail the build when anything differs.

**Not tested on Jenkins.** The Jenkinsfile on this page has not been run. The shell steps it calls ran on a GitHub Actions `ubuntu-24.04` runner on 2026-11-05, unchanged. If something differs on Jenkins, it is more likely to be in the file below than in the scripts.

## The gate, first

A pixel-only run exits 0, changed or not. When a run finishes, exit 1 means one thing: new design-system violations on Branch, from a run with `--ds` and a judge. A capture that cannot finish, such as a server that is down, also exits 1, and fails the job too. So `compare` will not fail a job because pixels moved, and there are two ways to make a gate:

- **Without a server: a script over `compare`'s output.** `compare` prints a counts line made for scripts to read, `pixelslash: N changed, N unchanged, N new, N removed`. The script below exits 1 unless changed, new and removed are all 0. Any difference fails the job, wanted or not, and someone reads the report. This page sets up this gate.
- **On review: a server.** On a server you run yourself ([self-hosting](../../apps/web/SELF-HOST.md)), `pixelslash upload --wait`, or `status --wait` on its own, holds the job until a person has decided: exit 0 for accepted or unchanged, 4 for rejected, 5 for still waiting. See [Run a review server](review-server.md).

## The agent

The script runs `docker run --network host -v "$PWD:/work"`, so the agent needs docker on the same machine as its workspace. This page assumes an agent labelled `docker`.

## The files

The repository has a static page in `site/`. Yours has an app.

`pixelslash.config.ts`. A config has one `baseUrl`, and the job captures two servers, so it comes from the environment:

```ts
export default {
  baseUrl: process.env.BASE_URL ?? "http://localhost:4101",
  routes: ["/"],
  variants: [{ viewport: { width: 1280, height: 720 }, theme: "light" }],
};
```

`ci/visual-gate.sh`, the gate. It takes the compare command as its arguments:

```sh
#!/bin/sh
# Usage: visual-gate.sh COMPARE_COMMAND...   (the command, ending at its --out DIR)
# Exit 0 only when compare says nothing differs. compare's own code passes through.
out=$("$@")
code=$?
printf '%s\n' "$out"
[ "$code" -eq 0 ] || exit "$code"
case "$out" in
  *"pixelslash: 0 changed, "*" unchanged, 0 new, 0 removed"*) exit 0 ;;
esac
echo "visual gate: differences found, read the report" >&2
exit 1
```

`ci/visual-check.sh`, the whole job as plain shell:

```sh
#!/bin/sh
# Capture the base branch and this checkout in the pinned image, compare, gate.
# Needs: git with full history, docker that can use the host network, python3.
set -eu

IMAGE="ghcr.io/madangryscientist/pixelslash-capture@sha256:d8b33a8e9fac68f41d04e5295cdf7b57ab22affca73f081f2b18241d2e633fff"
BASE_REF="${BASE_REF:-origin/main}"

docker pull "$IMAGE"
DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' "$IMAGE")

pixelslash() {
  docker run --rm --network host -v "$PWD:/work" \
    -e BASE_URL -e PIXELSLASH_IMAGE_DIGEST="$DIGEST" "$IMAGE" "$@"
}

# Serve both versions. A real app starts its own server here.
git worktree add --detach .base "$BASE_REF"
python3 -m http.server 4101 --directory .base/site >/dev/null 2>&1 &
main_server=$!
python3 -m http.server 4102 --directory site >/dev/null 2>&1 &
branch_server=$!
trap 'kill "$main_server" "$branch_server"; git worktree remove --force .base' EXIT
sleep 1

export BASE_URL=http://localhost:4101
pixelslash capture --out snapshots/main
export BASE_URL=http://localhost:4102
pixelslash capture --out snapshots/branch

sh ci/visual-gate.sh docker run --rm -v "$PWD:/work" "$IMAGE" \
  compare snapshots/main snapshots/branch --out pixelslash-report
```

The two `python3` lines stand for "start your app": `site/` is a static page here. Put your own start command in their place, one server per version. The image is the whole CLI, so nothing else needs installing, and its digest is what keeps two runs comparable: see [Pin versions in CI](pin-versions.md).

`Jenkinsfile`:

```groovy
pipeline {
  agent { label 'docker' }
  stages {
    stage('Visual check') {
      steps {
        sh 'git fetch origin main:refs/remotes/origin/main'
        sh 'sh ci/visual-check.sh'
      }
    }
  }
  post {
    always {
      archiveArtifacts artifacts: 'pixelslash-report/**', allowEmptyArchive: true
    }
  }
}
```

`post { always }` keeps the report when the gate fails, which is when you want it.

## Root-owned files

The container runs as root, so what it writes in the mounted directory belongs to root. A hosted runner is thrown away after the job, but a Jenkins workspace stays, and the next build may not be able to clean it. Running the container as the agent's user avoids that. For a capture, this ran on the GitHub Actions runner, and its files belonged to the runner's user. This is the form that ran, with the config and the output directory as mounts:

```
docker run --rm --user "$(id -u):$(id -g)" --network host \
  -v "$PWD/as-user:/work/as-user" -v "$PWD/pixelslash.config.ts:/work/pixelslash.config.ts" \
  -e HOME=/tmp "$IMAGE" capture --out as-user/snaps
```

`compare` was not run that way.

## What a failing run prints

A pull request that turned a button green ended like this, as the plain shell ran on a GitHub Actions runner:

```
timing: 1 shot, diff 0.0s, total 0.1s
visual gate: differences found, read the report
pixelslash: 1 changed, 0 unchanged, 0 new, 0 removed
changed:
  index (chromium 1280x720)
report: file:///work/pixelslash-report/index.html
```

The job exits 1. With nothing different, the counts line is `pixelslash: 0 changed, 1 unchanged, 0 new, 0 removed`, and the job exits 0. If `compare` itself fails, its own code comes through: 2 for a bad directory, 7 when a shot could not be diffed.

## Next

- A run that was tested, with its report: [GitHub Actions](github-actions.md).
- Make the job wait for a person's yes: [Run a review server](review-server.md).
