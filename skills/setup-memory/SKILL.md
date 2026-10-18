---
name: setup-memory
description: Opens the Team Memory app at the screen for what the user asked and answers with one fixed line holding the app's address. Use it to install or set up Team Memory ("팀 메모리 설치해 줘", "팀 메모리 설정 열어 줘", /team-memory setup, $setup-memory, an invite line with 팀 주소), and whenever the user wants something done in the app, even without naming Team Memory - asking a teammate to open their memory ("민준 기억 열람 요청해 줘"), making or joining a team ("팀 만들어 줘"), adding a teammate, adding a ChatGPT or Claude subscription account, the memory server on another computer, also storing some folders on another server, past conversations or a ChatGPT export, backup, sharing the server. Not for recalling memory or searching a teammate's memory, which the honcho and team-memory MCP tools do.
user-invocable: false
---

# Setup Memory

Team Memory is set up in its app. The app's first setup window asks where the memory server goes, the subscription and models, the agents, past conversations and project folders, and its 적용 installs, logs in, starts and checks them; every screen after that says what to press next. This skill opens the app at the screen for what the user asked and says one fixed line, so the chat and the app never ask the same thing twice.

## Open the screen

1. Find the user's words in the table below. Words that carry a team address (`팀 주소 team.example.com`, as in the invite line an admin copies) open `start?team=<that address>`, the address alone, without `https://` or a trailing `/`.
2. Before `team` and `admin`, run `node "<plugin-root>/scripts/cli.mjs" team status`, which says who this computer is signed in as, without any token. When its `login.hub` is empty, this computer is in no team: open `start` and say the "To join a team" line instead. When `admin` is asked and `login.admin` is false, open nothing and say: 팀원은 팀 관리자가 더합니다. 관리자에게 더할 사람의 Google 이메일을 보내세요.
3. Run `node "<plugin-root>/scripts/cli.mjs" ui open --screen '<screen>'`, with `<plugin-root>` the directory two levels above this `SKILL.md`. It starts the app when it is not running and asks for a browser window. A computer not set up yet shows the first setup window over every screen, so the same screen serves it too.
4. Say the line, `<url>` being the `url` of the result (over SSH, with the sentence in "Over SSH" after it), and stop.

The line is all the user reads from you: no plan, no progress, nothing about the commands, no recap, and no waiting for an answer, because what follows is in the app. Say it in the user's language: Korean as written here, the same meaning in another language.

| The user asks | Screen | Line |
|---|---|---|
| To install Team Memory ("팀 메모리 설치해 줘") | `dashboard` | 팀 메모리 앱을 열었습니다. 브라우저 창에서 이어 하세요. <url> |
| With a team address in their words | `start?team=<팀 주소>` | 팀 메모리 앱을 열었습니다. 브라우저 창에서 이어 하세요. <url> |
| `/team-memory setup`, `$setup-memory`, or to open or change the settings ("팀 메모리 설정 열어 줘"; the server, agents, project folders) | `computer/collect` | 팀 메모리 설정 창을 열었습니다. 단계를 따라 적용까지 누르세요. <url> |
| To ask a teammate to open their memory ("민준 기억 열람 요청해 줘") | `team` | 팀 화면을 열었습니다. 팀원 기억에서 <팀원> 줄의 열람 요청을 누르세요. <url> |
| To make a team | `start` | 팀 메모리 시작 창을 열었습니다. 새 팀 만들기를 누르세요. <url> |
| To join a team | `start` | 팀 메모리 시작 창을 열었습니다. 팀에 들어가기를 누르고 관리자에게 받은 팀 주소를 넣으세요. <url> |
| To store this computer's conversations in their own memory server on another computer | `computer/collect` | 대화 수집 창을 열었습니다. 서버 단계에서 다른 컴퓨터의 내 서버를 고르세요. <url> |
| To add a ChatGPT or Claude subscription account | `models` | 모델 화면을 열었습니다. 계정 더하기를 누르세요. <url> |
| To also store some folders on another server, such as the company's | `computer/collect` | 대화 수집 창을 열었습니다. 서버 단계의 함께 쌓을 서버에서 고르세요. <url> |
| To bring in past conversations, from a backup or a ChatGPT export | `computer/past` | 지난 대화 창을 열었습니다. 가져올 백업이나 ChatGPT 내보내기 파일을 고르고 적용까지 누르세요. <url> |
| To add a teammate | `admin` | 관리자 화면을 열었습니다. 팀원 더하기를 누르고 그 사람의 Google 이메일을 넣으세요. <url> |
| To back up the conversations | `backup` | 백업 화면을 열었습니다. 수정을 눌러 백업할 곳과 시각을 정하세요. <url> |
| To share the server with their other computers, without a team | `share` | 공유 화면을 열었습니다. 공유를 켠 뒤 서버 token 복사를 누르세요. <url> |
| Anything else done on a screen of the app | that screen | 팀 메모리 앱의 <화면 이름> 화면을 열었습니다. <url> |

A read request that names no teammate says 찾아볼 팀원 for <팀원>. The app's screens: `dashboard` (대시보드), `memory` (기억), `ask` (기억 → 묻기), `computer` (기억 설정, with the windows `computer/collect`, `computer/past` and `computer/tools`), `team` (팀), `audit` (조회 기록), `server` (서버 → 기억 서버), `models` (서버 → 모델, where subscription accounts log in, rather than the gateway's own page at 11450), `share` (서버 → 공유), `backup` (백업), `admin` (관리자).

## Over SSH

When the environment has `SSH_CONNECTION`, this computer was opened over SSH: the browser window `ui open` asked for opens on this computer's own screen, and the app answers only on this computer's 127.0.0.1. The person sets up from the browser of the computer in front of them, through an SSH forward, so the line goes on with:

이 컴퓨터는 SSH로 열려 있습니다. 앞에 있는 컴퓨터의 터미널에서 `ssh -L <port>:127.0.0.1:<port> <user>@<host>`를 실행해 둔 채로 그 컴퓨터의 브라우저에서 <url>을 여세요.

`<port>` is the port of `<url>` (4180), `<user>` this computer's user name (`whoami`), and `<host>` the third value of `SSH_CONNECTION`; when its fourth value is not 22, add `-p <that value>`. When the person says the forward failed because the port is taken on their computer (their own Team Memory app holds it), give the same command with `14180:127.0.0.1:<port>` and the address with 14180 in place of the port.

## When the app does not open

Say only these, then stop:

- `node` is missing or older than 18: Node.js 18 이상이 없어 팀 메모리 앱을 열지 못했습니다. 공식 방법(<설치 명령이나 주소>)으로 설치할까요? On yes, install it as step 1 of "에이전트에게" in `<plugin-root>/README.md` says, and open the app with that node's full path.
- `ui open` answers `ok: false`: 팀 메모리 앱을 열지 못했습니다. <its error, in the user's words>. "Something else is answering at …" is: <그 주소의 포트> 포트를 다른 프로그램이 쓰고 있습니다. 그 프로그램을 닫은 뒤 다시 말해 주세요.
- `team status` fails: go on as if it had shown a team.

## Secrets stay in the app

A server token lets a computer write to a memory server, and a Cloudflare API token can change the team's whole Cloudflare setup, so both go from the person straight into the app's window and never through chat, where they would stay in the transcript. Never ask for one. When the person pastes one into chat anyway, do not use, repeat or keep it, and say: token은 채팅에 넣지 말고 팀 메모리 앱의 창에 넣으세요.

## Work done only in a terminal

`<plugin-root>/AGENTS.md` has what no screen of the app does, to run only when the user asks for it: `target backfill`, `test`, `set` and `remove` ("Also sending some folders to another server"), `server share enable` with a tunnel made by hand ("Turning it on by hand"), moving to another computer and restoring a backup ("Safety and rollback"), and the portable profile ("Server profiles"). The rules below hold for that work too.

## Safety

- Preserve unrelated hooks and settings. The CLI removes only entries bearing its managed markers and creates timestamped backups before rewriting existing files.
- Never display API tokens, bearer tokens, or secret environment values.
- Never put the gateway's router key on a command line or in chat. `server prepare` writes it into the installed private `.env`, and no result prints it. The opt-in live verification reads it there inside the process, sends it only to this machine's router, discards the completion response body, and reports only success/model.
- The sharing this version supports is a team (its roster, requests and approvals, each server's own permissions), reading teammates' memories (the `team-memory` MCP server), opening this computer's memory to the user's other computers and to teammates the user approves, and sending chosen folders to a target the user adds explicitly. Do not add teammates, approve requests, open folders to teammates, add targets, folders or backfills the user did not ask for, and do not add cross-device synchronization.
- A tunnel token or an invite code lets a computer serve a team address, so like the tokens above it stays between the user and the app: the user types it into the app or sets it in their own terminal, and you neither ask for it nor read or print it. The team login and the device keys live in the app's `team-auth.json`; never read or print it.
- Do not claim Honcho was installed when `server start`, `server status`, or `doctor` reports it unreachable. For `personal`, success also requires the gateway's router answering (`host.gateway.router.ok`), healthy Ollama, and the Qwen alias resident.
- Use the same profile for the complete lifecycle. `server status --profile personal` covers Docker, the gateway and Ollama; `server stop --profile personal` stops the containers and the Ollama supervisor while preserving configuration and Docker volumes. The gateway keeps running: it has its own lifecycle, and `node <app-directory>/runtime/subscription-gateway/gateway/cli.mjs uninstall` is what removes it.
- `server stop` preserves Docker volumes. Never run `docker compose down -v` or otherwise delete memory data.
- Do not rerun `apply` with guessed identity values. Ask for the missing peer ID.
- Before moving to another computer or a destructive repair, have a consistent PostgreSQL dump and a protected copy of the Team Memory application-data directory. Treat a backup holding `.env` or `config.json` as a secret, and do not state that a backup exists unless its database and application-data contents were actually verified.
