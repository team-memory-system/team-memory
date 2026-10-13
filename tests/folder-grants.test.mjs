// What a teammate's chat may answer from, as the owner ticks it in the folder tree:
// the folders of every computer of the owner's, the same folder under ~ on each of
// them one row, and the fewest entries that open what is ticked, folders made later
// under a ticked one included, without ever opening a folder that holds a home.
// Conversations without a folder open by their app: ChatGPT 기록 is always offered.
import assert from "node:assert/strict";
import test from "node:test";

import { appRowsOf, folderKey, folderOpens, folderRowsOf, grantFromHubNames, grantFromTicked, grantedPaths, openedText, rowPaths } from "../ui/lib/folder-grants.js";
import { folderTree } from "../ui/lib/folder-tree.js";
import { josa } from "../ui/lib/format.js";

// A Mac's and a Windows PC's conversations on one server.
const LISTED = [
  { path: "/Users/me", sessions: 3 },
  { path: "/Users/me/dev/honcho", sessions: 10 },
  { path: "/Users/me/dev/wiki", sessions: 4 },
  { path: "C:\\Users\\me\\dev\\honcho", sessions: 5 },
  { path: "C:\\Users\\me", sessions: 2 },
  { path: "/tmp/x", sessions: 1 },
  { path: "/private/tmp/y", sessions: 1 },
  { path: "D:\\work\\app", sessions: 2 },
];

function treeOf(listed = LISTED, chosen = []) {
  const rows = folderRowsOf(listed, chosen);
  return { rows, tree: folderTree(rows) };
}

test("a folder compares the way the MCP bridge compares it", () => {
  assert.equal(folderKey("C:\\Users\\Me\\Dev\\"), "c:/users/me/dev");
  assert.equal(folderKey("C:"), "c:/");
  assert.equal(folderKey("C:\\"), "c:/");
  assert.equal(folderKey("/Users//me/dev/"), "/Users/me/dev");
  assert.equal(folderKey("/"), "/");

  const dev = { path: "/Users/me/dev", subfolders: true };
  assert.equal(folderOpens(dev, "/Users/me/dev"), true);
  assert.equal(folderOpens(dev, "/Users/me/dev/later/made"), true, "a folder made later inside opens too");
  assert.equal(folderOpens(dev, "/Users/me/devices"), false, "a name that only starts the same is another folder");
  assert.equal(folderOpens({ ...dev, subfolders: false }, "/Users/me/dev/app"), false);
  assert.equal(folderOpens({ path: "C:\\Users\\Me\\Dev", subfolders: true }, "c:/users/me/dev/app"), true, "a Windows path in any case");
  assert.equal(folderOpens({ path: "/Users/Me/Dev", subfolders: true }, "/Users/me/dev/app"), false, "a Mac path keeps its case");
  assert.equal(folderOpens({ path: "/", subfolders: true }, "/x"), true, "a root keeps its /");
});

test("the same folder of several computers is one row, and an open folder with no conversation stays in sight", () => {
  const { rows } = treeOf(LISTED, [{ path: "/Users/me/old", subfolders: true }, { path: "/Users/me/dev", subfolders: true }]);
  const honcho = rows.find((row) => row.display === "~/dev/honcho");
  assert.deepEqual(rowPaths(honcho), ["/Users/me/dev/honcho", "C:\\Users\\me\\dev\\honcho"]);
  assert.equal(honcho.count, 15);
  assert.deepEqual(rows.find((row) => row.display === "~").paths, ["/Users/me", "C:\\Users\\me"]);
  assert.deepEqual(rows.find((row) => row.path === "/Users/me/old"), { path: "/Users/me/old", paths: ["/Users/me/old"], display: "~/old", count: 0 });
  assert.equal(rows.filter((row) => row.display === "~/dev").length, 0, "an open folder that holds conversations needs no row of its own");
  assert.deepEqual(rowPaths({ path: "/a" }), ["/a"]);
});

test("ticks become the fewest entries, on every computer the folder is on", () => {
  const { rows, tree } = treeOf();
  const ticked = (...paths) => grantFromTicked(tree, new Set(paths));

  assert.deepEqual(ticked("/Users/me/dev/honcho", "/Users/me/dev/wiki"), [
    { path: "/Users/me/dev", subfolders: true },
    { path: "C:\\Users\\me\\dev", subfolders: true },
  ], "a folder all ticked opens with what is inside it, written the way its computer writes it");
  assert.deepEqual(ticked("/Users/me/dev/honcho"), [
    { path: "/Users/me/dev/honcho", subfolders: true },
    { path: "C:\\Users\\me\\dev\\honcho", subfolders: true },
  ]);
  assert.deepEqual(ticked("/Users/me"), [
    { path: "/Users/me", subfolders: false },
    { path: "C:\\Users\\me", subfolders: false },
  ], "the conversations started in a folder that holds others open alone");

  assert.deepEqual(grantFromTicked(tree, new Set(rows.map((row) => row.path))), [
    { path: "/Users/me", subfolders: true },
    { path: "C:\\Users\\me", subfolders: true },
    { path: "/tmp/x", subfolders: true },
    { path: "/private/tmp/y", subfolders: true },
    { path: "D:\\work\\app", subfolders: true },
  ], "every folder: each home whole, never / or a drive above it");
  assert.deepEqual(ticked("/tmp/x", "/private/tmp/y"), [
    { path: "/tmp/x", subfolders: true },
    { path: "/private/tmp/y", subfolders: true },
  ], "all of / ticked still never opens /, which holds the homes");
  assert.deepEqual(ticked(), []);
});

test("a folder above a home never opens with what is inside it", () => {
  // /Users/Shared reads as a home (collect.js shortPath); /Users holds the homes.
  const listed = [{ path: "/Users", sessions: 1 }, { path: "/Users/me/dev", sessions: 2 }, { path: "/srv/data", sessions: 1 }];
  const { rows, tree } = treeOf(listed);
  assert.deepEqual(grantFromTicked(tree, new Set(rows.map((row) => row.path))), [
    { path: "/Users", subfolders: false },
    { path: "/srv/data", subfolders: true },
    { path: "/Users/me/dev", subfolders: true },
  ]);
});

test("a grant shows as the rows it opens, and ticking them again gives it back", () => {
  const { rows, tree } = treeOf();
  const grant = [{ path: "/Users/me/dev", subfolders: true }, { path: "C:\\Users\\me\\dev", subfolders: true }];
  const shown = grantedPaths(rows, grant);
  assert.deepEqual([...shown].sort(), ["/Users/me/dev/honcho", "/Users/me/dev/wiki"]);
  assert.deepEqual(grantFromTicked(tree, shown), grant);
  // A row opened on one of its computers shows ticked; saving it opens it on both.
  assert.deepEqual([...grantedPaths(rows, [{ path: "C:\\Users\\me\\dev\\honcho", subfolders: false }])], ["/Users/me/dev/honcho"]);
  assert.deepEqual([...grantedPaths(rows, [{ path: "/Users/me/elsewhere", subfolders: true }])], []);
  assert.deepEqual([...grantedPaths(rows, null)], []);
});

test("ChatGPT 기록 is always a row, greyed with where to import it until some is there; other apps show when they have some", () => {
  const [none] = appRowsOf([]);
  assert.deepEqual({ ...none, hint: Boolean(none.hint) }, { key: "chatgpt", label: "ChatGPT 기록", count: 0, disabled: true, hint: true });
  assert.match(none.hint, /기억 설정 → 지난 대화 → 더 가져오기/);
  assert.deepEqual(appRowsOf([{ source: "agy", sessions: 2 }, { source: "chatgpt", sessions: 640 }, { source: "hermes", sessions: 0 }, { source: "unknown", sessions: 3 }]), [
    { key: "chatgpt", label: "ChatGPT 기록", count: 640, disabled: false, hint: null },
    { key: "agy", label: "agy 기록", count: 2, disabled: false, hint: null },
    { key: "unknown", label: "기타 대화", count: 3, disabled: false, hint: null },
  ]);
  // What is open stays in sight and can be closed, even with nothing in it now.
  assert.deepEqual(appRowsOf([], ["chatgpt", "hermes"]).map((row) => [row.key, row.disabled]), [["chatgpt", false], ["hermes", false]]);
});

test("what a teammate was opened reads as a count of folders and the apps by name", () => {
  assert.equal(openedText(["ChatGPT 기록", "~/dev/honcho", "/tmp/x", "C:\\work", "…/a/very/long/folder"]), "열린 폴더 4개 · ChatGPT 기록");
  assert.equal(openedText(["ChatGPT 기록"]), "ChatGPT 기록");
  assert.equal(openedText(["~/dev/honcho"]), "열린 폴더 1개");
  assert.equal(openedText(undefined), "열린 폴더 0개");
});

test("a name takes the particle its last sound does", () => {
  assert.deepEqual(["철수", "민준", "naddle", "chenjing", "luna", "team2", "team3"].map((name) => josa(name, "을/를")),
    ["철수를", "민준을", "naddle을", "chenjing을", "luna를", "team2를", "team3을"]);
  assert.equal(josa("철수", "이/가"), "철수가");
  assert.equal(josa("민준", "은/는"), "민준은");
});

test("what an approval opened, as the hub named it, ticks again on a server that never had it", () => {
  const rows = folderRowsOf(LISTED);
  const { folders, sources } = grantFromHubNames(["~/dev/honcho", "/tmp/x", "ChatGPT 기록", "…/cut/short"], rows);
  assert.deepEqual(sources, ["chatgpt"]);
  // ~ is each computer's home a row shows, written with that computer's separator.
  assert.deepEqual(folders, [
    { path: "/Users/me/dev/honcho", subfolders: true },
    { path: "C:\\Users\\me\\dev\\honcho", subfolders: true },
    { path: "/tmp/x", subfolders: true },
  ]);
  assert.deepEqual([...grantedPaths(rows, folders)].sort(), ["/Users/me/dev/honcho", "/tmp/x"]);

  // The whole home opens what is under it, and nothing named opens nothing.
  const home = grantFromHubNames(["~"], rows).folders;
  assert.deepEqual(home.map((entry) => entry.path), ["/Users/me", "C:\\Users\\me"]);
  assert.ok(grantedPaths(rows, home).has("/Users/me/dev/wiki"));
  assert.deepEqual(grantFromHubNames(null, rows), { folders: [], sources: [] });
});
