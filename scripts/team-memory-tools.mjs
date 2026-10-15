// Teammates' memories for this computer's agents: what the plugin's `team-memory`
// MCP server (team-mcp-server.mjs) offers.
//
// A teammate's memory is their own server, behind its gate at https://<host>. The
// gate lets in a teammate's Google login (Cloudflare Access) and hands /mcp to that
// server's MCP bridge with what its owner opened to that person; the bridge answers
// only from those conversations and logs each call with the question asked. This
// module reaches every server with this computer's team login (team-auth.mjs, the
// servers login), as the app does, so no agent logs in to anything itself.
//
//   member               who can be asked: the hub's people and servers, and what each
//                        server's gate says it lets this person read (whoami): the
//                        folders and apps, and which of the owner's tools
//   search, list_sessions, get_session_messages, chat, ...
//                        the owner's own MCP tools that read (gate-access.mjs
//                        OPENABLE_TOOLS), on one member's server: their bridge holds
//                        each to what that member opened to this person
//
// Every tool but member names the member and carries `question`, the user's own
// words, which the member reads in their log. An answer is the bridge's own, as
// JSON; its times are UTC.
import { loadConfig } from "./config.mjs";
import { OPENABLE_TOOLS } from "./openable-tools.mjs";
import { readTeamAuth, serverWhoami, setTeam, TeamLoginError, teamAuthPaths, teamFetch, teamJson } from "./team-auth.mjs";
import { VERSION } from "./version.mjs";

export const REMOTE_TOOLS = Object.freeze(Object.values(OPENABLE_TOOLS).flat());
export const TEAM_TOOLS = Object.freeze(["member", ...REMOTE_TOOLS]);

const PROTOCOL_VERSION = "2025-06-18";
// The hub's people and servers are asked again after this long.
const DIRECTORY_MS = 60_000;
// A search over many conversations, a chat, or the answer check, can take a while.
const CALL_MS = 180_000;

/** How to log in when a team server turned this computer's login down. */
const LOGIN_NEEDED = "This computer is not logged in to the team's servers, or its login ended. Tell the user to open the Team Memory app (/team-memory), go to 팀 and press 팀 서버 로그인, then ask again.";
const NO_TEAM = "This computer has not joined a team. Tell the user to run /team-memory setup and join their team first.";

const STRING = { type: "string" };
const INTEGER = (minimum, maximum, more = {}) => ({ type: "integer", minimum, ...(maximum ? { maximum } : {}), ...more });
const NUMBER = { type: "number", minimum: 0, maximum: 1 };
const BOOLEAN = { type: "boolean" };
const MEMBER = { type: "string", minLength: 1, description: "The teammate whose memory to read: the name `member` lists, or their email." };
const QUESTION = { type: "string", minLength: 1, description: "Your user's question in their own words. The teammate sees it in their log." };
const SESSION = { type: "string", minLength: 1, description: "A session (conversation) id, as search or list_sessions gave it." };
const PEER = (what) => ({ type: "string", minLength: 1, description: `${what}: a peer as member or list_peers names it, such as the teammate's own peer.` });
const PAGE = INTEGER(1, null, { default: 1 });

function tool(name, description, properties = {}, required = []) {
  const remote = name !== "member";
  return {
    name,
    title: name.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "),
    description,
    inputSchema: {
      type: "object",
      properties: remote ? { member: MEMBER, question: QUESTION, ...properties } : properties,
      ...(remote || required.length ? { required: remote ? ["member", "question", ...required] : required } : {}),
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: name !== "chat", openWorldHint: true },
  };
}

const READ_REPRESENTATION = {
  search_query: { ...STRING, description: "Bring the conclusions closest to this first." },
  search_top_k: INTEGER(1, 100),
  search_max_distance: NUMBER,
  include_most_frequent: BOOLEAN,
  max_conclusions: INTEGER(1, 100),
};

/** The tool definitions, as tools/list gives them: the owner's tools, each with member and question. */
export const TOOL_DEFINITIONS = Object.freeze([
  tool("member", "List the teammates whose memory you can read: each one's name, email, peer and server, what they opened to you (folders, ChatGPT records) and which of their tools you may call, or why you cannot read it yet. Call it first when you do not know the name to use."),
  tool("search", "Search one teammate's messages by words and meaning both: a message that holds the words, and one that says something like them. Only the conversations they opened to you.", {
    query: { ...STRING, minLength: 1, description: "What to look for: words likely to be in the messages, or what they would say." },
    peer_id: PEER("Only messages this peer said"),
    session_id: { ...SESSION, description: "Only this conversation." },
    limit: INTEGER(1, 100, { default: 10 }),
  }, ["query"]),
  tool("list_sessions", "List the conversations (sessions) one teammate opened to you, a page at a time.", { page: PAGE, size: INTEGER(1, 100, { default: 50 }) }),
  tool("get_session_messages", "Read one conversation of a teammate's, a page at a time, oldest first or with reverse the newest.", {
    session_id: SESSION, page: PAGE, size: INTEGER(1, 50, { default: 50 }), reverse: { ...BOOLEAN, default: false },
  }, ["session_id"]),
  tool("get_session_message", "Read one message of a teammate's conversation.", { session_id: SESSION, message_id: { ...STRING, minLength: 1 } }, ["session_id", "message_id"]),
  tool("get_session_context", "A teammate's conversation ready to read: its summary and latest messages within a token budget. peer_target and peer_perspective add what their memory drew about a peer, when they opened get_representation too.", {
    session_id: SESSION, tokens: INTEGER(1), summary: { ...BOOLEAN, default: true },
    peer_target: PEER("Add what was drawn about this peer"), peer_perspective: PEER("As this peer sees it"),
    limit_to_session: BOOLEAN, ...READ_REPRESENTATION,
  }, ["session_id"]),
  tool("inspect_session", "One conversation of a teammate's: its metadata, such as its folder and app.", { session_id: SESSION }, ["session_id"]),
  tool("get_session_peers", "Who took part in one conversation of a teammate's.", { session_id: SESSION }, ["session_id"]),
  tool("query_conclusions", "Search the conclusions a teammate's memory drew, by meaning: one sentence each, each from one conversation they opened to you.", {
    query: { ...STRING, minLength: 1 }, observer_id: PEER("Whose view"), observed_id: PEER("About whom"), top_k: INTEGER(1, 30, { default: 10 }), distance: NUMBER,
  }, ["query", "observer_id", "observed_id"]),
  tool("list_conclusions", "List the conclusions a teammate's memory drew from the conversations they opened to you, newest first or with reverse oldest.", { reverse: { ...BOOLEAN, default: false } }),
  tool("chat", "Ask a teammate's memory a question in plain words; their server's model answers from their whole memory. Only when they opened chat to you.", {
    query: { ...STRING, minLength: 1, description: "The question for their memory." },
    peer_id: PEER("Whose view answers"), target_peer_id: PEER("About whom"), session_id: { ...SESSION, description: "Only this conversation." },
    reasoning_level: { type: "string", enum: ["minimal", "low", "medium", "high", "max"], default: "low" },
  }, ["query"]),
  tool("get_representation", "What a teammate's memory drew about a peer, as text, from their whole memory.", { peer_id: PEER("About whom"), observer_id: PEER("Whose view"), session_id: { ...SESSION, description: "Only this conversation." }, ...READ_REPRESENTATION }, ["peer_id"]),
  tool("get_peer_context", "What a teammate's memory drew about a peer, with its card.", { peer_id: PEER("About whom"), observer_id: PEER("Whose view"), ...READ_REPRESENTATION }, ["peer_id"]),
  tool("get_peer_card", "The card a teammate's memory keeps about a peer: short facts.", { peer_id: PEER("About whom"), observer_id: PEER("Whose view") }, ["peer_id"]),
  tool("server_info", "A teammate's server: its version and setup."),
  tool("list_peers", "The people and agents in a teammate's memory, by peer."),
  tool("get_metadata", "The metadata of a teammate's workspace, a peer, or a conversation they opened to you.", {
    scope: { type: "string", enum: ["workspace", "peer", "session"], default: "workspace" }, peer_id: PEER("The peer, with scope peer"), session_id: { ...SESSION, description: "The conversation, with scope session." },
  }),
  tool("inspect_workspace", "A teammate's workspace: its id and metadata."),
  tool("list_workspaces", "A teammate's workspace, as a list."),
  tool("get_queue_status", "How much a teammate's memory still has to work through.", { observer_id: PEER("Whose view"), sender_id: PEER("Whose messages"), session_id: SESSION }),
]);

/** The instructions an agent gets with the tools. */
export function teamInstructions() {
  return "Your teammates' memories: their conversations with their AI agents, each opened to you by that teammate. Call member to see who you can read, what each opened and which tools you may use with each. The tools are your user's own honcho tools, by the same names, on one teammate's server, held to what that teammate opened: search their messages (search), list their conversations (list_sessions) and read the ones that matter (get_session_messages) before you answer, and say which teammate and conversation an answer comes from. Every call takes member and question, your user's question in their own words: the teammate sees it in their log. Times in answers are UTC. For your user's own memory, use the honcho tools instead.";
}

// ---------------------------------------------------------------- members

function list(value) {
  return Array.isArray(value) ? value : [];
}

/** A person as the team shows them: the admin's nickname, their peer, or the start of their email. */
export function personName(person) {
  return String(person?.nickname || person?.peer || String(person?.email || "").split("@")[0] || "");
}

function hostLabel(host) {
  return String(host || "").split(".")[0];
}

/**
 * The servers this person may ask, from the hub's people and servers: every server
 * but their own, by its owner's name (a company server by its label), and the
 * people without one, so the list says why they cannot be asked.
 */
export function membersOf(directory, me) {
  const self = String(me || "").toLowerCase();
  const people = new Map(list(directory?.people).map((person) => [String(person.email || "").toLowerCase(), person]));
  const members = [];
  const owners = new Set();
  for (const server of list(directory?.servers)) {
    const owner = String(server.owner || "").toLowerCase();
    owners.add(owner);
    if (owner === self) continue;
    const person = people.get(owner) || { email: owner, peer: server.ownerPeer || null };
    members.push({
      name: server.company ? String(server.label || hostLabel(server.host)) : personName(person),
      email: owner,
      peer: person.peer || null,
      nickname: server.company ? null : person.nickname || null,
      host: server.host,
      company: Boolean(server.company),
    });
  }
  for (const [email, person] of people) {
    if (email === self || owners.has(email)) continue;
    members.push({ name: personName(person), email, peer: person.peer || null, nickname: person.nickname || null, host: null, company: false });
  }
  return members;
}

/**
 * The member a name means: one whose name, nickname, email, the start of the email,
 * peer or server address is that name (case aside), else the one whose name,
 * nickname, start of the email or peer starts with it. A name no one has, or more
 * than one has, throws with who there is; this person's own says to use the honcho
 * tools.
 */
export function findMember(members, wanted, me = []) {
  const key = String(wanted || "").trim().toLowerCase();
  const who = () => members.map((member) => `${member.name} (${member.email})`).join(", ") || "nobody yet";
  if (!key) throw new Error(`member is required. Teammates: ${who()}.`);
  // `me`: this person's email, peer and nickname; the start of the email counts too.
  const mine = [me].flat().filter(Boolean).flatMap((name) => [String(name), String(name).split("@")[0]]).map((name) => name.toLowerCase());
  if (mine.includes(key)) throw new Error("That is your user. For their own memory, use the honcho tools.");
  const names = (member) => [
    member.name, member.nickname, member.email, member.email.split("@")[0], member.peer, member.host, hostLabel(member.host),
    member.host && hostLabel(member.host).startsWith("memory-") ? hostLabel(member.host).slice("memory-".length) : null,
  ].filter(Boolean).map((name) => String(name).toLowerCase());
  let found = members.filter((member) => names(member).includes(key));
  if (!found.length) {
    const starts = (member) => [member.name, member.nickname, member.email.split("@")[0], member.peer].filter(Boolean).some((name) => String(name).toLowerCase().startsWith(key));
    found = members.filter(starts);
  }
  if (found.length === 1) return found[0];
  if (!found.length) throw new Error(`No teammate is called "${wanted}". Teammates: ${who()}.`);
  throw new Error(`"${wanted}" could be ${found.map((member) => `${member.name} (${member.email}${member.host ? `, ${member.host}` : ""})`).join(" or ")}; use the email.`);
}

/** Where a member's memory stands for this person, from their server's whoami. */
function standing(member, whoami) {
  if (!member.host) return { state: "no_server" };
  if (whoami?.error) return { state: whoami.error === "login" ? "login" : "unreachable", detail: whoami.detail };
  const chat = whoami?.chat;
  if (!chat) return { state: "closed" };
  if (chat.off) return { state: "off" };
  // A gate from before tools were chosen names none: its bridge opens the folder tools.
  return { state: "open", folders: list(chat.folders), sources: list(chat.sources), tools: Array.isArray(chat.tools) ? chat.tools : [...OPENABLE_TOOLS.folder] };
}

const APPS = { chatgpt: "ChatGPT records", unknown: "conversations of other apps" };

/** A teammate's home folder as ~, for a shorter line. */
function shortFolder(folder) {
  return String(folder || "").replace(/^\/Users\/[^/]+(?=\/|$)/, "~").replace(/^\/home\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
}

function standingText(view) {
  switch (view.state) {
    case "open": {
      const folders = view.folders.map((folder) => `${shortFolder(folder.path)}${folder.subfolders ? "" : " (that folder only)"}`);
      const apps = view.sources.map((source) => APPS[source] || `${source} records`);
      const opened = [folders.length ? `folders ${folders.join(", ")}` : null, ...apps].filter(Boolean).join("; ");
      return `open to you: ${opened}. Tools you may use: ${view.tools.join(", ") || "none"}`;
    }
    case "off": return "opened to you, but turned off by them for now";
    case "closed": return "not open to you; your user can ask them in the Team Memory app (팀 → 요청)";
    case "no_server": return "has no memory server";
    case "login": return "could not be asked: this computer's team servers login is missing or ended";
    default: return `did not answer${view.detail ? ` (${view.detail})` : ""}; their server may be off`;
  }
}

// --------------------------------------------------------- the MCP client

/** Why a member's server turned a request down, as an error naming the member. */
async function refusal(response, member) {
  const text = await response.text().catch(() => "");
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (response.status === 403) return new Error(`${member.name}: ${body?.detail || "their server did not let you in"}`);
  if (response.status === 404) return new Error(`${member.name}'s server does not take teammates' questions: its sharing is off, or it runs an older Team Memory. Ask them to update.`);
  if ([502, 503, 504, 530].includes(response.status)) return new Error(`${member.name}'s server did not answer (HTTP ${response.status}); it may be off.`);
  return new Error(`${member.name}'s server answered HTTP ${response.status}${body?.detail || body?.error ? `: ${body.detail || body.error}` : ""}`);
}

/** The JSON-RPC answer with `id` in a streamable HTTP response: JSON, or Server-Sent Events. */
export function answerIn(text, contentType, id) {
  if (/text\/event-stream/i.test(contentType || "")) {
    for (const event of String(text).split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data) continue;
      let message;
      try { message = JSON.parse(data); } catch { continue; }
      if (message?.id === id) return message;
    }
    return null;
  }
  let message;
  try { message = JSON.parse(text); } catch { return null; }
  return Array.isArray(message) ? message.find((item) => item?.id === id) || null : message;
}

/** What a tool's result holds: its structured content, else its text read as JSON. */
function resultValue(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    const value = result.structuredContent;
    // FastMCP wraps a tool's non-object answer as {result}.
    return Object.keys(value).length === 1 && "result" in value ? value.result : value;
  }
  const text = list(result?.content).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
  try { return JSON.parse(text); } catch { return text; }
}

function resultText(result) {
  return list(result?.content).filter((item) => item?.type === "text").map((item) => item.text).join("\n").trim();
}

// -------------------------------------------------------------- the texts

/** A bridge's answer as the agent reads it: whose it is, then the answer itself. */
function answerText(member, name, value) {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return `${member.name}${member.peer ? ` (peer ${member.peer})` : ""} · ${name}:\n${body}`;
}

/**
 * The name the team calls this computer's person by (the admin's nickname), as the
 * app last kept it from the hub; null without one. Read from the login file only:
 * a program that asked the hub here would refresh the login under its lock, and one
 * closed meanwhile (an agent window) would leave the lock behind.
 */
export async function ownTeamName({ paths = null } = {}) {
  const files = paths || teamAuthPaths(await loadConfig().catch(() => null));
  const auth = await readTeamAuth(files).catch(() => null);
  return auth?.me?.nickname || null;
}

/**
 * The honcho MCP's instructions: whose memory it is, by peer and by the name the
 * team calls them. An agent asked about that name otherwise searches the messages
 * for it, where a person's own name rarely appears, and finds nothing.
 */
export function ownMemoryInstructions({ peer = "", name = "" } = {}) {
  const base = "Self-hosted Honcho personal memory. For broad recall, read the configured user's representation from the user's own observer perspective and also run workspace-wide search.";
  if (!peer) return base;
  if (!name) return `${base} The user is peer ${peer}.`;
  return `${base} The user is ${name} (peer ${peer}): a question about ${name} is about this memory and peer ${peer}; their name rarely appears in the messages, so do not search for it.`;
}

// ----------------------------------------------------------------- the tools

/**
 * The team-memory tools on this computer. `paths` (team-auth.mjs) and `fetchImpl`
 * are for tests; by default the configured install's login is used.
 */
export function teamMemory({ paths = null, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let directoryCache = null;
  const sessions = new Map();
  let nextId = 1;

  const authPaths = async () => paths || teamAuthPaths(await loadConfig().catch(() => null));

  async function directory() {
    if (directoryCache && now() - directoryCache.at < DIRECTORY_MS) return directoryCache.value;
    const files = await authPaths();
    const auth = await readTeamAuth(files);
    if (!auth.hub) throw new Error(NO_TEAM);
    const team = await teamJson(`https://${auth.hub}/api/team`, { paths: files, fetchImpl, device: false });
    const self = list(team.people).find((person) => String(person.email || "").toLowerCase() === String(auth.email || "").toLowerCase());
    const value = {
      me: [auth.email, self?.peer, self?.nickname],
      self: { name: personName(self || { email: auth.email }), email: auth.email },
      team: team.team || {},
      members: membersOf(team, auth.email),
    };
    directoryCache = { at: now(), value };
    // The honcho MCP names this person by it; it reads the login file, not the hub.
    if ((self?.nickname || null) !== (auth.me.nickname || null)) {
      await setTeam({ hub: auth.hub, nickname: self?.nickname || null }, { paths: files }).catch(() => {});
    }
    return value;
  }

  async function post(member, message, session) {
    const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
    if (session?.id) headers["mcp-session-id"] = session.id;
    if (session?.version) headers["mcp-protocol-version"] = session.version;
    return teamFetch(`https://${member.host}/mcp`, { method: "POST", headers, body: JSON.stringify(message), signal: AbortSignal.timeout(CALL_MS) }, { paths: await authPaths(), fetchImpl, device: false });
  }

  async function rpc(member, method, params, session) {
    const id = nextId++;
    const response = await post(member, { jsonrpc: "2.0", id, method, params }, session);
    if (!response.ok) return { response, refused: true };
    const answer = answerIn(await response.text(), response.headers.get("content-type"), id);
    if (!answer) throw new Error(`${member.name}'s server gave no answer to ${method}`);
    if (answer.error) throw new Error(`${member.name}'s server: ${answer.error.message || `error ${answer.error.code}`}`);
    return { response, result: answer.result };
  }

  async function open(member) {
    const answer = await rpc(member, "initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "team-memory", version: VERSION } });
    if (answer.refused) throw await refusal(answer.response, member);
    const session = { id: answer.response.headers.get("mcp-session-id") || null, version: answer.result?.protocolVersion || PROTOCOL_VERSION };
    const done = await post(member, { jsonrpc: "2.0", method: "notifications/initialized" }, session);
    await done.arrayBuffer().catch(() => {});
    sessions.set(member.host, session);
    return session;
  }

  /** A tool of the member's bridge; a session the bridge forgot is opened again, once. */
  async function remote(member, name, args) {
    let session = sessions.get(member.host) || await open(member);
    for (let attempt = 1; ; attempt += 1) {
      const answer = await rpc(member, "tools/call", { name, arguments: args }, session);
      if (answer.refused && session.id && [400, 404].includes(answer.response.status) && attempt === 1) {
        await answer.response.arrayBuffer().catch(() => {});
        sessions.delete(member.host);
        session = await open(member);
        continue;
      }
      if (answer.refused) throw await refusal(answer.response, member);
      if (answer.result?.isError) throw new Error(`${member.name}: ${resultText(answer.result).replace(/^Error calling tool '[^']*': /, "") || "their server refused this"}`);
      return resultValue(answer.result);
    }
  }

  async function memberList() {
    const { team, members, self } = await directory();
    const files = await authPaths();
    const views = await Promise.all(members.map(async (member) => {
      if (!member.host) return { member, view: standing(member, null) };
      try {
        return { member, view: standing(member, await serverWhoami(member.host, { paths: files, fetchImpl })) };
      } catch (error) {
        const login = error instanceof TeamLoginError && error.code === "login_needed";
        return { member, view: standing(member, { error: login ? "login" : "unreachable", detail: login ? null : String(error?.message || error) }) };
      }
    }));
    if (views.some(({ view }) => view.state === "login")) throw new Error(LOGIN_NEEDED);
    if (!views.length) return `${team.name ? `Team "${team.name}" has` : "The team has"} no other members yet.`;
    const lines = views.map(({ member, view }) => `- ${member.name} (${[member.email, member.host].filter(Boolean).join(" · ")}${member.company ? " · the company server" : ""}): ${standingText(view)}`);
    return [
      `${team.name ? `Team "${team.name}". ` : ""}Pass a name (or an email) as member to the other tools.`,
      `Your user is ${self.name} (${self.email}); their own memory is in the honcho tools, not here.`,
      ...lines,
    ].join("\n");
  }

  /** The properties each tool takes, so nothing else is sent on. */
  const accepted = new Map(TOOL_DEFINITIONS.map((item) => [item.name, Object.keys(item.inputSchema.properties).filter((key) => key !== "member")]));

  /** One of the owner's tools on a member's server: the arguments it takes, as given. */
  async function handle(member, name, args) {
    for (const key of TOOL_DEFINITIONS.find((item) => item.name === name).inputSchema.required) {
      if (key !== "member" && key !== "question" && (args[key] === undefined || args[key] === "")) throw new Error(`${key} is required.`);
    }
    const sent = Object.fromEntries(accepted.get(name).filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
    try {
      return answerText(member, name, await remote(member, name, sent));
    } catch (error) {
      // A bridge from before the owner's tools could be opened knows only its four.
      if (/unknown tool/i.test(String(error?.message))) {
        throw new Error(`${member.name}'s server runs an older Team Memory without ${name}. Ask them to update (/team-memory doctor).`);
      }
      throw error;
    }
  }

  /** One tool call: its text, or an error the agent reads. */
  async function call(name, args = {}) {
    try {
      if (name === "member") return await memberList();
      if (!accepted.has(name)) throw new Error(`Unknown tool: ${name}`);
      if (!String(args.question || "").trim()) throw new Error("question is required: your user's question in their own words.");
      const { me, members } = await directory();
      const member = findMember(members, args.member, me);
      if (!member.host) throw new Error(`${member.name} has no memory server.`);
      return await handle(member, name, args);
    } catch (error) {
      if (error instanceof TeamLoginError && error.code === "login_needed") throw new Error(LOGIN_NEEDED);
      throw error;
    }
  }

  /** Whether this computer joined a team: before that the server offers no tools. */
  async function joined() {
    return Boolean((await readTeamAuth(await authPaths())).hub);
  }

  return { call, joined, tools: TOOL_DEFINITIONS, instructions: () => teamInstructions() };
}
