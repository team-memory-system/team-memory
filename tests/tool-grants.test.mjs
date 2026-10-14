// The owner's MCP tools as the 수정 window's MCP 도구 tab lists them: the same
// tools, in the same kinds and order, that the app writes into access.json and the
// MCP bridge opens (scripts/openable-tools.mjs), each with what it does, and a
// teammate starts with the folder tools.
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_TOOLS as STARTS_WITH, OPENABLE_TOOLS } from "../scripts/openable-tools.mjs";
import { DEFAULT_TOOLS, TOOL_KINDS, toolsText } from "../ui/lib/tool-grants.js";

test("the tab lists every tool the server opens, by kind, each with what it does", () => {
  assert.deepEqual(Object.fromEntries(TOOL_KINDS.map((kind) => [kind.key, kind.tools.map(([name]) => name)])), OPENABLE_TOOLS);
  assert.ok(TOOL_KINDS.every((kind) => kind.title && kind.sub && kind.tools.every(([, does]) => does)));
  assert.ok(TOOL_KINDS.find((kind) => kind.key === "whole").warn, "the whole-memory tools say they read past the folders");
  assert.deepEqual(DEFAULT_TOOLS, [...STARTS_WITH]);
  assert.equal(toolsText(DEFAULT_TOOLS), "MCP 도구 9개");
});

test("the team server's bridge offers every tool that can be opened, and the four from before", async () => {
  const fs = await import("node:fs/promises");
  const compose = await fs.readFile(new URL("../server/compose.yaml", import.meta.url), "utf8");
  const enabled = /HONCHO_MCP_ENABLED_TOOLS: (\S+)/.exec(compose)[1].split(",");
  assert.deepEqual(enabled, [...Object.values(OPENABLE_TOOLS).flat(), "list_conversations", "search_messages", "read_conversation", "search_conclusions"]);
});
