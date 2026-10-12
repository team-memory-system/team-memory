// The folders this computer's server holds conversations of, for the window that
// opens them to a teammate: each the folder a conversation started in, as the
// collector that sent it recorded it (a Honcho session's metadata.cwd), on whichever
// of the owner's computers it ran. A teammate's chat answers from the conversations
// of the folders opened to them; the MCP bridge finds those when the question comes
// (local-mcp-bridge/server.py), so nothing is filled in ahead of time.
import { configuredAccess, fetchHoncho, honchoHeaders } from "./honcho-access.mjs";

const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;
// Pages of a listing asked at once, once the first has said how many there are.
const PARALLEL = 4;

function honchoClient(config, fetchImpl) {
  const base = String(config?.honcho?.baseUrl || "http://127.0.0.1:8001").replace(/\/+$/, "");
  const headers = honchoHeaders({ token: config?.honcho?.apiToken, access: configuredAccess(config) }, { "Content-Type": "application/json", Accept: "application/json" });
  return async (method, apiPath, body) => {
    const response = await (fetchImpl || fetchHoncho)(`${base}${apiPath}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${apiPath}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };
}

/** Every session of `workspace`, a page at a time, each page given to `onPage`. */
async function sessionPages(call, workspace, onPage) {
  const listing = async (page) => {
    const data = await call("POST", `/v3/workspaces/${encodeURIComponent(workspace)}/sessions/list?page=${page}&size=${PAGE_SIZE}`, {});
    const items = Array.isArray(data.items) ? data.items : [];
    onPage(items);
    return { items, pages: Number(data.pages) || 0 };
  };
  const first = await listing(1);
  if (first.items.length < PAGE_SIZE) return;
  if (first.pages) {
    // A server with thousands of sessions: the rest a few pages at a time.
    const last = Math.min(first.pages, MAX_PAGES);
    let next = 2;
    const worker = async () => {
      while (next <= last) {
        const page = next;
        next += 1;
        await listing(page);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    return;
  }
  for (let page = 2; page <= MAX_PAGES; page += 1) {
    if ((await listing(page)).items.length < PAGE_SIZE) break;
  }
}

/**
 * `{ ok: true, workspace, sessions, noFolder, folders: [{ path, sessions, lastAt }] }`:
 * every folder a session of this server started in, with how many started there and
 * when the newest of them last got a turn. `noFolder` counts the sessions with no
 * folder (a browser chat), which no folder can open.
 */
export async function serverFolders({ config, fetchImpl } = {}) {
  const workspace = String(config?.honcho?.workspaceId || "memory");
  const call = honchoClient(config, fetchImpl);
  const folders = new Map();
  const ids = new Set();
  let noFolder = 0;
  await sessionPages(call, workspace, (items) => {
    for (const item of items) {
      if (!item?.id || ids.has(item.id)) continue;
      ids.add(item.id);
      const metadata = item.metadata || {};
      const cwd = typeof metadata.cwd === "string" ? metadata.cwd : "";
      if (!cwd) {
        noFolder += 1;
        continue;
      }
      const at = Date.parse(metadata.last_imported_at) || Date.parse(item.created_at) || 0;
      const entry = folders.get(cwd) || { path: cwd, sessions: 0, lastMs: 0 };
      entry.sessions += 1;
      entry.lastMs = Math.max(entry.lastMs, at);
      folders.set(cwd, entry);
    }
  });
  return {
    ok: true,
    workspace,
    sessions: ids.size,
    noFolder,
    folders: [...folders.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => ({ path: entry.path, sessions: entry.sessions, lastAt: entry.lastMs ? new Date(entry.lastMs).toISOString() : null })),
  };
}
