# Settings — 설정 체계

> 한 줄 요약: 앱 전역 설정은 `settings` 테이블 하나(key/JSON value)에 저장되고, 저장 가능한
> 모든 키는 Rust `validate_setting`의 허용 목록(allowlist)을 반드시 통과해야 한다 — 목록에 없는
> 키는 조용히 저장이 거부된다.

**SSOT 관계**: 기계가 읽는 SSOT는 `src-tauri/src/repo/settings_schema.rs::validate_setting`
(실제 검증 로직)과 `default_settings`(시드 값). `specs/db/schemas/settings.sql`의 주석은 그
목록을 사람이 읽기 좋게 미러링한 것 — `validate_setting`을 고치면 그 주석도 고쳐야 한다(SSOT는
아님). `specs/features/settings.yaml`이 기능 카탈로그(케이스별 기대값). 이 문서는 그 셋을
통합한 설명이며, 코드와 갈리면 코드를 믿는다.

## 1. 기능 개요

설정은 단일 KV 테이블(`settings(key TEXT PRIMARY KEY, value TEXT)`)에 JSON 인코딩된 값으로
저장된다. 읽기는 `settings_get_all`(전체를 한 번에), 쓰기는 `settings_set`(`entries: {key:
value, ...}` 배치)이 유일한 커맨드다 — 필드별 전용 커맨드는 만들지 않는다(예외: `note_update`의
`remind`처럼 다른 도메인 커맨드가 겸하는 경우는 있음, `docs/DASHBOARD.md` §4).

설정 창(별도 웹뷰, `src/components/settings/`)은 섹션별 컴포넌트로 나뉘어 있고, 사이드 레일에서
섹션을 고르면 그 섹션만 렌더된다(레일은 **5그룹 17페이지**, §2.5). 각 섹션은
스토어(`src/stores/settings.ts`)를 통해 값을 읽고/쓴다.

## 2. 동작 방식

### 2.1 값 구조 — KV + JSON

모든 값은 JSON으로 인코딩돼 저장된다. 타입은 키마다 다르다:
- 단순 스칼라: `theme`("dark"|"light"), `font_scale`(number), `left_width`(int) 등.
- 배열: `filter_roster`, `dashboard_tabs`, `chat_memory`, `recent_closed_tabs` 등 — 각각 항목
  shape이 다르고 `validate_setting`이 개별 필드까지 검사한다.
- 객체: `default_map_location`({lat, lng, zoom}), `pet_assets`({mood: {file, frames, cycle_ms}}).
- 문자열 "0"/"1" 관례: `pet_enabled`, `pet_visible`, `capture_*_enabled` 등 일부 키는 boolean이
  아니라 `"0"`/`"1"` 문자열이다(태스크 브리프가 지정한 관례) — 새 코드를 붙일 때 boolean으로
  착각하지 말 것(`validate_setting` 주석에 명시돼 있음).

### 2.2 새 설정 키 추가 절차 (CLAUDE.md 함정 3)

새 설정 키를 추가할 때 **4곳**을 손대야 한다. 하나라도 빠뜨리면 "설정 화면에서 토글이 켜지는
것처럼 보이는데 재시작하면 꺼져 있다"는 조용한 실패가 난다 — 프런트의 여러 setter가
`.catch(()=>{})`로 실패를 삼키기 때문에 에러조차 안 보인다.

1. **`validate_setting`(`src-tauri/src/repo/settings_schema.rs`)에 match arm 추가** — 진짜
   관문. 이게 없으면 `settings_set`이 매번 `Err(AppError::Validation("unknown setting key"))`를
   던진다. 이 파일 끝의 `_ => Err(...)` 폴백이 모든 미등록 키를 거부한다.
2. **필요하면 `default_settings`에 기본값 시드** — 새 DB/업그레이드 직후 값이 없을 때 어떤 값을
   읽을지 결정한다. 시드하지 않는 키(예: `pet_pos_x`, `backup_auto_last_error`)는 "저장된 적
   없음"이 정상 상태이고, 소비처(프런트 또는 Rust)가 fallback을 직접 들고 있다.
3. **`specs/db/schemas/settings.sql` 주석에 키 설명 추가** — 사람이 읽는 미러. 기계는 이 파일을
   보지 않지만, `validate_setting`을 고치고 여기를 안 고치면 문서가 드리프트된다.
4. **프런트에서 실제로 `settings_set`을 호출하도록 등록** — 단순 boolean/string 값은
   `src/stores/settings.ts`의 `PREFS` 배열에 `pref(camelKey, snake_key, coerce)` 항목 하나
   추가(simplePrefs 패턴, §2.3). 복잡한 값(배열/객체)은 해당 섹션 컴포넌트가 직접
   `call("settings_set", {entries: {...}})`를 부른다.

#### 2026-10-21 — `ai_provider_creds` (프로바이더별 키 보관함)

활성 프로바이더의 크리덴셜은 여전히 `ai_api_key`/`ai_endpoint` 한 벌이고 소비처(백엔드·`aiCreds()`)는 그것만
읽는다. 문제는 그 한 벌을 프로바이더와 함께 바꾸지 않던 것 — **프로바이더를 바꾸면 이전 프로바이더의 키가 새
프로바이더로 그대로 나갔다**(비우면 반대로 키를 잃는다). 그래서 비활성 프로바이더의 값을 맡아 두는 보관함을 뒀다.

- **모양**: `{ "<프로바이더 소문자>": { "api_key"?: string, "endpoint"?: string } }`, 기본값 `{}`. 이름은 알려진
  목록으로 묶지 않고 모양·크기만 검사한다(항목 16개, 이름 32자 `[a-z0-9_-]`, 값 4KB) — 옛/모르는 `ai_provider`
  값으로 보관할 때 배치 전체가 거부되지 않게.
- **비밀·앱 전역**: `is_secret_setting_key` 에 들어 번들·백업·원격 `settings_get_all` 응답에서 빠지고, 원격
  `settings_set` 도 막힌다(`remote_policy.rs`). `NOTEBOOK_KEYS` 아님 — AI 연결은 기기 전역이다(§2.4c).
- **쓰기 관문은 하나**: `src/lib/aiProviderSwitch.ts` 가 한 번의 `settings_set` 배치로 ① 나가는 프로바이더의
  지금 값(화면에서 편집 중인 값 우선)을 보관함에 넣고 ② `ai_provider` 를 바꾸고 ③ `ai_api_key`/`ai_endpoint` 를
  들어오는 프로바이더의 보관값(없으면 빈 값)으로 채운다. 설정 › AI 제공자와 온보딩 AI 단계가 이 함수를 쓴다 —
  **`ai_provider` 를 직접 쓰지 않는다**(보관함이 어긋난다).

#### 2026-10-19 — 브리핑 화면 구성 키 5종 은퇴 (키를 없애는 절차의 예)

브리핑 재작성(`docs/PLAN-2026-10-19-briefing-rewrite.md` §9.1, GRILL-2026-10-19 R2)으로 블록 격자 편집기와 함께
**`briefing_view` · `briefing_presets` · `briefing_layout` · `briefing_cards` · `briefing_options`** 다섯 키가 없어졌다.
`briefing_options.habit_range` 를 읽던 OS 알림 요약(`briefingSummary.ts`)은 `week_start` 를 직접 쓴다. 시간축 범위
옵션(`timeline_start_hour/end_hour`)은 상수가 됐다. **`briefing_last_seen` 은 남는다** — 창 바닥 줄 "새로 수집 N건 →"이
쓴다(R13). `briefing_window_open` 의 `edit` 인자(창 안 편집 모드)도 함께 없어졌다.

**키를 없앨 때는 §2.2 의 거꾸로**다. 순서는 Rust 다음 프런트:
1. `settings_schema.rs` 에서 기본값 행, `validate_setting` arm, 전용 검증 함수(`validate_briefing_view/presets/options`)와
   그 테스트를 지운다.
2. **`RETIRED_KEYS` 에 키를 한 줄씩 더한다.** 노트북·전체 번들 가져오기는 `validate_setting` 을 fail-closed 로 거친다
   (`transfer/import::insert_all`). 그래서 옛 번들에 실린 은퇴 키 하나가 replace 가져오기를 통째로 거부시킨다.
   이 목록에 있는 키는 가져오기가 조용히 건너뛴다. 살아 있는 키를 넣으면 가져오기가 그 값을 버리게 되므로,
   "목록의 키엔 쓰기 arm 이 없다"는 테스트가 지킨다.
3. `stores/settings.ts` 의 필드·세터·coerce 를 지운다. 이어서 `npm run check:settings` 로 프런트 키가 allowlist 에
   남았는지 본다.
4. **기존 DB 행은 지우지 않는다**: `get_all` 은 무검증이라 남은 행은 무해하다. 마이그레이션으로 지우지 않는다.

다섯 키는 전부 기기 전역이었다(`NOTEBOOK_KEYS` 아님). 같은 재작성에서 **`phrase_pack_id`(노트북 키)는 키가 그대로이고
설정 화면 위치만** 대시보드에서 브리핑으로 옮겼다(R4, §2.5 표).

#### 2026-09-19 — 달력 표시일(day marks, V87) — **설정 키가 아니다**

공휴일·기념일(내 기념일 + 불러온 캘린더)은 `settings`/`workspace_settings` 의 키·값이 아니라
**자기 테이블 셋**이다 — `calendar_sources`/`calendar_marks`/`calendar_mark_hides`
(`specs/db/schemas/calendar_marks.sql`, 커맨드 `specs/commands/calendar_marks.yaml`). 한 노트북에
수백 행이 쌓일 수 있는 목록형 데이터라 KV 한 줄에 담지 않는다 — `filter_roster`·`dashboard_tabs`
같은 배열형 설정 키와도 다르다(그것들은 사용자당 한 값, 이건 노트북당 여러 행). 그래도 §2.4c 의
"노트북별 완전 격리" 원칙은 그대로 적용된다: `workspace_id` FK + `ON DELETE CASCADE`, 노트북
내보내기/가져오기·복제에 함께 실린다. 읽기·전개·문서는 `docs/DASHBOARD.md` §3.3(공휴일·기념일),
경위는 `docs/PLAN-2026-09-19-calendar-schedule.md`.

#### 2026-09-20 라운드에서 추가된 키 — 에디터 3단 제안 + 붙여넣기·마크다운 자동 동작

오너 결정(설정 > 에디터에 날짜/지역 제안을 3단으로, 붙여넣기 자동 동작 3종과 마크다운 자동
서식을 각각 토글 가능하게). 이 라운드는 **키 등록·`stores/settings.ts` API 만** 만든다 — 실제
게이트(에디터 동작이 이 값을 읽어 행동을 바꾸는 지점)와 설정 화면 UI는 후속 두 웨이브가 얹는다.
설정 화면 UI 웨이브는 바로 아래 "2026-09-20(UI)" 절을 보라.

| 키 | 타입 | 기본값 | 왜 필요했나 |
| :-- | :-- | :-- | :-- |
| `date_nudge_enabled` | boolean | `true` | 날짜 넛지 3단 UI(off/suggest/auto)의 앞쪽 "enabled". 기존 `date_nudge_auto`(값 모양 불변) 앞에 서는 새 불리언 — enum으로 바꾸면 전역/노트북별 두 테이블 마이그레이션이 필요해 대신 이 키를 신설했다. 프런트 `dateNudgeEnabled`(simplePrefs) + `setDateNudgeMode` 콤보 setter |
| `region_nudge_enabled` | boolean | `true` | 지역 넛지 3단 UI(off/strict/loose)의 앞쪽 "enabled". 기존 `region_nudge_strict` 와 같은 관계. 프런트 `regionNudgeEnabled`(simplePrefs) + `setRegionNudgeMode` |
| `paste_link_nudge` | boolean | `true` | 에디터에 단독 URL을 붙여넣을 때의 후행 제안 행동 자체의 on/off. `link_suggestions`(그 뒤 AI 요약 옵트인, 기본 OFF)와는 별개 축. 프런트 `pasteLinkNudge` |
| `paste_path_inline_code` | boolean | `true` | 파일 경로 문자열을 붙여넣을 때 인라인 코드 서식으로 감쌀지. 프런트 `pastePathInlineCode` |
| `paste_table_sheet_suggest` | boolean | `true` | 표 모양 텍스트(TSV/CSV 등) 붙여넣기 시 시트 변환 제안. 프런트 `pasteTableSheetSuggest` |
| `editor_md_autoformat` | boolean | `true` | 타이핑 중 마크다운 문법을 즉시 리치 서식으로 바꾸는 자동 서식의 킬 스위치. 프런트 `editorMdAutoformat` |

여섯 다 `NOTEBOOK_KEYS`(노트북별, §2.4c) — 위 `date_nudge_auto`/`region_nudge_strict` 와 같은
성격("에디터가 저 혼자 도는 동작")이라 격리가 맞다. `settings_schema.rs` 의
`test_date_nudge_enabled_defaults_true_and_persists_through_repo_settings_round_trip` 등 6개
개별 왕복 테스트 + `new_editor_settings_keys_are_notebook_keys_and_land_in_workspace_settings`
가 봉인한다. 콤보 setter(`setDateNudgeMode`/`setRegionNudgeMode`)는 두 키를 **한 번의**
`settings_set` 호출로 같이 쓴다 — "off"로 갈 때는 뒤 키(`date_nudge_auto`/`region_nudge_strict`)
를 entries 에서 아예 빼 이전 선택을 보존한다(`settings.test.ts` 가 세 모드 전부·롤백을 봉인).

#### 2026-09-20(UI) — 에디터 3단 제안·붙여넣기·입력 확장 (설정 화면)

위 표의 여섯 키가 **설정 > 에디터**에 실제로 노출됐다. 카드가 셋에서 넷으로 늘었다
(`EditorSection.tsx`, `EditorSection.test.tsx`):

1. **자동 제안** — 날짜·지역 제안 행이 토글 2개에서 **3단 세그먼트**(`SegGroup`, 끄기/제안만/
   자동 등록 · 끄기/엄격/느슨)로 바뀌었다. 표시값은 `dateNudgeModeOf`/`regionNudgeModeOf`(순수
   함수, `stores/settings.ts`)가 `enabled`+`auto`(또는 `strict`) 두 불리언에서 계산하고, 고르면
   `setDateNudgeMode`/`setRegionNudgeMode` 콤보 setter가 한 번에 되돌린다. 예전 토글은
   "넛지가 얼마나 엄격한가"만 고를 수 있었지 "넛지 자체를 끌" 자리가 없었다 — 이번 확장이 그
   자리(`date_nudge_enabled`/`region_nudge_enabled`)를 만들었다. 행 힌트는 세 옵션을 한 번에
   설명하고, 끈 상태에서도 에디터의 `/날짜`·`/지역` 슬래시 명령으로 직접 등록하는 것은 그대로
   된다고 명시한다.
2. **붙여넣기·드롭** — 기존 `source_original_policy` 행 아래 토글 3개 신설:
   `paste_link_nudge`(단독 URL → 본문 가져오기 제안, AI 요약행 `link_suggestions`와는 별개 축이라
   행 힌트가 그 차이를 언급) · `paste_path_inline_code`(단독 경로 → 인라인 코드) ·
   `paste_table_sheet_suggest`(표 모양 텍스트 → 시트 변환 제안).
3. **입력**(신설 카드, `editor_md_autoformat` 하나뿐) — 표시 카드에 얹지 않고 붙여넣기·드롭
   바로 다음에 별도 카드로 세웠다: 표시의 두 토글은 에디터가 "어떻게 보이는지"를 바꾸고, 이
   토글은 "타이핑 중 무슨 일이 일어나는지"를 바꾸는 축이라 붙여넣기·드롭과 성격이 더 가깝다.
   행 힌트는 단축키·툴바 버튼·마크다운 붙여넣기는 이 설정과 무관하게 항상 적용된다고 명시한다.
4. **표시** — 내용 불변, 순서만 한 칸 밀림(전체 너비·맞춤법 검사).

옛 토글 testid(`settings-date-nudge-auto-toggle`/`settings-region-nudge-strict-toggle`)는
토글 자체가 없어지며 함께 사라졌다. 행 testid도 `settings-date-nudge-auto`/
`settings-region-nudge-strict` → `settings-date-nudge-mode`/`settings-region-nudge-mode`로
바뀌었다 — "auto"/"strict"라는 이름이 이제 세 값 중 하나일 뿐이라 행 전체를 대표하기엔
misleading해서다. i18n: 옛 `date_nudge_auto_label`/`_hint`·`region_nudge_strict`/`_hint`
네 키는 세 모드 전부를 표현할 수 없어 세 locale에서 삭제하고, `date_nudge_mode_*`·
`region_nudge_mode_*`·`paste_*_label`/`_hint`·`editor_md_autoformat_*`·`editor_input_group`
19키로 대체했다(`scripts/i18n-keys-snapshot.json` 갱신은 오너/오케스트레이터가 일괄로 한다 —
공유 파일이라 이 웨이브에서 직접 손대지 않았다).

#### 2026-09-20 — 실험적 에디터 설정 4종 (같은 날 세 번째 웨이브)

오너 결정("4~7번도 넣어봐, 보고 이상하면 지울게") — 오너가 앱에서 직접 보고 별로면 뺄 수 있다는
전제로 넣은 **실험적** 키 4종. 위 여섯 키(§ "2026-09-20 라운드")와 달리 "오늘까지의 동작을
지키는 킬스위치"가 아니라 새 동작/값이지만, 절차는 같다(§2.2 4곳). 각각 **키 하나·스토어 필드
하나·UI 행 하나·행동 게이트 하나**로 자기완결시켰다 — 빼려면 그 한 줄씩만 지우면 된다(이 웨이브는
행동 게이트는 얹지 않았다, 값만 왕복한다 — 다른 에이전트가 이어받는다).

| 키 | 타입 | 기본값 | 왜 필요했나 |
| :-- | :-- | :-- | :-- |
| `link_open_on_click` | boolean | `false` | 링크를 일반 클릭으로 열지, 지금처럼 Ctrl/Cmd+클릭에서만 열지. 기본 false = 오늘까지의 동작(Ctrl/Cmd+클릭만) 유지. 프런트 `linkOpenOnClick`(simplePrefs) |
| `editor_word_count` | boolean | `true` | 에디터 상태줄의 글자 수·단어 수 표시. **기본 true** — 그 표시는 이 키 이전부터 늘 보이던 것이라 이 키는 옵트인이 아니라 "끌 수 있게" 하는 스위치다(false 기본이면 키를 만든 것만으로 기존 화면에서 사라진다). 세는 방식도 같이 고쳤다(그레이프임·언어별 단어 경계·문단 경계·선택 영역, 디바운스 — `WordCountBar`). 프런트 `editorWordCount`(simplePrefs) |
| `editor_width` | `'narrow'`\|`'normal'`\|`'wide'` | `'normal'` | 본문 최대 폭. `normal` = 오늘까지의 800px 상한. `editor_full_width`가 켜져 있으면(전체 너비) 이 값은 쓰이지 않는다 — 설정 화면(`EditorSection.tsx`)이 그 상태의 행을 잠근다(`SegGroup` 옵션별 `disabled` + `SettingsRow`의 `disabled`/`disabledReason`, 둘 다 기존 기능이라 새로 만들지 않았다). 프런트 `editorWidth`(simplePrefs, export type `EditorWidth`) |
| `new_note_date_precision` | `'day'`\|`'month'`\|`'year'` | `'day'` | 새 노트가 받는 오늘 날짜의 정밀도. `day` = 오늘까지의 동작. 노트별로 언제든 바꿀 수 있으므로 이 값은 "새로 만들 때의 시작값"만 정한다. 프런트 `newNoteDatePrecision`(simplePrefs, export type `NewNoteDatePrecision`) |
| `new_note_section_name` | string, trim 40자 이하(문자 수)·줄바꿈 금지 | `""` | 새 노트의 첫 섹션 이름. 빈 문자열 = 백엔드 내장 기본 이름(`repo/notes/mod.rs`의 `"Overview"` 리터럴 — 이 웨이브는 그 파일을 건드리지 않는다, 노트 생성 경로는 병행 작업 중인 다른 에이전트 소관이라 grep 으로 참조만 했다). 프런트 `newNoteSectionName`(simplePrefs) — setter가 저장 전 trim + 40자 클램프 |

다섯 다 `NOTEBOOK_KEYS`(노트북별, §2.4c) — 위 여섯 키와 같은 "에디터가 저 혼자 도는 동작" 부류.
`settings_schema.rs`의 `test_link_open_on_click_defaults_false_and_persists_through_repo_settings_round_trip`
등 개별 왕복 테스트(불리언 둘은 round-trip, 나머지 셋은 `_validate_and_roundtrip` — enum 값·
무효값·섹션 이름의 41자/줄바꿈 거부까지) +
`new_experimental_editor_settings_keys_are_notebook_keys_and_land_in_workspace_settings`가
봉인한다. `db/migrations.rs`의 인계철선 테스트(`v86_key_list_is_a_subset_of_notebook_keys_and_every_later_key_is_accounted_for`)
의 `KEYS_ADDED_AFTER_V86`에도 다섯 다 등록했다 — 새로 생긴 키라 옮길 전역 값이 없다.

**설정 화면**(`EditorSection.tsx`, `EditorSection.test.tsx`) — 카드가 넷에서 **다섯**으로 늘었다:

1. **입력** — 기존 `editor_md_autoformat` 아래 `link_open_on_click` 2단 세그먼트(Ctrl+클릭/클릭)
   추가. 클릭으로 두면 일반 클릭이 바로 링크를 열므로 링크 안에 캐럿을 두려면 방향키가 필요하다는
   것과, 노트 링크(`[[…]]`)는 이 설정과 무관하다는 것을 행 힌트가 명시한다.
2. **새 노트**(신설, 입력과 표시 사이) — `new_note_date_precision` 3단 세그먼트(연·월·일/연·월/
   연도만) · `new_note_section_name` 텍스트 입력(로컬 draft state, blur/Enter 커밋 — 매 키
   입력마다는 저장하지 않는다, `maxLength=40`, placeholder는 백엔드 내장 기본 이름 리터럴
   `"Overview"` 그대로, 비어있지 않을 때만 × 버튼이 나타나 즉시 비우고 커밋).
3. **표시** — 순서가 전체 너비 → **본문 폭**(신설, 3단 세그먼트 좁게/보통/넓게) → **글자 수
   표시**(신설, 토글) → 맞춤법 검사로 바뀌었다. 본문 폭 행은 전체 너비가 켜져 있으면 잠긴다.

i18n: 21키 추가(`link_open_on_click_*`·`editor_width_*`·`editor_word_count_*`·
`new_note_date_precision_*`·`new_note_section_name_*`·`editor_new_note_group`), 세 locale
동시 추가(`npm run check`의 i18n 파리티 게이트). `scripts/i18n-keys-snapshot.json`은 삭제된 키가
없으므로(이 웨이브는 키를 더하기만 했다) 건드리지 않았다.

#### 2026-09-12 — 본문 틴트 (PLAN-2026-09-12 §5 / D6)

| 키 | 타입 | 기본값 | 왜 필요했나 |
| :-- | :-- | :-- | :-- |
| `content_tint` | integer(-30..=40) | `0` | 본문 캔버스(`.content-canvas`) 틴트의 **부호 있는 오프셋**. 전역 밝기 슬라이더(`bg_dim`/`bg_tone`)는 사이드바까지 함께 움직이므로, 본문만 따로 밝히거나 어둡게 할 축이 없었다. 설정 > 테마. 프런트 `contentTint`(simplePrefs) |

**절대값이 아니라 오프셋이다** — 이 키만 읽어서는 화면 틴트를 알 수 없다:

```
실효 틴트 = 테마 기준값(다크 16 / 라이트 7) + content_tint
```

기준값은 `src/styles/tokens.css` 의 `--content-tint-amount` 기본값이고, 프런트 상수
`src/lib/appearance.ts::CONTENT_TINT_BASE` 가 같은 숫자를 들고 있다(둘이 갈리면 오프셋 0 이
"오늘 화면과 픽셀 동일"이 아니게 된다). 범위 `-30..=40` 도 `appearance.ts` 의
`CONTENT_TINT_MIN`/`MAX` 와 **같은 숫자여야** 한다 — 갈리면 프런트가 저장을 시도했다가
백엔드가 조용히 거절한다(함정 3).

**부호가 틴트 색을 뒤집는다.** 실효값이 음수면 틴트가 검정(`#000`)에서 흰색(`#fff`)으로
바뀌고, 그만큼 **본문이 사이드바보다 밝아진다**. 예: 다크 테마에서 `content_tint = -30` →
16 + (-30) = -14 → 흰색 14%. 부호가 필요했던 이유(2026-09-12 오너 QA): 틴트가 검정 한 색이면
본문은 사이드바보다 밝아질 수 *없고*, 검정을 0% 까지 줄여야 겨우 같아지는 것이 상한이었다.

CSS 는 색과 세기를 **두 변수로 가른다** — `--content-tint-color`(`#000`/`#fff`) ·
`--content-tint-amount`(항상 양수 퍼센트). 부호는 색이 표현한다. 둘 다 `applyCssVars` 가
setProperty 하고, **세기에서 `%` 를 빼먹으면 `color-mix` 가 통째로 무효가 되어 본문 배경이
조용히 사라진다.** 노트북 스위처 칩은 이 슬라이더를 따라가지 않도록 `--notebook-chip-tint` 로
떼어냈다(사이드바에 있는 칩이 본문 밝기를 따라가면 거짓말이 된다).

기본값 `0` 은 **오늘 화면과 픽셀 동일**이다 — 라이트 기준 7%(어두운 쪽)는 2026-09-09 오너가
직접 10%→16% / 4%→7% 로 올려 정한 값이라, 밝은 쪽으로 옮기는 것은 사용자가 슬라이더로 고를
일이지 기본값을 말없이 뒤집을 일이 아니다.

`settings_schema.rs::test_content_tint_validate_and_roundtrip` 이 범위(±경계)와 DB 왕복을
봉인하고, `AppearanceSection.test.tsx` 가 음수에서 색이 뒤집히는 것과 `%` 접미를 단언한다.

#### 2026-09-08 — 달력 공휴일 지역

| 키 | 타입 | 기본값 | 왜 필요했나 |
| :-- | :-- | :-- | :-- |
| `holiday_region` | `'none'`\|`'kr'` | `'none'` | 대시보드 달력(월간·연간)에 공휴일을 칠할 지역. 설정 > 달력 및 일정 > 달력(2026-09-19 이전엔 보기·지역 페이지). 날짜 표는 프런트 `src/lib/holidays.ts` 정적 표(2024~2030)라 백엔드는 값만 보관한다. 프런트 `holidayRegion`(simplePrefs). `docs/DASHBOARD.md` §3.3 |

`settings_schema.rs::test_validate_setting_holiday_region` 이 allowlist 를 봉인한다.

**2026-09-19 이관**: `holiday_region` 과 `week_start` 는 `PLAN-2026-09-19-notebook-settings.md` 로
**노트북별 키**(`NOTEBOOK_KEYS`, §2.4c)가 됐다 — 노트북을 바꾸면 공휴일 지역·주 시작일도 바뀐다. 이 표의
"기본값"은 이제 **새 노트북의** 기본값이라는 뜻이다(기존 노트북은 V86 마이그레이션이 그때의 전역 값을
각자에게 복사했다).

#### 2026-09-05 라운드에서 추가된 키 (PLAN-2026-09-05-ai-guardrails)

| 키 | 타입 | 기본값 | 왜 필요했나 |
| :-- | :-- | :-- | :-- |
| `ai_confirm_before_apply` | boolean | `true` | 어시스트 AI 결과를 노트에 삽입/교체하기 전 `AiResultModal`에서 사람이 [삽입]을 누르게 하는 게이트. 끄면 현행처럼 즉시 삽입(반복 작업 사용자용). 프런트 `aiConfirmBeforeApply` |
| `ai_debug_verbose` | boolean | `false` | AI 호출 로그(`ai-calls.jsonl`)에 프롬프트/응답 앞 2000자를 동봉. 켜면 노트 내용이 로그 파일에 남으므로 디버그 때만. `settings_set`이 저장 직후 `call_log::set_verbose`로 즉시 반영(재시작 불필요). 프런트 `aiDebugVerbose` |

둘 다 `settings_schema.rs`의 `test_ai_guardrail_toggles_round_trip_through_settings_set`이 시드·검증·DB 왕복을 봉인한다.

#### 2026-09-04 라운드에서 추가된 키 (PLAN-2026-09-04-local-import §3b)

| 키 | 타입 | 기본값 | 왜 필요했나 |
| :-- | :-- | :-- | :-- |
| `collect_detect_pending` | integer(0..=99) | 시드 안 함(부재=0) | 첫 부팅 자동 감지(`lib/collectDetectOnce.ts`)가 찾은, 아직 소스로 등록되지 않은 로컬 후보 개수. 설정 > 수집 레일 항목의 뱃지 숫자(`SettingsPanel.tsx`) |
| `collect_detect_seen` | boolean | 시드 안 함(부재=false) | 수집 페이지를 한 번이라도 열었는지. true가 되면 App.tsx 부팅 이펙트가 다시는 `collect_detect_local`을 무음 호출하지 않는다 |

둘 다 시드하지 않는 키다(부재가 정상 상태 — §2.4의 "기기 로컬" 부류와 같은 이유는 아니지만 같은
모양: `collectPausedUntil`처럼 "키 없음 = 아직 아무 일도 없었음"). `settings_schema.rs`의
`test_collect_detect_pending_and_seen_round_trip`이 검증·DB 왕복을 봉인한다.

#### 2026-09-01 라운드에서 추가된 키

| 키 | 타입 | 기본값 | 왜 필요했나 |
| :-- | :-- | :-- | :-- |
| `collect_chat_register` | boolean | `false` | 챗이 수집 소스를 등록하는 경로의 킬스위치. 사용자가 문장 하나로 부르면 이후 자동으로 도는 구조라 `ai_chat_memory` 와 같은 계열로 보고 옵트인 |
| `status_add_locked` | boolean | `false` | 진행 상태 "추가" 진입점 잠금. 내장 3종은 코드 상수(`lib/status.ts`), 커스텀은 워크스페이스 테이블이라 기존 필드로는 "추가 금지"를 표현할 자리가 없었다 |

**i18n 게이트 주의**: `scripts/check-i18n.mjs`는 파리티·삭제 감지에 더해 **미사용 키도 거부한다**.
후속 웨이브용으로 문구를 미리 심어둘 수 없다 — 문구는 그것을 실제로 쓰는 변경과 같은 커밋에 들어간다.

#### 2026-08-30 라운드에서 추가된 키 (참고 예시)

`docs/PLAN-2026-08-30-ai-surface-and-clients.md` 가 이 절차를 정확히 두 번 밟았다:

| 키 | 타입 | 기본값 | 왜 필요했나 |
| :-- | :-- | :-- | :-- |
| `ai_chat_memory` | boolean | `true` | 사이드바 챗 대화에서 사실을 뽑아 저장하는 동작. 사용자가 부르지 않아도 도는 **자동** 기능이라 진짜 킬스위치가 필요했다(`lib/chatMemoryExtractor.ts` 가 게이트를 읽는다) |
| `seen_feature_briefs` | string[] | `[]` | 기능을 처음 켤 때 뜨는 브리핑을 다시 안 띄우기 위한 누적 목록. **소급 방지 sentinel 도 이 배열 안에 넣어** 별도 키를 만들지 않았다 |

그 라운드가 새 키를 **둘로 막은** 방법도 같이 기록해 둔다: 온디맨드 AI 액션 14종에 각각
킬스위치를 다는 대신 기존 `ai_action_presets[].hidden`(메뉴 노출)을 재사용했다. 새 설정 키는
`validate_setting` arm · 기본값 · 스펙 주석 · 프런트 등록 4곳을 늘리므로, **기존 필드로 같은
뜻을 표현할 수 있으면 그쪽이 먼저다.**

**정적 게이트**: `scripts/check-settings-keys.mjs`(`npm run check`의 일부)가 `src/`를 스캔해
프런트가 `settings_set`으로 쓰는 모든 키가 백엔드 `validate_setting`의 허용 목록에 있는지
대조한다. `entries: {...}` 리터럴의 중첩 객체(예: `default_map_location: {lat, lng}`)는 depth를
세어 최상위 키만 뽑고, `PREFS`의 `pref(camel, "snake_key", ...)` 튜플도 별도로 파싱해 합류시킨다
(simplePrefs 경유 키가 리터럴 스캔의 사각지대였던 과거 누락을 메운 것). 계산된 키(`[foo]:`)는
같은 파일의 `const FOO = "bar"` 상수로 풀리는 경우만 검증하고, 나머지는 "정적 검증 불가"로
보고만 한다(실패 처리는 안 함).

이 함정은 실제로 최소 세 번 이상 났다: `sidebar_collapsed`(에러 토스트), `favorites_open`(무음
실패), `editor_full_width`/`link_suggestions`/`ai_model_fallback`/알림 3키 등 — 각각의 회귀는
`settings_schema.rs` 테스트에 "실제 DB 왕복(`set` → `get_all`)까지 확인" 형태로 봉인돼 있다
(`validate_setting` 단위 테스트만으로는 안 잡힘 — 커맨드 계층이 살아있는지까지 봐야 잡힌다).

### 2.3 프런트 simplePrefs 패턴

`src/stores/settings.ts`는 "값 하나, DB 키 하나, coerce 함수 하나"로 끝나는 단순 설정을
`PREFS` 배열로 선언한다:

```ts
pref("chatWriteEnabled", "chat_write_enabled", boolDefaultTrue),
```

- `camel`: 스토어 상태 필드명(예: `chatWriteEnabled`).
- `snake`: DB 키(예: `chat_write_enabled`).
- `coerce`: `settings_get_all` 응답의 raw JSON 값을 안전한 타입/기본값으로 정규화하는 함수.

`load()`가 부팅 시(또는 설정 창에서 값이 바뀔 때마다, `lib/settingsChanged.ts` 경유) 이
배열을 순회해 `simplePrefs` 객체를 조립하고 스토어 상태에 반영한다. 쓰기는 공유 헬퍼
`setSimplePref(camel, value)`가 낙관적 `set()` 직후 `call("settings_set", {entries:
{[PREF_SNAKE[camel]]: value}})`로 영속한다 — 새 단순 프리퍼런스를 추가할 때 setter 함수를
매번 새로 쓸 필요가 없다.

**최근 추가된 일회성 마이그레이션 예시**: `chat_write_enabled`는 예전에 `localStorage`
키(`brise.chatWriteEnabled`, 삭제된 `stores/chatWrite.ts`가 쓰던 "0"/"1" 문자열)에 있었다.
`load()`가 이 레거시 키를 발견하면 값을 읽어 `simplePrefs.chatWriteEnabled`에 즉시 반영하고
`localStorage.removeItem`으로 지운 뒤, `set()` 이후 별도로 `settings_set`을 호출해 DB에도
써넣는다 — 키를 지우므로 다음 `load()`부터는 이 분기를 안 탄다(별도 "이미 마이그레이션함"
플래그가 필요 없는 자기소멸형 마이그레이션).

### 2.4 기기 로컬 키 (export 제외)

일부 키는 "이 기기에만 의미 있는 상태"라 내보내기(export)/백업 번들에서 제외된다
(`src-tauri/src/repo/transfer/export.rs::is_device_local_setting_key`):

- `device_id`
- `sync_enabled` / `sync_port` / `sync_token` — 이 기기의 동기화(beta) 서버 설정이 다른 기기로
  따라가면 안 된다.
- `search_recent` / `recent_closed_tabs` — 세션 편의 상태, 콘텐츠에 인접하지만 "기억"이 아니다.
- `capture_clip_enabled` / `capture_ingest_port` / `capture_ingest_token` — 캡처 ingest
  loopback 리스너, sync_* 3종과 동일한 이유로 기기 로컬.
- `capture_screenshot_dir` — 이 기기 파일시스템 경로.

`is_secret_setting_key`(같은 파일, 별도 함수)는 비밀값(`ai_api_key` · `ai_provider_creds` ·
`sync_token` · `capture_ingest_token`)을 마찬가지로 export에서 제외한다 — 두 필터가 함께
적용된다(`dump()`가 체인).

### 2.4b 모양(테마) 키 — 초기화·내보내기·불러오기

모양 키 10개(`theme` · `accent` · `font_family` · `font_scale` · `bg_dim` · `bg_tone` · `bg_sat` ·
`content_tint` · `surface_style` · `sheet_alpha`)는 `settings_schema.rs::APPEARANCE_KEYS` 가 SSOT 다.
**테마 페이지(id `appearance`)에 새 손잡이를 달면 이 목록과 `stores/settings.ts::appearanceEntries` 에 같이 넣는다**
(`settings.test.ts` 가 두 목록을 대조한다 — 빠뜨리면 초기화·되돌리기가 그 키만 놓친다).

- 파일 형식 `{ "kind": "brise-theme", "version": 1, "settings": {…} }` — 모르는 키는 건너뛰고,
  아는 키의 값이 틀리면 파일 전체 거부. 전체 내보내기 번들에서도 모양 키만 뽑아 읽는다.
- Rust(`repo/theme.rs`, `theme_read`/`theme_export`/`theme_defaults`)는 **쓰지 않는다**. 쓰기는
  `applyAppearance` 가 `settings_set` 한 번으로 하고, OS 효과도 한 번만 건다(setter 를 차례로
  부르면 아크릴 재적용이 겹쳐 깜빡인다).
- **아크릴 가드**: `commands/window.rs::acrylic_supported()`(Windows 빌드 22523+). 미지원 기기에선
  ⓐ `apply_style` 이 걸지 않고 false ⓑ 테마 페이지의 아크릴 칸이 잠기고 ⓒ 불러온 파일의 acrylic 은
  flat 으로 저장된다. 22523 미만의 `apply_acrylic` 은 끌리는 SWCA 경로로 **성공을 보고**했기 때문이다.

상세·결정 경위: `docs/PLAN-2026-09-19-theme-presets.md`.

### 2.4c 노트북별 설정 — 새 키를 만들면 어느 쪽인지부터 정한다

**2026-09-19 오너 결정: 노트북마다 완전히 격리된 경험.** 모양·언어·달력·편집 방식·AI 사용
여부는 노트북을 바꾸면 따라 바뀌고, 노트북 내보내기/가져오기에 함께 실린다. 새 노트북은 기본값으로
시작한다(만들 때 "현재 노트북의 설정 복사"를 고를 수 있다).

- **SSOT**: `settings_schema.rs::NOTEBOOK_KEYS`(46개, 2026-09-20 에디터 6키 추가로 35→41, 같은 날
  후속 웨이브의 실험적 4종으로 41→46). 값은 `workspace_settings(workspace_id, key,
  value)`(V86)에 산다. 이 목록에 없는 키는 앱·기기 전역이다(비밀·기기 식별·AI 연결·알림·백업·
  펫·수집·창 배치).
- **읽기·쓰기 관문은 그대로 하나씩**: `repo::settings::get_all` 이 기본값 → 전역 → 활성 노트북 순서로
  덮고(노트북 키의 전역 행은 **무시**한다), `set` 이 노트북 키를 활성 노트북 행으로 보낸다. 그래서
  프런트 스토어와 Rust 소비처는 이 구분을 모른다 — **소비처에 분기를 넣지 않는다.**
- **새 키 절차(§2.2)에 한 단계 추가**: 노트북을 따라가야 하면 `NOTEBOOK_KEYS` 에 넣는다. 기본 방향은
  노트북. ⚠️ **이미 있는 키를 목록에 더할 때**는 그 키의 기존 전역 값이 노트북으로 넘어가지 않는다 —
  새 마이그레이션이 필요하다(`v86_key_list_matches_notebook_keys` 테스트가 깨지며 알려 준다).
- **불변식 테스트**: 노트북 키엔 비밀·기기 전용 키가 없다(노트북 번들로 새어 나가지 않게), 모든 노트북
  키엔 유효한 기본값이 있다.
- **전환**: `workspaces.switchTo` → `settings_set({active_workspace_id})` → `reloadAppearance()`(다시
  읽고 OS 창 효과를 한 번 건다). 다른 창은 `settings-changed` 로 따라온다. 언어는 App 의
  `key={uiLang}` 이 다시 마운트한다.
- **표시(2026-09-20 개정)**: 노트북 이름은 설정 레일 제목("설정") 바로 아래 한 곳에서만 보여준다
  (`SettingsNav`) — 페이지마다 "노트북: ○○" 를 반복하던 옛 칩은 없앴다. 대신
  `SettingsPageHeader notebookScoped`(SSOT `NOTEBOOK_KEYS`)는 뜻이 뒤집혀, **false(기본값)일
  때만** 중립색 "앱 전체" 칩(`settings-app-scope`)이 페이지 머리에 선다 — 수집·동기화·
  라이선스·펫·AI 프리셋처럼 **노트북별 키가 하나도 없는** 페이지용 표시다. 앱 전체 설정이 대부분이어도
  노트북별 키를 품은 페이지(AI 제공자·AI 기능·데이터·대시보드·브리핑)는 `notebookScoped` 를 받아 칩 없이 둔다
  — 칩은 페이지 단위 주장이라 섞인 페이지에선 거짓이 된다.
- **번들**: `Bundle.workspace_settings`·`Bundle.timeline_routines`(반복 일정 — 예전엔 어느 번들에도
  없었다). V86 이전 번들은 전역 `settings` 에 실린 노트북 키로 노트북을 채운다
  (`import::insert_notebook_settings`).

상세·결정 경위: `docs/PLAN-2026-09-19-notebook-settings.md`.

### 2.5 설정 창 구성

`src/components/settings/` 아래 섹션별 컴포넌트가 있다. 레일의 페이지 목록·순서·그룹은
`SettingsPanel.tsx` 의 `allPages` 가, 그룹 라벨 키는 `SettingsNav.tsx` 의 `GROUP_LABEL_KEY` 가 SSOT다.
모든 항목이 그룹에 속한다(고아 없음) — **5그룹 17페이지**. 버전·업데이트는 페이지가 아니라 **레일
하단 상주 블록**(`SettingsNavFooter.tsx`)이다.

```
일반        일반 · 에디터 · 달력 및 일정 · 테마 · 지역 및 날씨 · 대시보드
기능        수집 · 동기화
AI          AI 제공자 · 권한 · 기능 · AI 프리셋 · 채팅
시스템      데이터 관리 · 라이선스
플러그인    펫 · 브리핑
```

**페이지 id 는 라벨과 따로 간다** — 딥링크와 `AiCapabilityCatalog` 의 `link` 대상이라 라벨이 바뀌어도
id 는 그대로다: `notifications`→"달력 및 일정", `appearance`→"테마", `view`→"지역 및 날씨", `connect`→"동기화",
`ai`→"AI 제공자", `ai_features`→"기능", `data`→"데이터 관리". 나머지 id 는 `general`·`editor`·`dashboard`·
`collect`·`ai_permissions`·`ai_presets`·`ai_chat`·`license`·`pet`·`briefing`.

**딥링크**: `settings_window_open { page? }` 가 페이지를 받는다. 새 창은
`index.html?page=<id>#/settings`(쿼리는 해시 **앞** — `main.tsx` 가 `#/settings` 정확 일치로 라우팅)로 열고
`SettingsPanel` 이 첫 렌더에 읽는다. 이미 열린 창에는 `settings-navigate` 이벤트를 보낸다. id 는
`[a-z0-9_]` 만 통과(`settings_window::valid_page`), 모르는 id 는 첫 페이지로 떨어진다. 쓰는 곳: AI 결과 창의
오류 버튼 → `ai`, 첫 안내("설정 → AI → 권한") → `ai_permissions`, AI 꺼짐 사전 차단(`aiResultGate`) → `ai`.

**AI 마스터 스위치(`ai_enabled`, 노트북 키)가 그려지는 곳은 정확히 하나다**(PLAN-2026-10-24 D7) — AI 제공자(`ai`)
페이지 첫 줄 카드(`settings-ai-master-card`, 접히는 본문 밖이라 꺼져도 보인다). 켜면 `ensureAiReachable` 과
`ai_master` 기능 브리핑이 뒤따른다. 나머지 AI 페이지(권한·기능·AI 프리셋·채팅)는 꺼져 있을 때 그 페이지로 가는
링크 한 줄(`AiOffLink.tsx`, 켜기 버튼 없음)만 둔다. 예전의 일반 페이지 토글과 `AiOffBanner` 는 없다.

| 섹션 | 파일 | 다루는 것 |
|---|---|---|
| 일반 | `GeneralSection.tsx` | 제품·업데이트 카드 · 카드 밖 통계 띠(노트 날짜·노트·첨부 타일) · **앱 동작** 카드: 언어 · 2열 `SwitchGrid`(자동 실행 · 트레이 상주 · **화면 저장**(`capture_screenshot_enabled`, 펫 페이지 아님 — `docs/PET.md` §0.4)) — 브라우저(태블릿)에선 격자가 통째로 빠진다 · 화면 저장이 켜졌을 때만 **화면 저장 폴더**(`capture_screenshot_dir`, 빈 값 = `<사진>/Brise`, 원격 차단) · 온보딩 다시 시작(글자 버튼). 저장 공간 게이지와 **저장 및 백업** 카드는 "데이터 관리"로, AI 마스터는 "AI 제공자"로 갔다(PLAN-2026-10-24 D6·D7). 알림은 "달력 및 일정", 날짜·지역 제안과 원본 처리는 "에디터"에 있다 |
| 에디터 | `EditorSection.tsx` | 카드 다섯. **자동 제안**(날짜·지역 제안 3단 `SegGroup` — `date_nudge_enabled`+`date_nudge_auto` / `region_nudge_enabled`+`region_nudge_strict` 두 불리언 쌍을 `dateNudgeModeOf`/`regionNudgeModeOf` 로 접는다) · **붙여넣기·드롭**(`source_original_policy` + 토글 3종 `paste_link_nudge`·`paste_path_inline_code`·`paste_table_sheet_suggest`) · **입력**(`editor_md_autoformat` + **실험적** `link_open_on_click`) · **새 노트**(**실험적** `new_note_date_precision` · `new_note_section_name`, blur/Enter 커밋·40자 클램프) · **표시**(`editor_full_width` → **실험적** `editor_width`(전체 너비 켜지면 잠김) → **실험적** `editor_word_count` → `spellcheck_enabled`). 전부 노트북별(`NOTEBOOK_KEYS`) — 실험적 4종은 §2.2 "2026-09-20 — 실험적 에디터 설정 4종" |
| 달력 및 일정 | `NotificationsSection.tsx` | 페이지 id `notifications`(딥링크 호환). 위에서 아래로 **달력 카드**(`week_start`·`holiday_region`, 노트북별 — §2.4c) · **공휴일·기념일 표**(`DayMarksSection.tsx`, `calendar_marks`/`calendar_sources` — 내 기념일 편집·삭제, 기본/불러온 것은 숨기기·내 목록으로 복사, ics 파일·URL 불러오기. 브라우저에선 읽기 전용) · **반복 일정 표**(`TimelineRoutineSection.tsx`, 브라우저에선 숨김) · **알림 카드**(`notifications_enabled`·`reminder_all_day_at`, 앱·기기 전역). 라벨 변천은 `docs/PLAN-2026-09-19-calendar-schedule.md` §0 |
| 테마 | `AppearanceSection.tsx` | 페이지 id `appearance`. 머리 버튼 **불러오기·내보내기·초기화(+되돌리기)**(§2.4b) · 테마 카드(테마 · 표면 스타일(+시트 불투명도, 아크릴 미지원 기기에선 잠김) · **강조색** SubGroup(hue 슬라이더 1칩 + 채도 5칩 + 초기화, `lib/accentPalette.ts`)) · 글꼴 카드(글꼴(+직접 입력) · 글자 크기 · 배경 밝기 · 배경 채도 · **본문 틴트**(`content_tint`)) |
| 지역 및 날씨 | `ViewSection.tsx` | 페이지 id `view`. 히어로 마스터 토글(`region_enabled`) + 카드 밖 3:7 스트립(좌 날짜·시계·시간대 / 우 지역 이름 + 7일 예보 — `WeatherSection.tsx`) + 지역 카드(`MapSection.tsx`, `default_map_location`) + "달력은 달력 및 일정에서" 한 줄. 꺼짐 판정은 `useWeatherLocation` 한 지점 — 꺼지면 스트립 자리에 "꺼짐" 한 줄, 지도는 계속 쓴다. 시간대를 모르면 이 PC 시각을 현지 시간인 척하지 않는다 |
| 대시보드 | `DashboardTabsSection.tsx` | 미리보기(`DashboardMiniPreview.tsx`) + `dashboard_tabs` 순서/on-off(`ReorderList.tsx` — 드래그·키보드 순서, 적어도 하나는 켜져 있어야 함) + 칸반 SubGroup **상태 추가 잠금**(`status_add_locked`). 문구 팩은 브리핑 페이지에 있다 |
| 수집 | `CollectSection.tsx` | 머리 토글 + `collect_sources` CRUD(`docs/COLLECT.md`) — 한 행이 주기·주소·정리 위치·AI 정리·활성화 5축을 말한다. 자연어 빠른 등록 대신 `collect_chat_register`(챗 경유 등록 허용). 맨 아래 **제외 도메인**(`ExcludedDomainsSection.tsx`, `collect_excluded_domains` — 상한을 넘는 줄은 저장하지 않고 알린다) |
| 동기화 | `SyncSection.tsx` | 페이지 id `connect`. `sync_enabled`/`sync_port`/`sync_token`(beta) — 접속 URL·QR(폰·태블릿 연결), 토큰 재생성(연결된 기기 전부 끊김 확인), 포트는 껐다 켜야 적용, Tailscale 안내. 앱 전체 칩 |
| AI 제공자 | `AiProviderSection.tsx` | 페이지 id `ai`. 프로바이더/키/엔드포인트/모델/폴백 모델. **프로바이더 전환은 `lib/aiProviderSwitch.ts` 를 지나 키가 프로바이더별로 보관된다**(§2.2 "2026-10-21 — `ai_provider_creds`"). 첫 줄이 **AI 마스터 스위치**(`ai_enabled`) 카드이고, AI 가 꺼져 있으면 그 아래 본문이 접힌다 |
| AI 권한 | `AiPermissionsSection.tsx` | 권한 **6종 전부 한 페이지** — 카드 하나 안의 SubGroup 셋(읽기 2 / 쓰기 2 / 안전장치 2) 각각 `SwitchGrid` + 외부 전송 요약. 마스터는 여기 없다(위 문단) |
| AI 기능 | `AiCapabilityCatalog.tsx` · `AiActionsCard.tsx` | 손질/정돈/수집 3계층 카탈로그 — AI 가 꺼져 있어도 늘 보인다. 자동 항목은 설정 키, 온디맨드는 `ai_action_presets[].hidden`(메뉴 노출). 켜져 있으면 아래 카드가 AI 프리셋 페이지로 가는 버튼과 "노트북 재편 (AI)" 를 준다 |
| AI 프리셋 | `AiPresetsSection.tsx` → `presets/AiActionEditor.tsx` | 페이지 id `ai_presets`. `ai_action_presets` 편집 — AI 가 꺼져 있어도 보이고, 앱 전체 칩. 편집기는 앱 안 프리셋 모달(트리 헤더: 노트 프리셋·AI 프리셋 탭 / AI 모달 연필·"+추가")과 **같은 컴포넌트**다. 설정 창에서 고친 것은 `settings-changed` → `useAiPresetsStore.load()`(`lib/settingsChanged.ts`)로 본 창에 닿는다. 노트 프리셋은 "만들기"가 본 창 에디터를 써서 설정 창에 두지 않는다. 브라우저 모드 목록엔 없다 |
| AI 채팅 | `AiChatSection.tsx` | 페이지 id `ai_chat`. **어시스턴트**(`PetPersonaSection.tsx` — 이름과 달리 이 페이지가 렌더한다) · **프로필**(`user_name`) · 사이드바 챗 노출(`filter_roster` 의 chat 항목 `enabled`) · 권한 링크 → `ai_permissions` · 대화 기억(`ChatMemorySection.tsx` — `ai_chat_memory`·`chat_memory`) |
| 데이터 관리 | `DataManagementSection.tsx` | 페이지 id `data`, 페이지째 그린다. 위에서 아래로 **저장 공간 게이지**(`StorageGaugeStrip`) · **첨부 저장** 카드(`AttachmentStorageSection.tsx` — `attachment_storage_mode` 복사/하드링크/참조 · 슬라이드 미리보기 · soffice 경로) · **저장 및 백업** 카드(`StorageBackupCard.tsx` — 저장 위치(폴더 열기 · 위치 변경) · 자동 백업(`backup_auto_interval`·`backup_auto_keep` · 지금 백업 · 마지막 백업은 이 행 한 곳, 실패는 사유와 함께 한 줄)) · **데이터 이동** 카드(노트북 내보내기/가져오기 + "더보기" 메뉴: 전체 내보내기 · `.ics` 내보내기·가져오기 · 모양만 가져오기) · **위험 작업** 카드(데스크톱 전용 — 백업·복원·초기화를 **글자 단추**로, 복원·초기화·번들 "교체" 가져오기는 타이핑 게이트, 작업 중엔 창 닫기 막음) · 개발 빌드면 **테스트 데이터**(`TestDataSection.tsx`). 일회성 "파일로 백업…"(고른 경로 zip)은 자동 백업과 다른 동작이라 위험 작업 카드에 있다. `slide_preview` 가 노트북 키라 `notebookScoped` |
| 라이선스 | `LicenseSection.tsx` | 요약 타일(npm · Rust · 전문 없는 패키지 수, `src/lib/noticesSummary.json` 이 SSOT — `npm run gen:notices`) · 생성일 · 한컴 공개 문서 고지. 전문(`THIRD-PARTY-NOTICES.html`)은 히어로 버튼으로 OS 기본 브라우저에 연다(창 안에서 렌더하지 않는다, 브라우저 모드에선 비활성) |
| 펫 | `PetSection.tsx` / `pet/PetPackageGallery.tsx` · `pet/PetReactionSection.tsx` · `pet/PetPositionPicker.tsx` | `pet_*` 키 전반. 히어로 마스터 토글 → 켜져 있으면 그룹 셋: 캐릭터(미리보기 + 갤러리 + 추가 메뉴) · 동작 · 화면 위치(`docs/PET.md` §0.6). 미리보기는 실 펫 창 컴포넌트(`PetSprite`)를 그대로 그린다. `pet_assets` 는 휴면. 이 페이지가 무엇을 소유하지 않는지(화면 저장·페르소나·`pet_visible`)는 `docs/PET.md` §0.4 가 SSOT |
| 브리핑 | `BriefingSection.tsx` | 플러그인 그룹, 펫 아래. 머리 토글 `briefing_enabled`, 위에서 아래로 **표시 시점**(`briefing/ScheduleWhenSection.tsx` — `briefing_when`·`briefing_time`·저녁 회고 `briefing_evening_*`·알림 방식 `briefing_notify`) · **문구**(`PhrasePacksSection.tsx`, `phrase_pack_id` 노트북 키 — 브리핑이 꺼져 있으면 이유 툴팁과 함께 잠김) · **습관**(`briefing/HabitsEditor.tsx` — 설정 키가 아니라 `habit_*` 커맨드·테이블) · **반복 일정 표**(`TimelineRoutineSection.tsx`, "달력 및 일정" 페이지와 같은 컴포넌트). 섞인 페이지라 `notebookScoped`. 브라우저 모드 목록엔 없다 |
| 레일 하단 | `SettingsNavFooter.tsx` | 앱 버전 + 업데이트 확인 (페이지가 아님) |

공용 부품(페이지가 아님): `SwitchGrid.tsx`(독립 on/off 가 **3개 이상** 모일 때의 병렬 배치 — 값 컨트롤은
넣지 않는다, `docs/DESIGN.md` §설정 레이아웃 ⑥) · `IconAction.tsx`(동작 버튼은 **아이콘만**, `aria-label` 과
`title` 이 항상 같은 문자열 — `PLAN-2026-09-19-settings-icon-actions.md`. 모달 하단 확정 버튼·메뉴 항목·
되돌릴 수 없는 위험 작업은 글자로 남는다) · `SettingsRow` · `SectionHeader` · `SubGroup` · `SegGroup` ·
`Toggle` · `HintBadge` · `Badge` · `shared.ts`(`SETTINGS_CTRL_WIDTH` 등).

`filter_roster`(사이드바 구성) 전체를 고치는 UI 는 설정 창에 없다 — 폰(`src/mobile/MobileSettingsRoster.tsx`)에만
있고, 데스크톱 설정 창은 AI 채팅 페이지에서 chat 항목 하나만 켜고 끈다. 결제문자 캡처 키
(`capture_ledger_enabled`·`capture_ingest_*`)는 `validate_setting` 에 살아 있지만 그리는 설정 화면이 없다.

내비게이션은 `SettingsNav.tsx`가 담당하며, 레일에서 섹션을 고르면 해당 섹션 컴포넌트만
마운트된다(다른 섹션은 렌더되지 않음).

**원격 클라이언트 노출 정책** — 위 섹션 중 원격(HTTP `/api/v1/invoke`) 클라이언트에서 실제로
쓸 수 있는 설정 키/페이지가 무엇인지는 `src/lib/remoteSettingsPolicy.ts` 가 단일 관문이다
(폰 요약 화면 `MobileSettings.tsx` 와 태블릿 브라우저 모드의 `SettingsPanel` 페이지 필터
`BROWSER_SETTINGS_PAGES` 가 둘 다 이 파일을 읽는다). 차단 키 자체의 SSOT 는 Rust
`src-tauri/src/sync_server/handlers/remote_policy.rs::is_remote_blocked_settings_key` — 이 모듈은 그 서버
판정의 TS 미러이고, 드리프트는 `src/lib/remoteSettingsPolicy.test.ts` 가 두 쪽을 문자열로 대조해 잡는다.

### 2.6 설정 검색 — 새 설정을 검색에 등록하는 법 (PLAN-2026-10-24 W4)

헤더의 검색창(`SettingsHeader.tsx`, Ctrl/Cmd+F 로 포커스)은 **데이터뿐인 색인**
`src/components/settings/settingsSearchIndex.ts` 를 `t()` 로 풀어 찾는다(그래서 ko/en/fr 로 다 찾힌다).
결과를 고르면 `SettingsPanel.handleSelectPage(page, anchor)` — 페이지를 바꾸고 기존 앵커 소비 effect 가
본문 컨테이너만 스크롤하며 행을 강조한다(`settings-anchor-flash`).

새 설정 행을 만들면:

1. 행에 **앵커**를 단다 — `<SettingsRow anchor="my_setting" …>`(행 루트 id = `anchorId("my_setting")`).
   `SwitchGrid` 항목은 `anchor: "…"`, 슬라이더 행·카드·버튼 같은 비-행은 그 블록에 `id={anchorId("…")}`.
   이름은 snake_case, **한 페이지 안에서 유일**(다른 페이지와 겹쳐도 한 화면엔 한 번만 선다).
2. `settingsSearchIndex.ts` 에 항목을 더한다: `{ page, anchor, labelKey, groupKey?, keywordKeys?, requires? }`.
   `labelKey` 는 행 라벨에 쓰는 i18n 키 그대로, `groupKey` 는 그 카드의 제목 키(결과에 "페이지 › 그룹"으로 보인다).
   섹션 컴포넌트를 import 하지 않는다(부팅 번들 — 색인은 문자열만).
3. **라벨에 없는 흔한 동의어**가 꼭 필요할 때만 `keywordKeys` — `settings.search_kw_*` 키(공백으로 이은 한
   문자열, 세 로케일 동시)를 쓴다. 남발하지 않는다.
4. 행이 **조건부로만 그려지면** 둘 중 하나: `requires: "ai"`(AI 꺼짐이면 본문이 접히는 행) ·
   `requires: "desktop"`(브라우저 모드에 없는 행)을 달면 조건이 안 맞을 때 앵커를 떼고 페이지만 연다.
   그 밖의 상태(IPC 로 아는 펫·동기화 켜짐, 저장된 값에 따라 나오는 행)는 **앵커를 비운다** — 그래야 안 그려진
   행을 찾느라 `anchor_not_found` 진단이 쌓이지 않는다.
5. `npx vitest run src/components/settings/settingsSearchIndex.test.ts` — 표류 가드가 키 실재(세 로케일) ·
   `page` 가 `SettingsPanel` 의 id 인지 · 모든 `anchor` 가 `src/components/settings/**` 에 실제로 달려 있는지 ·
   페이지 안 중복을 본다. 앵커를 단 행을 지우고 색인을 안 지우면 여기서 빨개진다.

검색 규칙은 `searchSettings.ts`(순수 함수): 대소문자·앞뒤 공백 무시, 라벨·그룹·페이지 이름·동의어의 부분 문자열,
순위는 라벨 접두 > 라벨 부분 > 그룹/페이지/동의어, 최대 8개, 브라우저 모드면 걸러진 페이지(`BROWSER_SETTINGS_PAGES`)만.
한국어 초성 검색은 없다(`ponytail:` 주석 — 자모 분해 키를 같이 비교하면 올릴 수 있다). AI 기능 페이지의
기능별 토글은 카탈로그 데이터라 색인하지 않는다(그 페이지 자체 검색칸이 맡는다).

## 3. 데이터 모델

```sql
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL              -- JSON 인코딩 값
);
```

컬럼은 이 두 개뿐이다 — 타입 강제는 스키마 레벨(SQL)이 아니라 애플리케이션 레벨
(`validate_setting`)에서 이뤄진다. `schema_migrations(version, applied_at)` 테이블이 스키마
버전을 별도로 관리한다(설정 값과 무관).

## 4. 핵심 코드 경로

| 관심사 | 파일 |
|---|---|
| 검증 허용 목록(기계 SSOT) + 기본값 시드 | `src-tauri/src/repo/settings_schema.rs` |
| DDL + 키 목록 사람용 미러 주석 | `specs/db/schemas/settings.sql` |
| `settings_get_all`/`settings_set` 커맨드 | `src-tauri/src/commands/settings.rs` |
| repo 계층 get/set | `src-tauri/src/repo/settings.rs` |
| 프런트 스토어(simplePrefs, load/migration) | `src/stores/settings.ts` |
| export 시 제외 키 필터 | `src-tauri/src/repo/transfer/export.rs::is_device_local_setting_key`, `is_secret_setting_key` |
| 원격 쓰기 차단 키(서버 SSOT) + TS 미러 | `src-tauri/src/sync_server/handlers/remote_policy.rs::is_remote_blocked_settings_key` + `src/lib/remoteSettingsPolicy.ts` |
| AI 프로바이더 전환·키 보관함(`ai_provider_creds` 유일한 작성자) | `src/lib/aiProviderSwitch.ts` |
| AI 마스터 스위치 표면(AI 제공자 첫 줄 + 다른 AI 페이지의 링크 한 줄) | `src/components/settings/AiProviderSection.tsx` · `AiOffLink.tsx` |
| 키 드리프트 정적 게이트 | `scripts/check-settings-keys.mjs` |
| 설정 창 섹션들 | `src/components/settings/*.tsx` |
| 레일 그룹·페이지 정의(5그룹 17페이지) | `src/components/settings/SettingsNav.tsx`(`GROUP_LABEL_KEY`) + `src/components/SettingsPanel.tsx`(`allPages`) |
| 강조색 팔레트 생성(OKLCH→hex) | `src/lib/accentPalette.ts` — 옛 `VALID_ACCENTS` 5색 화이트리스트의 후임 |
| 외형 상수·CSS 변수 적용 | `src/lib/appearance.ts`(`CONTENT_TINT_*`, `CANVAS_BASE`) + `stores/settings.ts::applyCssVars` |
| 기능 카탈로그 | `specs/features/settings.yaml`(F-ST01 키 allowlist / F-ST02 IA / F-ST03 강조색·틴트) |

## 5. 알려진 한계 / 결정

- **필드별 전용 커맨드 없음** — 모든 설정은 `settings_set`의 `entries` 배치로 쓴다(예외:
  다른 도메인 커맨드가 부수적으로 겸하는 `remind` 같은 케이스, §2.4 DASHBOARD.md).
- **"0"/"1" 문자열 관례는 일부 키 한정** — 신규 코드가 boolean으로 착각하고 붙이면
  `validate_setting`이 `is_boolean()`으로 검사해 "1"/"0" 문자열 저장이 거부된다(반대 방향
  실수도 마찬가지). 어느 쪽인지는 `validate_setting`의 해당 arm을 직접 확인해야 한다 —
  이 문서가 전수 목록을 유지하지 않는다(코드가 SSOT).
- **`check-settings-keys.mjs`는 정적 스캔 한계가 있다** — 완전히 동적으로 계산된 키(템플릿
  리터럴, 스프레드)는 검증하지 못하고 "정적 검증 불가"로만 보고한다. 이런 경로는 리뷰 시
  사람이 직접 `validate_setting` 대응 여부를 확인해야 한다.
- **`npm run check` 전체를 돌려야 한다** — 개별 스크립트만 골라 돌리면 이 게이트가 빠질 수
  있다(CLAUDE.md 커밋 전 게이트 절 참고 — 과거 표면 계약/CSS 변수 검사가 통째로 누락된 사고
  전례가 있음).
