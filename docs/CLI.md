# Brise CLI (`brise`)

외부 셸, 스크립트, 크론, 에이전트가 Brise 앱 밖에서 로컬 DB 데이터를 읽고 쓸 수 있도록 제공하는 명령줄 인터페이스(CLI)입니다.

## 1. 아키텍처 원칙

- **새 서버를 띄우지 않습니다.** 데스크톱 앱 내장 동기화 서버(`POST /api/v1/invoke`)를 그대로 사용합니다.
- **CLI는 얇은 프록시입니다.** 비즈니스 로직 0줄, 인자 및 플래그는 `specs/commands/*.yaml` 스펙으로부터 기계적으로 코드젠(`cli/commands.gen.json`)됩니다.
- **의존성 0.** Node 내장 모듈(`node:sqlite`, `fetch`)만 사용합니다. 그래서 **Node 22.13 이상**이 필요합니다(`node:sqlite` 가
  플래그 없이 열리는 첫 버전, `package.json` 의 `engines`). 개발 PC 와 CI 는 저장소 루트 `.nvmrc`(24)를 따릅니다.
- **실시간 UI 반영.** CLI를 통한 쓰기는 `origin: "remote"`로 데스크톱 앱 웹뷰에 SSE로 전파되어 실행 중인 UI가 즉시 갱신됩니다.

---

## 2. 사용법 & 인터페이스

```bash
brise <command> [--field value ...]     # 커맨드 실행 → 결과 JSON을 stdout에 출력
brise ls [pattern]                      # 커맨드 목록(그룹별). pattern은 부분일치 필터
brise help <command>                    # 인자·타입·필수 여부 + 스펙 파일 위치
```

- 결과는 가공 없는 순수 `JSON` 형태로 표준 출력(`stdout`)됩니다 (`jq` 등으로 파이프라인 구성 가능).
- 실패 시에는 오류 메시지가 표준 에러(`stderr`)로 출력되고 exit code 1로 종료됩니다.

### 인자 전달 규칙

| 타입 | 문법 | 비고 |
|---|---|---|
| `string` | `--title "회의록"` 또는 `--title=회의록` | 값이 `-`이면 **stdin 전체**를 읽어 주입합니다 |
| `integer` / `number` | `--year 2026` | 숫자가 아니면 에러. integer는 정수 검사 |
| `boolean` | `--favorite` / `--favorite=false` / `--no-favorite` | 값 생략 시 `true` |
| `array` | `--tag_names dev --tag_names sprint` | 플래그 반복 (콤마 분리 금지). `["dev","sprint"]` JSON 배열 문자열도 가능 |
| `json` | `--region '{"kind":"preset","preset_id":"tokyo"}'` | `JSON.parse` 유효 객체 |
| (탈출구) | `--args '{"title":"회의록","year":2026}'` | raw JSON 객체 통째 병합 |

---

## 3. 환경 변수 & 접속 해석

접속 주소와 인증 토큰은 다음 순서로 자동 해석됩니다:

1. **환경변수 우선**:
   - `BRISE_URL`: 동기화 서버 URL (예: `http://127.0.0.1:7332`)
   - `BRISE_TOKEN`: 동기화 인증 토큰
2. **로컬 DB 자동 탐색**:
   - 환경변수가 없으면 OS 기본 데이터 디렉터리(`BRISE_DATA_DIR` 또는 `%APPDATA%\com.brise.app\brise.db` / `~/Library/Application Support/...` / `~/.local/share/...`)의 SQLite `settings` 테이블에서 `sync_port`와 `sync_token`을 읽습니다.
   - 루프백(`127.0.0.1`) 및 Tailscale/로컬 IPv4 주소로 `GET /api/v1/ping`을 시도하여 살아있는 서버 주소를 자동 선택합니다.

> **주의**: CLI를 사용하려면 데스크톱 Brise 앱이 실행 중이어야 하며, **설정 > 동기화(Sync)** 기능이 활성화되어 있어야 합니다.

---

## 4. 커맨드 표면 (131 / 228)

`POST /api/v1/invoke`를 통해 외부에서 호출 가능한 커맨드는 `http: true`로 지정된 131개입니다. (매니페스트: `cli/commands.gen.json`)

### 사용 가능한 커맨드 영역 (131개)

| 영역 | 개수 | 대표 커맨드 |
|---|---|---|
| **노트 본체·메타** (`notes`) | 50 | `note_create`, `note_get`, `note_update`, `note_delete`, `note_restore`, `note_purge`, `note_query`, `note_year_histogram`, `note_toggle_favorite`, `note_set_status`, `note_set_tags`, `note_set_location`, `note_date_update` 등 |
| **폴더·태그** (`notes`) | ↑ 포함 | `folder_list`, `folder_create`, `folder_rename`, `tag_counts`, `tag_colors`, `tag_rename`, `tag_merge`, `tag_delete` 등 |
| **섹션(본문 변경)** (`sections`) | 6 | `section_create`, `section_create_with_body`, `section_update`, `section_delete`, `section_reorder`, `sheet_set_cells` |
| **공간(2D 캔버스)** (`space`) | 30 | `space_list`, `space_create`, `space_item_*`, `space_node_*`, `space_edge_*`, `space_relation_get/save`, `space_viewport_set` 등 |
| **노트북·분류축** (`workspaces`) | 17 | `workspace_list`, `workspace_create`, `workspace_rename`, `workspace_region_*`, `workspace_status_*` 등 |
| **대시보드(보드/캘린더/그래프)** (`dashboard`) | 7 | `dashboard_board`, `dashboard_calendar`, `dashboard_timeline`, `dashboard_graph`, `schedule_today`, `todo_toggle` |
| **첨부** (`attachments`) | 10 | `attachment_add_link`, `attachment_add_footnote`, `attachment_remove`, `attachment_query`, `attachment_read_text` 등 |
| **AI** (`ai`) | 8 | `ai_organize_note`, `ai_apply_organize`, `ai_translate_text`, `ai_cleanup_text`, `ai_generate_from_prompt` 등 |
| **제안·링크** (`suggestions`) | 6 | `suggestions_list`, `suggestion_set_status`, `link_suggest`, `link_preview` |
| **루틴 / 설정 / 검색 / 기타** | 12 | `routine_today`, `routine_toggle`, `settings_get_all`, `search_notes`, `geocode_search` 등 |

### 지원되지 않는 커맨드 (81개) 및 차단 이유

| 영역 | 차단 이유 |
|---|---|
| **내보내기/가져오기/백업** (`export_*`, `import_*`, `backup_*`, `db_reset`) | 인자가 **로컬 파일시스템 절대 경로**이므로 보안상 원격/HTTP 호출이 차단되어 있습니다 (`http: false`). |
| **수집기 네트워크 트리거** (`collect_*`) | 외부 fetch를 원격 API에서 무제한 트리거하는 것을 방지하는 정책입니다. |
| **스냅샷** (`note_snapshot_*`) | 파괴적 로컬 디스크 파일 조작. |
| **OS UI/다이얼로그 의존** (`pet_*`, `capture_*`, `notify_send`, `activity_list`) | 데스크톱 네이티브 창, 시스템 트레이, OS 알림창 핸들이 필요합니다. |
| **동기화 서버 제어** (`sync_set_enabled`, `sync_regenerate_token`) | 원격 호출자가 자기 자신의 연결 서버를 강제 종료하거나 토큰을 변경하지 못하도록 하는 영구 불변 규칙입니다. |

---

## 5. 주요 활용 예시 5가지

### 1) 노트 검색 (`search_notes`)
```bash
brise search_notes --query "프로젝트 기획" --year_from 0 --year_to 9999
```

### 2) 새 노트 생성 (`note_create`)
```bash
brise note_create --folder_id "018e..." --title "2026-08-26 회의록" --year 2026
```

### 3) 마크다운 본문 주입 (stdin `-` 활용)
```bash
# 파일 내용을 섹션 본문으로 업데이트
cat meeting_notes.md | brise section_update --id "018e..." --body_md -

# 본문을 함께 넣어 새 섹션 생성 — section_create 에는 body_md 가 없다(section_create_with_body 를 쓴다)
printf '## 완료 항목\n- [x] CLI 명세 작성\n' | brise section_create_with_body --note_id "018e..." --body_md -
```

### 4) 노트 상태 및 메타데이터 변경 (`note_set_status`)
```bash
brise note_set_status --id "018e..." --status "in_progress"
```

### 5) 대시보드 칸반/보드 현황 조회 (`dashboard_board`)
```bash
brise dashboard_board --workspace_id "018e..." | jq '.columns'
```

---

## 6. 설치 & 실행 방법

```bash
# 레포지토리 루트에서 바로 실행
node cli/brise.mjs help

# npm 스크립트로 실행
npm run cli -- help

# 전역 링크 (어디서나 brise 커맨드로 사용)
npm link
brise ls
```

---

## 7. Model Context Protocol (MCP) 연동 (`brise mcp`)

Claude Code, Claude Desktop 등 MCP 호환 AI 에이전트가 로컬 Brise 데이터를 안전하게 조회하고 작성할 수 있도록 표준 stdio MCP 서버 모드를 제공합니다.

### 7.1 특징 및 안전 가드레일
- **스펙 기반 선별 노출 (17개 도구)**: 파괴적 삭제(`note_delete`, `note_purge` 등)나 임의 설정 변경(`settings_set`)은 도구 목록에 노출되지 않으며, 호출 시에도 프로토콜 레벨에서 거부됩니다 (`cli/agent-tools.gen.json`).
- **읽기 + 추가 중심 쓰기**: 노트북 조회(`workspace_list`), 메타 조회(`folder_list_meta`), 검색(`search_notes`), 노트 생성(`note_create`), 본문 섹션 추가(`section_create_with_body`), 링크 첨부(`attachment_add_link`), 할 일 토글(`todo_toggle`), 루틴 토글(`routine_toggle`) 등 안전한 작업만 허용합니다.
- **의존성 0 & stdio 격리**: 외부 라이브러리 없이 JSON-RPC 2.0으로 직접 통신하며, stdout을 오염시키지 않습니다.
- **선별은 경계가 아니라 가드레일입니다**: 도구 목록은 정상 동작하는 에이전트의 실수를 막을 뿐, `sync_token` 자체는 여전히 131개 커맨드 전부를 엽니다. 신뢰 경계는 CLI 와 같습니다(같은 PC 에서 `brise.db` 를 읽을 수 있는 프로세스 = 토큰 보유).
- **tailnet 부수 노출**: 동기화 서버가 켜져 있어야 동작하는데, Tailscale 이 있는 PC 에서는 그 서버가 tailnet 주소에 떠서 토큰을 가진 tailnet 기기에 131개 전부를 엽니다. 로컬 MCP 만 원해도 이 노출은 따라옵니다.
- **프로토콜**: MCP **2026-07-28** 전용입니다(요청별 `_meta` 로 버전 선언, `server/discover` 지원, `initialize` 핸드셰이크 없음). 핸드셰이크 세대(≤ 2025-11-25)만 말하는 클라이언트의 `initialize` 에는 지원 버전을 담은 `-32022` 오류로 답합니다.

### 7.2 클라이언트 등록 방법

> **보안 주의**: 이 저장소의 `.mcp.json`에 `brise`를 등록하지 마십시오 (저장소 개발 에이전트가 오너의 실제 개인 노트를 건드리는 것을 방지). 반드시 **사용자 스코프**로 등록하십시오.

#### Claude Code (CLI)
```bash
claude mcp add --scope user --transport stdio brise -- node <저장소-절대경로>/cli/brise.mjs mcp
```

> **dev 빌드(`npm run tauri:dev`)를 쓰는 동안**: dev 앱은 데이터 폴더가 `%APPDATA%\com.brise.app.dev` 다. CLI 는 기본으로 릴리즈 폴더(`com.brise.app`)를
> 읽으므로 "동기화 설정이 DB 에 없다"고 실패한다. `--env BRISE_DATA_DIR=<%APPDATA%>\com.brise.app.dev` 를 `--transport` 앞에 넣어 등록한다
> (Claude Desktop 은 `"env": { "BRISE_DATA_DIR": "…" }`).

#### Claude Desktop
`claude_desktop_config.json`에 다음 설정을 추가합니다:
```json
{
  "mcpServers": {
    "brise": {
      "command": "node",
      "args": ["<저장소-절대경로>/cli/brise.mjs", "mcp"]
    }
  }
}
```

### 7.3 사용 흐름
1. 데스크톱 Brise 앱을 실행하고 **설정 > 연결 > 동기화 서버**를 켭니다.
2. AI 에이전트가 `workspace_list`로 노트북 목록과 `active_id`를 확인합니다.
3. 노트를 생성할 때는 `folder_list_meta`로 `folder_id`를 얻은 뒤 `note_create` → `section_create_with_body` 순서로 본문을 작성합니다.
4. 모든 쓰기 작업은 데스크톱 앱에 `origin: "remote"`로 실시간 반영되어 사용자가 즉시 화면에서 확인할 수 있습니다.

### 7.4 설정 > 연결에서 설치하기

**설정 > 연결**의 "AI 에이전트 연결 (MCP)" 카드(동기화 서버가 켜져 있을 때만 보임)에서 "스킬 설치하기"를 누르면
`agent_skill_install`(`commands/sync.rs`)이 `~/.claude/skills/brise/SKILL.md` 를 쓰고(앱 소유 파일, 덮어씀), 앱에 번들된
`cli/brise.mjs`(`tauri.conf.json` resources)의 절대경로와 이 앱의 `BRISE_DATA_DIR` 이 박힌 `claude mcp add …` 명령을 화면에
보여준다. MCP 의 "켜기"는 새 스위치가 아니라 동기화 서버다. 노트는 SQLite 안에 있어 에이전트 "작업 폴더"로 지정할
노트북 폴더는 없다. 스킬 본문은 `src-tauri/src/commands/agent_skill.md`.
