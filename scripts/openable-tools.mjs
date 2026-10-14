// The owner's MCP tools a teammate may be opened, each one only to read, by kind:
// `folder` answer from the conversations in the folders open to them, `whole` from
// the whole memory, which no folder divides, and `server` say how the server is set
// up. The MCP bridge keeps the same list (local-mcp-bridge/server.py OPENABLE_TOOLS)
// and opens nothing else, so no tool that writes is ever opened. The app's screens
// keep it too, with what each does (ui/lib/tool-grants.js).
export const OPENABLE_TOOLS = Object.freeze({
  folder: Object.freeze(["search", "list_sessions", "get_session_messages", "get_session_message", "get_session_context", "inspect_session", "get_session_peers", "query_conclusions", "list_conclusions"]),
  whole: Object.freeze(["chat", "get_representation", "get_peer_context", "get_peer_card"]),
  server: Object.freeze(["server_info", "list_peers", "get_metadata", "inspect_workspace", "list_workspaces", "get_queue_status"]),
});
const ALL_TOOLS = Object.freeze(Object.values(OPENABLE_TOOLS).flat());

/** What a teammate is opened when the owner chose nothing else: the folder tools. */
export const DEFAULT_TOOLS = OPENABLE_TOOLS.folder;

/** The tools of a list that may be opened, once each, in the order above; null for no list. */
export function toolList(value) {
  if (!Array.isArray(value)) return null;
  const chosen = new Set(value);
  return ALL_TOOLS.filter((tool) => chosen.has(tool));
}
