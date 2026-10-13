// The plugin's `team-memory` MCP server: teammates' memories, over stdio, for Claude
// Code and Codex (team-memory-tools.mjs). The user's own memory is the `honcho`
// server beside it (mcp-server.mjs).
import { serveStdio } from "./mcp-stdio.mjs";
import { teamMemory } from "./team-memory-tools.mjs";
import { VERSION } from "./version.mjs";

const team = teamMemory();

serveStdio({
  name: "Team Memory (teammates)",
  version: VERSION,
  instructions: team.instructions,
  // Before this computer joins a team every call would only say so: no tools then.
  listTools: async () => ((await team.joined()) ? team.tools : []),
  callTool: async (name, args) => ({ content: [{ type: "text", text: await team.call(name, args) }], isError: false }),
});
