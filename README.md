# Team Memory

Claude Code와 Codex에서 나눈 대화를 내 기억 서버에 모아, 에이전트가 지난 일을 기억하고 일하게
합니다. 팀원끼리는 서로 열어 준 폴더의 기억에 `chat`으로 물을 수 있습니다.

## 설치

Claude Code나 Codex, Node.js 18 이상, git이 있어야 합니다. 이 컴퓨터에 기억 서버를 만들 때
필요한 Docker Desktop과 Ollama는 앱이 설치합니다.

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
세션을 열고 `$setup-memory`를 입력합니다. 앱이 열리고 처음 설정 창이 뜹니다.

> **에이전트에게.** 플러그인을 설치한 뒤에는 더 진행하지 말고, 사용자에게 위 문장을 그대로 전하세요.
> 그다음은 플러그인의 설치 스킬이 안내합니다.

## 켜고 끄기

Claude Code에서 `/team-memory`를 입력합니다. 바로 실행되고, 한 일과 되돌리는 법을 한 줄로 답합니다.

| 입력 | 하는 일 |
|---|---|
| `/team-memory` | 지금 무엇이 켜져 있는지 보여 줍니다 |
| `/team-memory off`, `on` | 기억 서버를 멈추거나 다시 켭니다. 멈추면 이 컴퓨터의 기억 찾기와 대화 모으기도 멈춥니다 |
| `/team-memory shared-off`, `shared-on` | 팀원과 내 다른 컴퓨터에 연 서버를 닫거나 다시 엽니다 |
| `/team-memory shared-off <팀원>`, `shared-on <팀원>` | 그 팀원 한 사람의 chat만 끄거나 켭니다. 열어 준 폴더는 그대로 둡니다 |
| `/team-memory setup` | 설정을 안내합니다 |
| `/team-memory doctor` | 잘못된 곳을 찾아 알려 줍니다 |

## 업데이트

```sh
claude plugin marketplace update team-memory
claude plugin update team-memory@team-memory

codex plugin marketplace upgrade
codex plugin add team-memory@team-memory
```

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
