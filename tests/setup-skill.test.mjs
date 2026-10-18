// The setup skill (skills/setup-memory) opens the Team Memory app at a screen and says
// one line; the app asks and does the rest. What matters: an agent reaches for the
// skill unasked in Claude Code and in Codex, so "민준 기억 열람 요청해 줘" in any session
// opens 팀; every screen the skill opens is one the app serves; and README, where an
// agent without the plugin reads how to install, starts with the sentence to say and
// gives the install commands setup itself runs for the other host.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DEFAULT_MARKETPLACE, DEFAULT_SOURCE, PLUGIN_NAME } from "../scripts/host-plugins.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fsp.readFile(path.join(ROOT, relativePath), "utf8");

/** SKILL.md's front matter as its lines, and the description. */
async function frontMatter() {
  const skill = await read("skills/setup-memory/SKILL.md");
  const head = skill.match(/^---\n([\s\S]*?)\n---\n/)[1];
  return { head, description: head.match(/^description: (.+)$/m)[1] };
}

test("the setup skill is reached without being named, in Claude Code and in Codex", async () => {
  const { head, description } = await frontMatter();
  assert.doesNotMatch(head, /disable-model-invocation/);
  // Kept out of Claude Code's / menu, where /team-memory setup opens it.
  assert.match(head, /^user-invocable: false$/m);
  // A description stays within the 1,024 characters a skill's may have.
  assert.ok(description.length <= 1024, `the description is ${description.length} characters`);
  for (const words of ["열람 요청", "팀 만들어", "설정 열어", "/team-memory setup", "$setup-memory"]) {
    assert.ok(description.includes(words), `the description does not name ${words}`);
  }
  const codex = await read("skills/setup-memory/agents/openai.yaml");
  assert.match(codex, /^ {2}allow_implicit_invocation: true$/m);
});

test("every screen the setup skill opens is one the app serves", async () => {
  const skill = await read("skills/setup-memory/SKILL.md");
  const shell = await read("ui/app.js");
  const views = shell.match(/const VIEWS = \{([^}]*)\}/)[1].split(",").map((name) => name.trim().split(":")[0].trim()).filter(Boolean);
  // `start` opens first setup's window over whatever screen is on.
  views.push("start");
  const settings = await read("ui/views/settings.js");
  const windows = [...settings.match(/const windows = \{([\s\S]*?)\n {4}\};/)[1].matchAll(/^\s+([a-z]+): \(\)/gm)].map((match) => match[1]);

  // The table's screen column (`dashboard`, `computer/collect`, `start?team=<팀 주소>`),
  // and the screens the skill lists for a request the table does not name.
  const table = [...skill.matchAll(/^\| [^|\n]+ \| `([a-z/]+)(?:\?team=[^`]*)?` \|/gm)].map((match) => match[1]);
  assert.ok(table.length >= 12, `only ${table.length} rows name a screen`);
  const listed = [...skill.match(/The app's screens: ([^\n]*)/)[1].matchAll(/`([a-z/]+)`/g)].map((match) => match[1]);
  assert.ok(listed.length >= 11, `only ${listed.length} screens are listed`);
  for (const screen of [...table, ...listed]) {
    const [view, page] = screen.split("/");
    assert.ok(views.includes(view), `the skill opens ${screen}, which no screen serves`);
    if (page) assert.ok(view === "computer" && windows.includes(page), `${screen} is not one of 기억 설정's windows`);
  }
  for (const screen of ["dashboard", "computer/collect", "team", "start", "models"]) {
    assert.ok(table.includes(screen), `no request opens ${screen}`);
  }
});

test("README starts installing with the sentence to say, and gives an agent the commands setup runs", async () => {
  const readme = await read("README.md");
  const install = readme.slice(readme.indexOf("## 설치\n"));
  const lines = install.split("\n").filter(Boolean);
  assert.equal(lines[1], "Claude Code나 Codex에 이렇게 말하세요.");
  assert.ok(lines.slice(2, 5).some((line) => line.includes(`https://github.com/${DEFAULT_SOURCE}`)), "the sentence does not give the repository's address");

  const agent = readme.slice(readme.indexOf("### 에이전트에게"), readme.indexOf("\n## ", readme.indexOf("### 에이전트에게")));
  const id = `${PLUGIN_NAME}@${DEFAULT_MARKETPLACE}`;
  for (const command of [
    `claude plugin marketplace add ${DEFAULT_SOURCE}`,
    `claude plugin install ${id} --scope user`,
    `codex plugin marketplace add ${DEFAULT_SOURCE}`,
    `codex plugin add ${id}`,
    "ui open --screen dashboard",
    "start?team=",
    "SSH_CONNECTION",
  ]) assert.ok(agent.includes(command), `README's 에이전트에게 does not say ${command}`);
});
