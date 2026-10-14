// The owner's side of the gate's files: access.json, which says who may do what on
// this computer's shared server, and devices.json, which only the gate writes. What
// matters: only what the gate reads is ever written, one change never loses
// another, chat is opened with a list of folders and apps, turned off for now and
// on again, and closed, a computer is cut off by its id, and the list of computers
// names no key.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  changeGateAccess,
  DEFAULT_TOOLS,
  gateDevices,
  gateGrants,
  gateStatePaths,
  gateTeamTools,
  grantChat,
  grantCollect,
  normalizeGateAccess,
  OPENABLE_TOOLS,
  readGateAccess,
  revokeDevice,
  revokePerson,
  setChatOff,
  setGateOwners,
  setTeamTools,
  toolList,
} from "../scripts/gate-access.mjs";

async function tempPaths(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-access-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return gateStatePaths({ serverDirectory: path.join(dir, "server") });
}

const HONCHO = { path: "/Users/me/dev/honcho", subfolders: true };
const WEB = { path: "C:\\Users\\me\\web-app", subfolders: false };

test("the gate's folder is <runtime>/gate beside the server, as Compose mounts ../runtime/gate", () => {
  const paths = gateStatePaths({ serverDirectory: path.join("/apps", "team-memory", "server") });
  assert.equal(paths.dir, path.resolve("/apps", "team-memory", "runtime", "gate"));
  assert.equal(paths.accessFile, path.join(paths.dir, "access.json"));
  assert.equal(paths.devicesFile, path.join(paths.dir, "devices.json"));
});

test("owners, chat with folders and collecting are written as the gate reads them", async (t) => {
  const paths = await tempPaths(t);
  assert.deepEqual(await readGateAccess(paths), { version: 1, owners: [], workspace: "memory", people: {}, revokedDevices: [] });
  await setGateOwners(paths, { owners: ["Me@Example.com"], workspace: "memory" });
  await grantChat(paths, {
    email: "alice@example.com",
    peer: "alice",
    folders: [HONCHO, WEB, { path: "" }, { path: "/a\nb", subfolders: true }, { path: "x".repeat(1025) }, "/Users/me", HONCHO, { path: "/Users/me/notes", subfolders: "yes" }],
  });
  await grantCollect(paths, { email: "bob@example.com", peer: "bob", workspace: "memory" });
  const access = JSON.parse(await fs.readFile(paths.accessFile, "utf8"));
  assert.deepEqual(access.owners, ["me@example.com"]);
  assert.deepEqual(access.people["alice@example.com"].chat.folders, [HONCHO, WEB, { path: "/Users/me/notes", subfolders: false }],
    "a bad path and a repeat are dropped, and only subfolders: true opens the folders inside");
  assert.equal(access.people["alice@example.com"].peer, "alice");
  assert.equal(access.people["bob@example.com"].collect.workspace, "memory");
  if (process.platform !== "win32") {
    // The gate's own user in its container reads it; it holds no secret.
    assert.equal((await fs.stat(paths.accessFile)).mode & 0o777, 0o644);
  }

  // Changing the folders keeps when chat was first opened.
  const since = access.people["alice@example.com"].chat.since;
  await grantChat(paths, { email: "alice@example.com", folders: [WEB] });
  const changed = await readGateAccess(paths);
  assert.deepEqual(changed.people["alice@example.com"].chat.folders, [WEB]);
  assert.equal(changed.people["alice@example.com"].chat.since, since);

  // Apps open beside the folders: only well-formed names, once each.
  await grantChat(paths, { email: "alice@example.com", folders: [WEB], sources: ["chatgpt", "ChatGPT", "chat gpt", "", 7, "chatgpt", "x".repeat(33)] });
  assert.deepEqual((await readGateAccess(paths)).people["alice@example.com"].chat.sources, ["chatgpt"]);

  // Turned off for now and on again, with what is open kept, and kept off while the
  // folders change. A teammate never opened to cannot be turned on.
  await setChatOff(paths, { email: "Alice@Example.com", off: true });
  let chat = (await readGateAccess(paths)).people["alice@example.com"].chat;
  assert.deepEqual(chat, { folders: [WEB], sources: ["chatgpt"], tools: [...DEFAULT_TOOLS], off: true, since });
  await grantChat(paths, { email: "alice@example.com", folders: [HONCHO], sources: ["chatgpt"] });
  chat = (await readGateAccess(paths)).people["alice@example.com"].chat;
  assert.deepEqual(chat, { folders: [HONCHO], sources: ["chatgpt"], tools: [...DEFAULT_TOOLS], off: true, since });
  assert.deepEqual((await gateGrants(paths)).find((grant) => grant.email === "alice@example.com").chat, { folders: [HONCHO], sources: ["chatgpt"], tools: [...DEFAULT_TOOLS], off: true, since });
  const unchanged = await fs.readFile(paths.accessFile, "utf8");
  await setChatOff(paths, { email: "alice@example.com", off: true });
  assert.equal(await fs.readFile(paths.accessFile, "utf8"), unchanged, "already off: nothing written");
  await setChatOff(paths, { email: "alice@example.com", off: false });
  chat = (await readGateAccess(paths)).people["alice@example.com"].chat;
  assert.deepEqual(chat, { folders: [HONCHO], sources: ["chatgpt"], tools: [...DEFAULT_TOOLS], since });
  await assert.rejects(setChatOff(paths, { email: "bob@example.com", off: false }), /not opened/);
  await assert.rejects(setChatOff(paths, { email: "nobody@example.com", off: true }), /not opened/);

  // Closing chat leaves collecting; closing the last thing drops the person.
  await grantCollect(paths, { email: "alice@example.com", peer: "alice" });
  await revokePerson(paths, { email: "alice@example.com", kind: "chat" });
  assert.equal((await readGateAccess(paths)).people["alice@example.com"].chat, undefined);
  await revokePerson(paths, { email: "alice@example.com", kind: "collect" });
  assert.equal((await readGateAccess(paths)).people["alice@example.com"], undefined);
});

test("each teammate's MCP tools, and the same for all: only the owner's tools that read, kept through other changes", async (t) => {
  const paths = await tempPaths(t);
  await grantChat(paths, { email: "alice@example.com", peer: "alice", folders: [WEB] });
  assert.deepEqual((await readGateAccess(paths)).people["alice@example.com"].chat.tools, [...DEFAULT_TOOLS], "a teammate starts with the folder tools");
  await grantChat(paths, { email: "alice@example.com", folders: [WEB], tools: ["chat", "delete_session", "search", "chat", 7] });
  assert.deepEqual((await readGateAccess(paths)).people["alice@example.com"].chat.tools, ["search", "chat"], "never a tool that writes, in the list's order");
  await grantChat(paths, { email: "alice@example.com", folders: [HONCHO] });
  await setChatOff(paths, { email: "alice@example.com", off: true });
  assert.deepEqual((await gateGrants(paths))[0].chat.tools, ["search", "chat"], "kept when only the folders or the switch change");

  // For every teammate: those opened to now, and the next one approved.
  await grantChat(paths, { email: "bob@example.com", peer: "bob", folders: [WEB] });
  await setTeamTools(paths, { tools: ["list_sessions", "get_peer_card"] });
  await grantChat(paths, { email: "carol@example.com", peer: "carol", folders: [WEB] });
  const access = await readGateAccess(paths);
  assert.deepEqual(access.tools, ["list_sessions", "get_peer_card"]);
  for (const email of ["alice@example.com", "bob@example.com", "carol@example.com"]) {
    assert.deepEqual(access.people[email].chat.tools, ["list_sessions", "get_peer_card"], email);
  }
  assert.deepEqual(await gateTeamTools(paths), ["list_sessions", "get_peer_card"]);
  await assert.rejects(setTeamTools(paths, { tools: "search" }), /A list of tools/);
  assert.deepEqual(toolList(["get_queue_status", "search"]), ["search", "get_queue_status"]);
  assert.deepEqual(Object.values(OPENABLE_TOOLS).flat().length, 19);
});

test("two changes at once both land", async (t) => {
  const paths = await tempPaths(t);
  await Promise.all([
    grantChat(paths, { email: "a@example.com", peer: "a", folders: [HONCHO] }),
    grantChat(paths, { email: "b@example.com", peer: "b", folders: [WEB] }),
    grantCollect(paths, { email: "c@example.com", peer: "c" }),
    revokeDevice(paths, { id: "d-0123456789abcdef" }),
  ]);
  const access = await readGateAccess(paths);
  assert.deepEqual(Object.keys(access.people).sort(), ["a@example.com", "b@example.com", "c@example.com"]);
  assert.deepEqual(access.revokedDevices, ["d-0123456789abcdef"]);
});

test("what the gate would not read never reaches the file", () => {
  const normalized = normalizeGateAccess({
    owners: ["not an email", "OK@example.com"],
    workspace: "bad workspace!",
    people: {
      "x@example.com": { peer: "x", chat: { folders: [HONCHO], sources: ["chatgpt", "Bad"], off: "yes" }, admin: true },
      "v@example.com": { peer: "v", chat: { folders: [], sources: ["chatgpt"], off: true } },
      "y@example.com": { peer: "bad peer!", chat: { folders: [HONCHO] } },
      // A grant from before folders opens nothing.
      "w@example.com": { peer: "w", chat: { projects: [{ id: "p-0123456789ab", name: "honcho" }] } },
      "z@example.com": { peer: "z" },
      "not-an-email": { peer: "n", collect: {} },
    },
    revokedDevices: ["d-0123456789abcdef", "nope"],
    extra: "dropped",
  });
  assert.deepEqual(normalized, {
    version: 1,
    owners: ["ok@example.com"],
    workspace: "memory",
    people: {
      "x@example.com": { peer: "x", chat: { folders: [HONCHO], sources: ["chatgpt"] } },
      "v@example.com": { peer: "v", chat: { folders: [], sources: ["chatgpt"], off: true } },
      "w@example.com": { peer: "w", chat: { folders: [] } },
    },
    revokedDevices: ["d-0123456789abcdef"],
  });
});

test("the list of computers comes from the gate's file, owners marked, keys left out", async (t) => {
  const paths = await tempPaths(t);
  await setGateOwners(paths, { owners: ["me@example.com"] });
  await grantCollect(paths, { email: "bob@example.com", peer: "bob" });
  await fs.writeFile(paths.devicesFile, JSON.stringify({
    version: 1,
    devices: {
      "d-1111111111111111": { email: "me@example.com", name: "iMac", keyHash: "a".repeat(64), createdAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-10-07T01:00:00Z" },
      "d-2222222222222222": { email: "bob@example.com", name: "bob's laptop", keyHash: "b".repeat(64), createdAt: "2026-10-02T00:00:00Z", lastSeenAt: "2026-10-07T02:00:00Z" },
      "bad id": { email: "x@example.com", name: "x" },
    },
  }));
  await revokeDevice(paths, { id: "d-1111111111111111" });
  const devices = await gateDevices(paths);
  assert.deepEqual(devices.map((device) => [device.id, device.owner, device.revoked, device.peer]), [
    ["d-2222222222222222", false, false, "bob"],
    ["d-1111111111111111", true, true, null],
  ]);
  assert.equal(JSON.stringify(devices).includes("keyHash"), false);
  await assert.rejects(revokeDevice(paths, { id: "../etc" }), /Not a device id/);

  const grants = await gateGrants(paths);
  assert.deepEqual(grants, [{ email: "bob@example.com", peer: "bob", chat: null, collect: { workspace: "memory", since: grants[0].collect.since } }]);
});

test("a change that returns nothing leaves the file as it was", async (t) => {
  const paths = await tempPaths(t);
  await setGateOwners(paths, { owners: ["me@example.com"] });
  const before = await fs.readFile(paths.accessFile, "utf8");
  await changeGateAccess(paths, () => null);
  assert.equal(await fs.readFile(paths.accessFile, "utf8"), before);
});
