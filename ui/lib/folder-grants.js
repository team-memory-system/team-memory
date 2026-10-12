// What a teammate's chat may answer from: folders, each the path conversations
// started in as a collector recorded it (a Honcho session's metadata.cwd), and
// whether the folders inside it open too, those made later included. The owner
// ticks folders in a tree (folder-tree.js); this turns the ticks into the fewest
// entries that open the same folders, and entries back into ticks. The MCP bridge
// matches sessions to entries by the same rule (local-mcp-bridge/server.py).
import { shortPath } from "./collect.js";

const DRIVE = /^[A-Za-z]:\//;
// Folders that hold people's home folders (as folderKey writes them): they never open
// with what is inside them, whatever the tree shows under them.
const HOME_HOLDERS = /^(?:\/|\/Users|\/home|[a-z]:\/|[a-z]:\/users)$/;

/**
 * A path as it is compared: \ read as /, repeated / as one, no / at the end but on
 * the root itself, and a Windows path (C:/…) in any case.
 */
export function folderKey(value) {
  let key = String(value || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (key.length > 1 && key.endsWith("/") && !/^[A-Za-z]:\/$/.test(key)) key = key.slice(0, -1);
  if (/^[A-Za-z]:$/.test(key)) key += "/";
  return DRIVE.test(key) ? key.toLowerCase() : key;
}

/** Whether `entry` ({ path, subfolders }) opens the conversations that started in `folder`. */
export function folderOpens(entry, folder) {
  const opened = folderKey(entry?.path);
  const asked = folderKey(folder);
  if (!opened || !asked) return false;
  if (asked === opened) return true;
  // A root keeps its / (/ or c:/), so the folders under it start with it as it is.
  return Boolean(entry.subfolders) && asked.startsWith(opened.endsWith("/") ? opened : `${opened}/`);
}

/**
 * Every path a row stands for: `paths` when the same folder of several computers
 * shows as one row (each its own home under ~), else its `path`.
 */
export function rowPaths(item) {
  return Array.isArray(item?.paths) && item.paths.length ? item.paths : [item.path];
}

/** The rows of `items` that `entries` open on any of their paths: the ticks of a grant. */
export function grantedPaths(items, entries) {
  const list = Array.isArray(entries) ? entries : [];
  return new Set(items
    .filter((item) => rowPaths(item).some((folder) => list.some((entry) => folderOpens(entry, folder))))
    .map((item) => item.path));
}

/**
 * Where `displayKey`, a folder of the tree, is on the computer `folder` was recorded
 * on: the tree shows that computer's home folder as ~ (collect.js shortPath), so a
 * folder under ~ is the home `folder` starts with followed by the rest, written with
 * that computer's separator.
 */
function realPrefix(folder, display, displayKey) {
  if (!displayKey.startsWith("~") || !display.startsWith("~")) return displayKey;
  const home = folder.slice(0, folder.length - display.length + 1);
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  return `${home}${displayKey.slice(1).replace(/[\\/]/g, sep)}`;
}

/**
 * The fewest entries that open what `checked` (paths of rows) ticks, walking `tree`
 * (folder-tree.js folderTree of the rows): a folder all of whose conversations are
 * ticked opens with the folders inside it, those made later too; a folder whose own
 * conversations alone are ticked opens alone. A folder under ~ may hold the same
 * folder of several computers, and opens on each of them. A folder that holds a home
 * folder (/, /Users, C:\) never opens with what is inside it: the home shows under ~
 * in a row of its own, and ticking the folders beside it must not open it too.
 */
export function grantFromTicked(tree, checked) {
  const entries = [];
  const seen = new Set();
  const add = (folder, subfolders) => {
    const key = `${subfolders}:${folderKey(folder)}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ path: folder, subfolders });
  };
  const shown = (item) => String(item.display || item.path);
  const homes = new Set(tree.flatMap((root) => root.items)
    .filter((item) => shown(item).startsWith("~"))
    .flatMap((item) => rowPaths(item).map((folder) => folderKey(realPrefix(folder, shown(item), "~")))));
  const holdsHome = (folder) => {
    const key = folderKey(folder);
    return HOME_HOLDERS.test(key) || [...homes].some((home) => home !== key && home.startsWith(`${key}/`));
  };
  const walk = (node) => {
    const ticked = node.items.filter((item) => checked.has(item.path));
    if (!ticked.length) return;
    if (ticked.length === node.items.length) {
      const prefixes = [...new Set(node.items.flatMap((item) => rowPaths(item).map((folder) => realPrefix(folder, shown(item), node.key))))];
      if (!prefixes.some(holdsHome)) {
        for (const prefix of prefixes) add(prefix, true);
        return;
      }
    }
    if (node.item && checked.has(node.item.path)) {
      for (const folder of rowPaths(node.item)) add(folder, !node.children.length && !holdsHome(folder));
    }
    for (const child of node.children) walk(child);
  };
  for (const root of tree) walk(root);
  return entries;
}

/**
 * The folders this server holds conversations of (`/api/team/folders`) as rows of the
 * folder tree: the home folder shown as ~, one row for the same folder of several
 * computers (`paths`), and each folder `chosen` opens that holds none yet, so what is
 * open stays in sight.
 */
export function folderRowsOf(listed, chosen = []) {
  const rows = new Map();
  const add = (folder, count) => {
    const display = shortPath(folder);
    // The tree reads \ and / alike, so ~\dev and ~/dev are one folder in it.
    const key = display.replace(/\\/g, "/");
    const row = rows.get(key);
    if (row) {
      row.paths.push(folder);
      row.count += count;
    } else rows.set(key, { path: folder, paths: [folder], display, count });
  };
  for (const folder of listed) add(folder.path, Number(folder.sessions || 0));
  const held = [...rows.values()].flatMap((row) => row.paths);
  for (const entry of chosen) if (!held.some((folder) => folderOpens(entry, folder))) add(entry.path, 0);
  return [...rows.values()];
}
