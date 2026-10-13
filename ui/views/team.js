// 팀: teammates' memories this computer's agents read, and who may read mine.
//
// 팀원 기억 lists every member from the team hub. Reading a teammate's memory starts
// with a request (열람 요청), which its owner approves with the folders they open;
// from then on Claude Code and Codex search and read those conversations through the
// plugin's team-memory MCP server, with this computer's team servers login, which the
// row offers while it is missing. 내 기억을 여는 팀원 is the other way: what this
// computer's server opened to whom (its gate's access.json), with 수정 for the
// folders and ChatGPT 기록 and for closing it again, a switch that turns a
// teammate's access off for now and on again, and who collects into it. A teammate
// the hub has as approved but this server opened nothing to (the team's address
// moved here from another computer) gets 폴더 고르기, ticked as the hub named it. Who read my
// memory is the 조회 기록 menu (audit.js). A team login that ended says so, with 다시
// 로그인, instead of the screen.
import { h, clear } from "../lib/dom.js";
import { confirmWindow, list, listItem } from "../lib/kit.js";
import { shortPath } from "../lib/collect.js";
import { openedText } from "../lib/folder-grants.js";
import { appRecords, josa } from "../lib/format.js";
import { chooseFolders, loadRequests, serversLoginButton } from "../lib/requests.js";
import { endedLogins, loginNotice, personName as nameOf, sendRequest, teamCall, teamDirectory, teamErrorNotice, teamStatus } from "../lib/team.js";
import { refreshBell } from "../lib/bell.js";
import { app, go } from "../lib/state.js";
import { button, busy, notice, pageHead, spinner, tag, toast, toggle } from "../lib/ui.js";

/** What is open to a teammate: the first few folders by name, then the apps, such as ChatGPT 기록. */
function foldersText(folders, sources = []) {
  if (!folders.length && !sources.length) return "열린 폴더 없음";
  const names = folders.slice(0, 3).map((entry) => `${shortPath(entry.path)}${entry.subfolders ? "" : " (그 폴더만)"}`);
  const more = folders.length > 3 ? ` 외 ${folders.length - 3}개` : "";
  const apps = sources.map(appRecords);
  if (!folders.length) return `열린 대화: ${apps.join(" · ")}`;
  return `열린 폴더: ${[`${names.join(" · ")}${more}`, ...apps].join(" · ")}`;
}

export default {
  title: "팀",
  async mount(page) {
    const body = h("div", { class: "pad stack" });
    page.append(
      pageHead({ title: "팀", subtitle: "팀원에게 기억 열람을 요청하고, 내 기억을 누구에게 열었는지 봅니다." }),
      h("div", { class: "page-body" }, body),
    );

    async function draw() {
      const team = app.context?.team || {};
      if (!team.hub || !team.signedIn) {
        const ended = team.hub ? endedLogins(await teamStatus().catch(() => null)).find((item) => item.kind === "hub") : null;
        clear(body, ended
          ? loginNotice({ ...ended, onDone: draw })
          : notice("warn", "팀에 로그인하지 않았습니다. ", button("팀에 들어가기", { kind: "small", onClick: () => go("start") })));
        return;
      }
      let directory;
      let requests;
      let status;
      try {
        [directory, requests, status] = await Promise.all([
          teamDirectory(),
          loadRequests({ fresh: true }),
          teamStatus().catch(() => null),
        ]);
      } catch (error) {
        clear(body, teamErrorNotice(error, { onDone: draw }));
        return;
      }
      const servers = new Map((directory.servers || []).map((server) => [server.owner, server]));
      const outgoing = new Map();
      for (const request of requests?.outgoing || []) {
        if (request.kind === "chat" && !outgoing.has(request.server)) outgoing.set(request.server, request);
      }
      // What an opened memory needs here: the login to the team's servers, once.
      const signedIn = Boolean(status?.serversLogin?.signedIn);
      const opened = [];

      const mateRow = (person) => {
        const server = servers.get(person.email);
        if (!server) return listItem({ title: nameOf(person), sub: "서버 없음" });
        const request = outgoing.get(server.host);
        if (request?.status === "approved") {
          opened.push({ name: nameOf(person), host: server.host });
          return listItem({ title: nameOf(person), tags: [" ", tag("열림", "ok")], sub: openedText(request.projects) });
        }
        if (request?.status === "pending") {
          return listItem({
            title: nameOf(person),
            tags: [" ", tag("승인 기다리는 중", "warn")],
            sub: server.host,
            end: button("요청 취소", { kind: "small quiet", onClick: (event) => busy(event.currentTarget, async () => {
              await teamCall("/api/team/cancel", { id: request.id });
              refreshBell();
              await draw();
            }) }),
          });
        }
        return listItem({
          title: nameOf(person),
          tags: request?.status === "declined" ? [" ", tag("거절됨")] : request?.status === "revoked" ? [" ", tag("닫힘")] : [],
          sub: server.host,
          end: button("열람 요청", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
            await sendRequest({ kind: "chat", server: server.host });
            refreshBell();
            await draw();
          }, { done: `${nameOf(person)}에게 기억 열람을 요청했습니다` }) }),
        });
      };

      const mates = (directory.people || []).filter((person) => person.email !== team.email).map(mateRow);
      // What is opened to whom lives beside the server, so the computer that runs it lists it.
      const myServer = servers.get(team.email);
      const granted = myServer && myServer.host === team.localHost ? grantRows(requests, directory) : null;
      clear(body,
        // One login reaches every teammate's server, so it is asked for once, above them.
        opened.length && !signedIn
          ? notice("warn", "열린 기억을 읽으려면 팀 서버 로그인이 한 번 필요합니다. ", serversLoginButton(opened[0].host, { onDone: draw }))
          : null,
        list({ title: "팀원 기억", empty: "아직 다른 팀원이 없습니다." }, mates),
        opened.length ? h("p", { class: "hint" }, `Claude Code나 Codex에게 "${opened[0].name}에게 OCR 엔진 뭐로 바꿨는지 찾아봐"처럼 팀원 이름을 넣어 말하면, 열린 대화에서 찾아 답합니다.`) : null,
        granted ? list({ title: "내 기억을 여는 팀원", empty: "아직 없습니다." }, granted) : null);
    }

    /** What this computer's server opened to whom: its folders to read, or collecting into it. */
    function grantRows(requests, directory) {
      const people = new Map((directory.people || []).map((person) => [person.email, person]));
      const approved = new Map();
      for (const request of requests?.granted || []) approved.set(`${request.kind}:${request.from}`, request);
      const opened = new Set((requests?.grants || []).filter((grant) => grant.chat).map((grant) => grant.email));
      const unopened = [...approved.values()]
        .filter((request) => request.kind === "chat" && !opened.has(request.from))
        .map((request) => {
          const person = people.get(request.from) || { email: request.from, peer: request.fromPeer, name: request.fromName };
          return listItem({
            title: nameOf(person),
            tags: [" ", tag("기억 열람"), tag("열린 폴더 없음", "warn")],
            sub: "승인했지만 이 서버에는 연 폴더가 없습니다. 폴더 고르기를 누르세요.",
            end: button("폴더 고르기", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
              await openAgain(person, request);
            }) }),
          });
        });
      return [...unopened, ...(requests?.grants || []).flatMap((grant) => {
        const person = people.get(grant.email) || { email: grant.email, peer: grant.peer };
        const rows = [];
        if (grant.chat) {
          const request = approved.get(`chat:${grant.email}`);
          const name = nameOf(person);
          const off = grant.chat.off === true;
          rows.push(listItem({
            title: name,
            tags: [" ", tag("기억 열람"), off ? tag("꺼 둠", "warn") : null],
            sub: foldersText(grant.chat.folders || [], grant.chat.sources || []),
            dim: off,
            end: [
              button("수정", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
                await editGrant(person, grant, request);
              }) }),
              // No confirm: what is open stays, and the switch puts it back.
              toggle(!off, async (next) => {
                await teamCall("/api/team/grant", { email: grant.email, off: !next });
                // Said once the row shows it, not while it still says 꺼 둠.
                await draw();
                toast(`${josa(name, "을/를")} ${next ? "켰습니다" : "껐습니다"}`, "ok");
              }, { label: `${name}에게 내 기억 열기` }),
            ],
          }));
        }
        if (grant.collect) {
          const request = approved.get(`collect:${grant.email}`);
          rows.push(listItem({
            title: nameOf(person),
            tags: [" ", tag("대화 쌓기")],
            sub: "이 서버에 대화를 쌓습니다",
            end: button("멈추기", { kind: "small danger", onClick: async (event) => {
              const ok = await confirmWindow({ title: `${nameOf(person)}의 대화 쌓기를 멈출까요?`, text: `${grant.email} 의 컴퓨터는 이 서버에 더 이상 쌓지 못합니다. 이미 쌓인 대화는 그대로 둡니다.`, confirm: "멈추기", danger: true });
              if (!ok) return;
              await busy(event.currentTarget, async () => {
                await teamCall("/api/team/stop-collect", { email: grant.email, request: request?.id || "" });
                await draw();
              });
            } }),
          }));
        }
        return rows;
      })];
    }

    /** 폴더 고르기: what the approval opened, as the hub named it, ticked to open on this server. */
    async function openAgain(person, request) {
      const name = nameOf(person);
      const chosen = await chooseFolders({
        title: `${name}에게 연 폴더`,
        lead: `${name}의 에이전트가 찾아서 그대로 읽는 폴더입니다. 승인할 때 연 폴더를 골라 두었습니다.`,
        who: name,
        chosenNames: request.projects || [],
        confirm: "적용",
      });
      if (!chosen) return;
      await teamCall("/api/team/grant", { email: request.from, peer: request.fromPeer || person.peer, ...chosen, request: request.id });
      await draw();
      toast(`${name}에게 내 기억을 열었습니다`, "ok");
    }

    /** 수정: the folders and ChatGPT 기록 open to a teammate, or 끊기 to close my memory to them. */
    async function editGrant(person, grant, request) {
      let closed = false;
      const name = nameOf(person);
      const close = button(`${name} 끊기`, { kind: "danger", onClick: async (event) => {
        const target = event.currentTarget;
        const ok = await confirmWindow({
          title: `${josa(name, "을/를")} 끊을까요?`,
          text: `${josa(name, "은/는")} 내 기억을 더 이상 찾아보지 못합니다. 다시 열려면 ${josa(name, "이/가")} 열람 요청부터 다시 보내야 합니다. 잠깐 막으려면 목록의 스위치를 끄세요.`,
          confirm: "끊기",
          danger: true,
        });
        if (!ok) return;
        await busy(target, async () => {
          await teamCall("/api/team/grant", { email: grant.email, request: request?.id || "", close: true });
          closed = true;
          target.closest("dialog")?.close();
        }, { done: `${josa(name, "을/를")} 끊었습니다` });
      } });
      const chosen = await chooseFolders({
        title: `${name}에게 연 폴더`,
        lead: `${name}의 에이전트가 찾아서 그대로 읽는 폴더입니다.`,
        who: name,
        chosen: grant.chat.folders || [],
        chosenSources: grant.chat.sources || [],
        confirm: "적용",
        extra: close,
      });
      if (chosen && !closed) await teamCall("/api/team/grant", { email: grant.email, peer: grant.peer, ...chosen, request: request?.id || "" });
      await draw();
    }

    clear(body, spinner());
    await draw();
    return null;
  },
};
