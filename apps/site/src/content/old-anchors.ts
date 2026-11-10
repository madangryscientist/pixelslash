import { ANCHOR_PAGE } from "virtual:cli-meta";

/**
 * `/docs#anchor` was the one page before the split. A hash never reaches the server, so the index
 * carries the answer: a tiny script that sends an old anchor to the page that now holds it.
 */
function oldAnchorScript(anchorPage: Readonly<Record<string, string>>): string {
  const map = JSON.stringify(anchorPage);
  return `(function(){var h=decodeURIComponent(location.hash.slice(1));if(!h)return;var m=${map};if(Object.prototype.hasOwnProperty.call(m,h))location.replace("/docs/"+m[h]+"#"+h)})()`;
}

export const OLD_ANCHOR_SCRIPT = oldAnchorScript(ANCHOR_PAGE);
