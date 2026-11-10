import { CLI_SPLIT } from "./cli-pages.ts";

/**
 * `/docs#anchor` was the one page before the split. A hash never reaches the server, so the index
 * carries the answer: a tiny script that sends an old anchor to the page that now holds it.
 */
function oldAnchorScript(anchorPage: ReadonlyMap<string, string>): string {
  const map = JSON.stringify(Object.fromEntries(anchorPage));
  return `(function(){var h=decodeURIComponent(location.hash.slice(1));if(!h)return;var m=${map};if(Object.prototype.hasOwnProperty.call(m,h))location.replace("/docs/"+m[h]+"#"+h)})()`;
}

export const OLD_ANCHOR_SCRIPT = oldAnchorScript(CLI_SPLIT.anchorPage);
