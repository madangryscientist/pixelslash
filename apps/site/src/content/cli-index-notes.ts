/*
 * The flag lines of the command index (cli-index.ts), for the flags cli.md does not describe where
 * a bullet or a table row can be lifted from.
 */

/**
 * One line for a flag cli.md does not describe where a bullet or a table row can be lifted from. The
 * prose wins when it has the flag; a test requires every flag of the index to have a line either way.
 * A key of `<command> <flag>` is for that command only and beats the bare flag.
 */
export const FLAG_NOTES: Readonly<Record<string, string>> = {
  "--url": "Shoot this page instead of a config's routes.",
  "--storybook": "The Storybook this project captures, without probing for it.",
  "--viewports": "The viewports to shoot, as WxH separated by commas.",
  "--themes": "The themes to shoot: light, dark, or both.",
  "--server":
    "The review server to talk to; else PIXELSLASH_SERVER, else the config's upload.server.",
  "--project":
    "The project, by id or name; else the config's upload.project, else the only one the token sees.",
  "--yes": "Take the default for every question not answered by a flag.",
  "--force": "Overwrite a config that already exists.",
  "--only": "Capture just these routes or stories; repeat it for more.",
  "--upload": "Send the snapshots to the server as a build once they are shot.",
  "--token-path": "A file holding the token; else PIXELSLASH_TOKEN, else the one `login` stored.",
  "--base":
    "The branch the build is compared against; else the config's upload.baseBranch, else main.",
  "--branch": "The branch name the build is recorded under.",
  "--pr": "The pull request number the build is recorded under.",
  "--flake-retries":
    "How many more times a shot that differs from its baseline is captured (default 2); 0 turns it off.",
  "--concurrency":
    "How many shots run at once, 1 to 32, over the config's concurrency; it also bounds the re-captures of changed shots.",
  "--brief": "A file holding your own words on what the build means to change.",
  "--brief-text": "Your own words on what the build means to change, given inline.",
  "--wait":
    "Wait until the server decides the build, then exit with the code that decision maps to: 0 accepted or nothing changed, 4 a reviewer rejected a shot, 5 still waiting when `--timeout` ends, 3 the build errored or the server could not be reached.",
  "--timeout": "How long to wait before giving up, such as 30m.",
  "--interval": "How often to read the build while waiting, such as 15s.",
  "--viewport": "The viewport of these PNGs, as WxH.",
  "--theme": "The theme of these shots: light or dark.",
  "--renderer": "A label for what drew the PNGs, kept with the snapshots.",
  "--device": "The device the native screenshots came from, such as a phone model.",
  "--scale": "The device's pixel ratio, a number above 0.",
  "--build": "The build to read, by id.",
  "--manifest":
    "The parity manifest; else pixelslash.parity.json in the working directory when it exists.",
  "--release": "The release check for one native platform: android or ios.",
  "--local": "Branch: the URL of your change, which must already be up.",
  "--local-png": "Branch: a screenshot you already have.",
  "--live-png-dir": "Main: a directory of screenshots, one per route.",
  "--local-png-dir": "Branch: a directory of screenshots, one per route.",
  "--file": "A Figma file key to take the design system from.",
  "--width": "The width to shoot the pages at, in pixels (default 1280).",
  "--label": "A name for the run, kept in the manifest and shown in the report.",
  "--limit": "How many builds to list, 1 to 100.",
  "--commit": "Read the newest build at this commit.",
  "--dir": "The snapshot dir whose build.json names the build.",
  "--org": "The organisation to create the project in.",
  "--runs": "How many times to capture the shot, 2 to 50 (default 5).",
  "--note": "Why the flake is resolved, at most 200 characters.",
  "--figma-token-path": "A file holding the Figma token; else FIGMA_TOKEN.",
  "--watch":
    "Watch only these paths instead of the git working tree; repeat it or separate with commas.",
  "--against": "What to compare with: main for the server's baselines, previous for the last run.",
  "--refresh-refs": "Fetch the Figma references again.",
  "--once": "Run once and exit, without the live page or the watcher.",
  "--config": "The config file; else the first pixelslash.config.* in the working directory.",
  "--json": "Print the result as JSON instead of text.",
  "capture --out": "The snapshot dir to write (default pixelslash-snapshots).",
  "check --out": "The snapshot dir to write (default pixelslash-snapshots).",
  "import --out": "The snapshot dir to write the imported PNGs into.",
  "flake --out": "Where to write the run's files.",
  "compare --out": "The directory the run writes its report and shots to (default .pixelslash).",
  "--judge": "Judge the shots against the design system with a vision model.",
  "--ds": "A directory of design-system files to judge the shots against.",
  "dev --viewport": "The viewport to shoot, as WxH or a configured name.",
  "builds --branch": "Only the builds of this branch.",
  "build --branch": "With `latest`, the newest build of this branch.",
  "status --branch": "Read the newest build of this branch.",
  "--routes": "A file of paths to shoot, one per line.",
  "init --routes": "The paths to shoot, separated by commas.",
  "--write": "List the config changes that would calm the flake and write the one you pick.",
  "--suggest": "List the same config changes and write nothing.",
  "--resolve": "Mark the flake resolved on the server, once a run came out stable.",
  "--platform": "web (the default), android or ios: what drew the PNGs.",
  "--live": "Main: the URL of the version you trust, which must already be up.",
  "--live-png": "Main: a screenshot you already have.",
  "--ignore": "An area x,y,w,h in image pixels that the diff skips; repeat it for more.",
  "--browser": "The browser engine for both pages: chromium (default), firefox or webkit.",
};
