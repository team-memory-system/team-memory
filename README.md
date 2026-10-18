<img src="ui/logo.svg" width="64" height="64" alt="">

# Team Memory

Claude Code와 Codex에서 나눈 대화를 내 기억 서버에 모아, 에이전트가 지난 일을 기억하고 일하게
합니다. 팀원이 열어 준 폴더의 대화는 내 에이전트가 직접 찾아 읽습니다. "밥에게 OCR 엔진 뭐로
바꿨는지 찾아봐"처럼 팀원 이름을 넣어 말하면 됩니다.

## 설치

Claude Code나 Codex에 이렇게 말하세요.

```text
팀 메모리 설치해 줘. https://github.com/team-memory-system/team-memory
```

에이전트가 플러그인을 깔고 팀 메모리 앱을 엽니다. 나머지는 앱의 팀 메모리 시작하기 창에서 합니다.
관리자에게 받은 초대 문구가 있으면 그 문구를 그대로 말하세요. 이 컴퓨터에 기억 서버를 만들 때
필요한 Docker Desktop과 Ollama는 앱이 설치합니다.

설치한 뒤에는 "민준 기억 열람 요청해 줘", "팀 만들어 줘"처럼 말하면 에이전트가 앱의 그 화면을 엽니다.

직접 설치하려면 Node.js 18 이상과 git이 있어야 합니다.

**Claude Code**
```sh
/plugin marketplace add team-memory-system/team-memory
/plugin install team-memory@team-memory
```

**Codex**
```sh
codex plugin marketplace add team-memory-system/team-memory
codex plugin add team-memory@team-memory
```

설치한 뒤 Claude Code는 `/reload-plugins`를 입력하고 `/team-memory setup`을 입력합니다. Codex는 새
세션을 열고 `$setup-memory`를 입력합니다. 앱이 열리고 팀 메모리 시작하기 창이 뜹니다.

### 에이전트에게

사용자가 이 저장소 주소와 함께 설치해 달라고 하면 아래대로 합니다. 설정은 앱의 팀 메모리 시작하기 창이
묻고 안내하므로, 사용자에게 하는 말은 아래에 따옴표로 적은 말과 오류뿐입니다. 진행 상황을 말하지 않고,
1번의 질문 말고는 대답을 기다리지 않습니다.

1. `node --version`(18 이상)과 `git --version`을 봅니다. 없는 것이 있으면 공식 방법으로 깔아도 되는지
   한 번만 묻습니다: "<없는 프로그램>이 없습니다. 공식 방법(<명령>)으로 설치할까요?" 내려받은 스크립트를
   셸에 바로 넣거나 비공식 패키지로 바꿔 깔지 않습니다. 셸에 넣은 스크립트는 아무도 읽기 전에 돌고,
   비공식 패키지는 배포한 곳이 내놓은 것이 아니기 때문입니다.
   - Windows: `winget install --id OpenJS.NodeJS.LTS -e`, `winget install --id Git.Git -e`. winget으로
     깐 프로그램은 이미 열린 세션의 PATH에 없습니다. 그 세션에서는 `ui open`까지 모든 명령을
     `C:\Program Files\Git\cmd`와 `C:\Program Files\nodejs`를 PATH 앞에 붙여 실행합니다. PowerShell이면
     `$env:Path = 'C:\Program Files\Git\cmd;C:\Program Files\nodejs;' + $env:Path; <명령>`입니다.
     `ui open`이 띄운 앱이 그 PATH를 물려받고, 팀 메모리 시작하기 창의 적용이 그 PATH의 git으로
     소스를 받기 때문입니다.
   - macOS: Node.js는 Homebrew가 있으면 `brew install node`(`/opt/homebrew/bin/node`), 없으면
     https://nodejs.org/ko/download 의 설치 프로그램입니다. git은 `xcode-select --install`입니다.
   - 사람이 마쳐야 하는 설치(Command Line Tools 창, nodejs.org의 설치 프로그램, 다른 운영체제의
     설치)는 그 창이나 내려받을 페이지를 연 뒤 "설치를 마친 뒤 같은 말을 다시 하세요." 한 줄로
     끝냅니다.
2. 이 에이전트(Claude Code나 Codex)의 플러그인 폴더를 찾습니다. Claude Code는
   `~/.claude/plugins/installed_plugins.json`의 `plugins["team-memory@team-memory"][0].installPath`,
   Codex는 `~/.codex/plugins/cache/team-memory/team-memory/` 아래의 판 폴더입니다(Windows는 `~` 대신
   `%USERPROFILE%`). 이미 있으면 다시 깔지 않습니다. 없으면 깔고 다시 찾습니다.
   - Claude Code: `claude plugin marketplace add team-memory-system/team-memory` 다음
     `claude plugin install team-memory@team-memory --scope user`
   - Codex: `codex plugin marketplace add team-memory-system/team-memory` 다음
     `codex plugin add team-memory@team-memory`
3. `node "<플러그인 폴더>/scripts/cli.mjs" ui open --screen dashboard`를 실행합니다. 사용자의 말에
   "팀 주소 <팀 주소>"가 있으면(관리자가 보낸 초대 문구) `--screen 'start?team=<팀 주소>'`이고, 팀
   주소에서 `https://`와 끝의 `/`는 뺍니다.
4. 결과의 `url`을 넣어 이 한 줄을 말하고 끝냅니다: "팀 메모리 앱을 열었습니다. 브라우저 창에서 이어
   하세요. <앱 주소>"
5. SSH로 연 컴퓨터(`SSH_CONNECTION`이 있음)면 4번의 한 줄 뒤에 붙입니다: "이 컴퓨터는 SSH로 열려
   있습니다. 앞에 있는 컴퓨터의 터미널에서
   `ssh -o ExitOnForwardFailure=yes -L 4180:127.0.0.1:4180 <사용자>@<컴퓨터 주소>`를 실행해 둔 채로
   그 컴퓨터의 브라우저에서 <앱 주소>를 여세요." 앱은 이 컴퓨터의 127.0.0.1에서만 답하고, `ui open`이
   부른 브라우저는 이 컴퓨터 화면에 뜨기 때문입니다. <사용자>는 `whoami`(Windows는 `\` 뒤),
   <컴퓨터 주소>는 `SSH_CONNECTION`의 셋째 값이고, 넷째 값이 22가 아니면 `-p <넷째 값>`을 붙입니다.
   - 앞 컴퓨터가 4180을 이미 쓰고 있으면(그 컴퓨터의 팀 메모리 앱) `ExitOnForwardFailure=yes` 때문에
     이 명령은 붙지 않고 끝납니다. 이 옵션이 없으면 경고만 내고 붙어서, 브라우저가 앞 컴퓨터 자신의
     앱을 엽니다. 사용자가 그렇게 끝났다고 하면 `-L 14180:127.0.0.1:4180`으로 바꾼 명령과, <앱 주소>의
     4180을 14180으로 바꾼 주소를 줍니다.

## 켜고 끄기

Claude Code에서 `/team-memory`를 입력합니다. 바로 실행되고, 한 일과 되돌리는 법을 한 줄로 답합니다.
Codex에는 이 명령이 없습니다. Codex에서는 팀 메모리 앱에서 같은 버튼을 누르고, 대화 수집
설정 창은 `$setup-memory`로 엽니다.

| 입력 | 하는 일 |
|---|---|
| `/team-memory` | 지금 무엇이 켜져 있는지 보여 줍니다 |
| `/team-memory off`, `on` | 기억 서버를 멈추거나 다시 켭니다. 멈추면 이 컴퓨터의 기억 찾기와 대화 모으기도 멈춥니다 |
| `/team-memory shared-off`, `shared-on` | 팀원과 내 다른 컴퓨터에 연 서버를 닫거나 다시 엽니다 |
| `/team-memory shared-off <팀원>`, `shared-on <팀원>` | 그 팀원 한 사람의 열람만 끄거나 켭니다. 열어 준 폴더는 그대로 둡니다 |
| `/team-memory setup` | 팀 메모리 앱의 대화 수집 설정 창을 엽니다. 설정하기 전이면 팀 메모리 시작하기 창이 뜹니다 |
| `/team-memory doctor` | 잘못된 곳을 찾아 알려 줍니다. 플러그인을 올린 뒤 옛 판에 머문 설정·기억 서버·게이트웨이·앱은 바로 새 판에 맞춥니다 |

## 업데이트

팀 메모리 앱 오른쪽 위 종에 새 판이 뜨면 업데이트를 누르세요.

직접 올리려면 아래 명령을 실행합니다.

```sh
claude plugin marketplace update team-memory
claude plugin update team-memory@team-memory

codex plugin marketplace upgrade
codex plugin add team-memory@team-memory
```

그다음 Claude Code를 새로 열고 `/team-memory doctor`를 입력합니다. Codex만 쓰면 터미널에서 새 판 폴더의
`scripts/cli.mjs`로 `doctor --fix`를 실행합니다(`~/.codex/plugins/cache/team-memory/team-memory/<판>/`).
이 컴퓨터에 기억 서버가 있으면 서버와 게이트웨이도 새 판으로 다시 시작합니다. 몇 분 걸릴 수 있습니다.

## 함께 설치되는 것

직접 설치하는 것은 이 플러그인 하나입니다. 이 컴퓨터에 기억 서버를 만들면 아래 둘을 정해 둔
버전으로 받아 실행합니다.

- [honcho-selfhost](https://github.com/team-memory-system/honcho-selfhost): 기억 서버 (AGPL-3.0)
- [subscription-gateway](https://github.com/team-memory-system/subscription-gateway): Codex·Claude
  구독으로 모델을 부르는 중계 프로그램 (AGPL-3.0)

## 더 자세한 설명

[AGENTS.md](AGENTS.md)는 에이전트와 개발자를 위한 설명서입니다. 구조, 명령, 주의할 점이 있습니다.

## 라이선스

MIT
