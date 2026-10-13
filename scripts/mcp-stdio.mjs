// The stdio side of the plugin's MCP servers (mcp-server.mjs, team-mcp-server.mjs):
// one JSON-RPC message per line on stdin, one answer per line on stdout, handled in
// the order they came.
import readline from "node:readline";

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  DEFAULT_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

/**
 * Serves one MCP server over stdio. `listTools()` gives the tool definitions offered
 * now, and `callTool(name, args)` the result of a call (`content` and the rest); a
 * call that throws goes back as a result with `isError`, its message as the text, so
 * the agent reads why.
 */
export function serveStdio({ name, version, instructions, listTools, callTool, input = process.stdin, output = process.stdout }) {
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  const sendResult = (id, result) => send({ jsonrpc: "2.0", id, result });
  const sendError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  async function handle(message) {
    const { id, method, params } = message;
    if (method === "initialize") {
      const requested = params?.protocolVersion;
      if (typeof requested !== "string" || !requested) {
        sendError(id, -32602, "initialize requires a protocolVersion string");
        return;
      }
      sendResult(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version },
        instructions: typeof instructions === "function" ? instructions() : instructions,
      });
      return;
    }
    if (method === "ping") {
      sendResult(id, {});
      return;
    }
    if (method === "tools/list") {
      sendResult(id, { tools: await listTools() });
      return;
    }
    if (method === "tools/call") {
      try {
        sendResult(id, await callTool(params?.name, params?.arguments || {}));
      } catch (error) {
        sendResult(id, { content: [{ type: "text", text: String(error?.message || error) }], isError: true });
      }
      return;
    }
    if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
  }

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let pending = Promise.resolve();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    pending = pending.then(() => handle(message)).catch((error) => {
      if (message.id !== undefined) sendError(message.id, -32603, String(error?.message || error));
      else process.stderr.write(`${String(error?.stack || error)}\n`);
    });
  });
  return lines;
}
