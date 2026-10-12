// The folders the server holds conversations of, for the window that opens them to a
// teammate: every page of the workspace's sessions read, a session that moved across
// a page boundary counted once, and the newest turn of each folder kept.
import assert from "node:assert/strict";
import test from "node:test";

import { serverFolders } from "../scripts/server-folders.mjs";

test("every page of sessions is read, and each session counts once", async () => {
  const session = (index) => ({
    id: `s${index}`,
    created_at: "2026-10-01T00:00:00.000Z",
    metadata: index % 50 === 0 ? {} : { cwd: index % 2 ? "/Users/me/dev/a" : "C:\\Users\\me\\b", last_imported_at: `2026-10-${String(1 + (index % 9)).padStart(2, "0")}T00:00:00.000Z` },
  });
  const all = Array.from({ length: 250 }, (_, index) => session(index));
  const asked = [];
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    asked.push(`${init.method} ${pathname}?${searchParams}`);
    const page = Number(searchParams.get("page"));
    const size = Number(searchParams.get("size"));
    // The second page also carries the first page's last session, as a list that
    // changed while it was read does.
    const items = all.slice((page - 1) * size, page * size);
    if (page === 2) items.unshift(all[size - 1]);
    return new Response(JSON.stringify({ items, total: all.length, page, size, pages: Math.ceil(all.length / size) }), { status: 200 });
  };
  const config = { honcho: { baseUrl: "http://honcho.test/", workspaceId: "memory" } };
  const result = await serverFolders({ config, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.workspace, "memory");
  assert.equal(result.sessions, 250);
  assert.equal(result.noFolder, 5);
  assert.deepEqual(result.folders, [
    { path: "/Users/me/dev/a", sessions: 125, lastAt: "2026-10-09T00:00:00.000Z" },
    { path: "C:\\Users\\me\\b", sessions: 120, lastAt: "2026-10-09T00:00:00.000Z" },
  ]);
  assert.deepEqual(asked.sort(), [1, 2, 3].map((page) => `POST /v3/workspaces/memory/sessions/list?page=${page}&size=100`));
});

test("a server that answers with an error says which", async () => {
  const fetchImpl = async () => new Response("no", { status: 401 });
  await assert.rejects(serverFolders({ config: { honcho: { baseUrl: "http://honcho.test" } }, fetchImpl }), /^Error: HTTP 401 for \/v3\/workspaces\/memory\/sessions\/list/);
});
