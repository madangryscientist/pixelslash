/**
 * Who may open the operator health page (PS-330). A deployment names its operators in
 * `PIXELSLASH_ADMIN_LOGINS`, a comma-separated list of GitHub logins. The page is a 404 for
 * everyone else, so nothing tells an outsider it exists: the variable unset is the whole feature
 * switched off.
 */

/** The logins of the list, lowercased (GitHub logins are case-insensitive); blanks are dropped. */
function adminLoginsOf(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login.length > 0);
}

/** Whether the signed-in viewer (null when signed out) is on the list. */
export function isAdmin(viewer: { login: string } | null, raw: string | undefined): boolean {
  if (!viewer) return false;
  return adminLoginsOf(raw).includes(viewer.login.toLowerCase());
}
