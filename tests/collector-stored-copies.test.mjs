import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

// Turns an older collector sent sit on the server without an identity this one reads
// (metadata {}, or a Codex line index one off). They must not go in a second time.

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTOR = path.join(ROOT, "scripts", "collector.mjs");

const THREAD = "01a04e36-27c5-7d13-bfaf-a80e5d22cb68";
const SEGMENT = "01a04e6f-b7d9-72d0-8cb1-1d314978da29";
const CODEX_SESSION = `codex-${THREAD}`;

/** A Honcho stand-in that keeps the messages it is sent and lists them back. */
async function startHoncho(t, stored = []) {
  const honcho = { stored: [...stored], requests: [] };
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    honcho.requests.push({ method: request.method, url: request.url, body });
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith("/messages/list")) {
      const page = Number(url.searchParams.get("page") || 1);
      const size = Number(url.searchParams.get("size") || 100);
      response.end(JSON.stringify({ items: honcho.stored.slice((page - 1) * size, page * size), total: honcho.stored.length }));
      return;
    }
    if (url.pathname.endsWith("/messages")) honcho.stored.push(...body.messages);
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  honcho.port = server.address().port;
  honcho.lists = () => honcho.requests.filter((entry) => entry.url.includes("/messages/list")).length;
  return honcho;
}

async function workdir(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-stored-copies-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeRows(file, rows) {
  await fsp.writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

const meta = (extra = {}) => ({ type: "session_meta", payload: { id: THREAD, cwd: "/tmp/project", originator: "Codex Desktop", source: "vscode", ...extra } });
const say = (role, text, timestamp) => ({
  timestamp,
  type: "response_item",
  payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
});

function collect(honcho, directory, provider, transcript) {
  const env = {
    ...process.env,
    HONCHO_BASE_URL: `http://127.0.0.1:${honcho.port}`,
    HONCHO_WORKSPACE_ID: "memory",
    HONCHO_USER_NAME: "user_test",
    HONCHO_AGENT_HOOK_STATE: path.join(directory, "state.json"),
    HONCHO_AGENT_HOOK_LOG: path.join(directory, "collector.log"),
  };
  return execFileAsync(process.execPath, [COLLECTOR, "--provider", provider, "--transcript", transcript], { env })
    .then((result) => JSON.parse(result.stdout));
}

const old = (peer, content, metadata = {}) => ({ id: `old-${peer}-${content}`, peer_id: peer, content, metadata });
const sent = (honcho, before) => honcho.stored.slice(before).map((message) => message.content);

test("Codex turns an older collector stored with metadata {} are not sent again; the new turn is", async (t) => {
  const honcho = await startHoncho(t, [old("user_test", "first question"), old("assistant_codex", "first answer")]);
  const directory = await workdir(t);
  const rollout = path.join(directory, `rollout-2026-01-01T00-00-00-${THREAD}.jsonl`);
  await writeRows(rollout, [
    meta(),
    say("user", "first question", "2026-01-01T00:00:01Z"),
    say("assistant", "first answer", "2026-01-01T00:00:02Z"),
    say("user", "second question", "2026-01-01T00:00:03Z"),
  ]);

  const first = await collect(honcho, directory, "codex", rollout);
  assert.equal(first.session_id, CODEX_SESSION);
  assert.equal(first.stored_copy_turns, 2);
  assert.equal(first.new_messages, 1);
  assert.deepEqual(sent(honcho, 2), ["second question"]);

  // The copies are remembered: the next hook neither sends nor reads the server again.
  const lists = honcho.lists();
  const again = await collect(honcho, directory, "codex", rollout);
  assert.equal(again.new_messages, 0);
  assert.equal(honcho.lists(), lists);
  assert.equal(honcho.stored.length, 3);
});

test("Codex turns stored under a line index one off from today's are not sent again", async (t) => {
  const honcho = await startHoncho(t, [
    old("user_test", "first question", { memory_importer: "codex_turn_ended", codex_line_index: 3, codex_role: "user" }),
    old("assistant_codex", "first answer", { memory_importer: "codex_turn_ended", codex_line_index: 4, codex_role: "assistant" }),
  ]);
  const directory = await workdir(t);
  const rollout = path.join(directory, `rollout-2026-01-01T00-00-00-${THREAD}.jsonl`);
  await writeRows(rollout, [
    meta(),
    say("user", "first question", "2026-01-01T00:00:01Z"),
    say("assistant", "first answer", "2026-01-01T00:00:02Z"),
    say("user", "second question", "2026-01-01T00:00:03Z"),
  ]);

  const result = await collect(honcho, directory, "codex", rollout);
  assert.equal(result.stored_copy_turns, 2);
  assert.deepEqual(sent(honcho, 2), ["second question"]);
});

test("a line said twice goes in once more when the server holds one copy of it", async (t) => {
  const honcho = await startHoncho(t, [old("user_test", "ok"), old("assistant_codex", "noted")]);
  const directory = await workdir(t);
  const rollout = path.join(directory, `rollout-2026-01-01T00-00-00-${THREAD}.jsonl`);
  await writeRows(rollout, [
    meta(),
    say("user", "ok", "2026-01-01T00:00:01Z"),
    say("assistant", "noted", "2026-01-01T00:00:02Z"),
    say("user", "ok", "2026-01-01T00:00:03Z"),
    say("assistant", "noted again", "2026-01-01T00:00:04Z"),
  ]);

  const result = await collect(honcho, directory, "codex", rollout);
  assert.equal(result.stored_copy_turns, 2);
  assert.deepEqual(sent(honcho, 2), ["ok", "noted again"]);
  assert.equal(honcho.stored.at(-2).metadata.codex_line_index, 4, "the later 'ok' is the one sent");
});

test("the same words from another file of the thread do not stop a segment's turn", async (t) => {
  const directory = await workdir(t);
  const parent = path.join(directory, `rollout-2026-01-01T00-00-00-${THREAD}.jsonl`);
  const segment = path.join(directory, `rollout-2026-01-01T01-00-00-${THREAD}_${SEGMENT}.jsonl`);
  const honcho = await startHoncho(t, [
    old("user_test", "go on", { codex_rollout_path: parent, codex_line_index: 2, codex_role: "user" }),
  ]);
  await writeRows(segment, [
    meta({ history_mode: "paginated" }),
    say("user", "go on", "2026-01-01T01:00:01Z"),
  ]);

  const result = await collect(honcho, directory, "codex", segment);
  assert.equal(result.codex_segment_id, SEGMENT);
  assert.equal(result.stored_copy_turns, undefined);
  assert.deepEqual(sent(honcho, 1), ["go on"]);
});

test("Claude Code turns stored with metadata {} are not sent again, and another peer's same words are not a copy", async (t) => {
  const honcho = await startHoncho(t, [
    old("user_test", "remember this"),
    old("assistant_claude", "remembered"),
    old("assistant_claude", "yes"),
  ]);
  const directory = await workdir(t);
  const transcript = path.join(directory, "claude.jsonl");
  await writeRows(transcript, [
    { uuid: "u1", sessionId: "session-1", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp/project", message: { role: "user", content: "remember this" } },
    { uuid: "a1", sessionId: "session-1", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "remembered" }] } },
    { uuid: "u2", sessionId: "session-1", timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: "yes" } },
  ]);

  const result = await collect(honcho, directory, "claude", transcript);
  assert.equal(result.stored_copy_turns, 2);
  assert.deepEqual(sent(honcho, 3), ["yes"]);
  assert.equal(honcho.stored.at(-1).peer_id, "user_test");
});

const FORK = "01a04e70-0000-7000-8000-000000000001";

test("a forked Codex thread's copy of its parent's conversation is not sent; its own turns are", async (t) => {
  const honcho = await startHoncho(t);
  const directory = await workdir(t);
  const parent = path.join(directory, `rollout-2026-01-01T00-00-00-${THREAD}.jsonl`);
  const fork = path.join(directory, `rollout-2026-01-02T00-00-00-${FORK}.jsonl`);
  await writeRows(parent, [
    meta(),
    say("user", "first question", "2026-01-01T00:00:01Z"),
    say("assistant", "first answer", "2026-01-01T00:00:02Z"),
    say("user", "parent goes on", "2026-01-01T00:00:03Z"),
  ]);
  await writeRows(fork, [
    { type: "session_meta", payload: { id: FORK, forked_from_id: THREAD, history_mode: "paginated", cwd: "/tmp/project", originator: "Codex Desktop", source: "vscode" } },
    say("user", "first question", "2026-01-02T00:00:00Z"),
    say("assistant", "first answer", "2026-01-02T00:00:00Z"),
    say("user", "fork asks this", "2026-01-02T00:00:01Z"),
    say("assistant", "first answer", "2026-01-02T00:00:02Z"),
  ]);

  const result = await collect(honcho, directory, "codex", fork);
  assert.equal(result.session_id, `codex-${FORK}`);
  assert.equal(result.fork_copy_turns, 2);
  assert.deepEqual(sent(honcho, 0), ["fork asks this", "first answer"]);
});

test("a fork whose parent's file is not on this computer goes in whole", async (t) => {
  const honcho = await startHoncho(t);
  const directory = await workdir(t);
  const fork = path.join(directory, `rollout-2026-01-02T00-00-00-${FORK}.jsonl`);
  await writeRows(fork, [
    { type: "session_meta", payload: { id: FORK, forked_from_id: THREAD, cwd: "/tmp/project", originator: "Codex Desktop", source: "vscode" } },
    say("user", "first question", "2026-01-02T00:00:00Z"),
    say("assistant", "first answer", "2026-01-02T00:00:00Z"),
  ]);

  const result = await collect(honcho, directory, "codex", fork);
  assert.equal(result.fork_copy_turns, undefined);
  assert.deepEqual(sent(honcho, 0), ["first question", "first answer"]);
});
