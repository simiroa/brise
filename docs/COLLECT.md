# Collect — 자동 수집 관문 (collect v2)

> 한 줄 요약: RSS/웹/유튜브(+ 로컬 AI 세션 프롬프트·브라우저 기록)를 60초 tick 백그라운드
> 러너가 주기적으로 긁어와 인박스(또는 지정 폴더)에 노트로 적재하는 기능. 어댑터는 fetch/파싱만,
> 중복 방지·상태 기록·AI 후처리(제안/요약)는 러너의 단일 경로(`collect::mod`)가 소유한다.

**SSOT 관계**: 기능 결정의 1차 소스는 `specs/features/collect.yaml`(F-C01~F-C14, 케이스별
input→output 기대값 + 커버 테스트 연결). 배경/설계 논의는 `docs/PLAN-2026-08-23-collect-advanced.md`·
`docs/PLAN-2026-09-04-local-import.md`. 이 문서는 그 둘을 사람이 읽기 좋게 통합한 것이며, 코드가
실제 SSOT다 — 이 문서와 코드가 갈리면 코드를 믿는다.

## 1. 기능 개요

설정 화면(`설정 > 수집`)에서 소스를 등록하면, 앱 부팅 시 뜬 백그라운드 스레드가 60초마다
"주기가 도래한" 소스를 훑어 새 항목을 노트로 만든다. 소스 종류는 6가지:

| kind | 어댑터 | 가져오는 것 |
|---|---|---|
| `rss` | `collect/rss.rs` | RSS 2.0 / Atom 피드의 `<item>`/`<entry>` |
| `web` | `collect/web.rs` | 웹페이지 본문(`repo::web_reader` 재사용, SSRF 가드 포함) |
| `youtube` | `collect/ytdlp.rs` | yt-dlp 사이드카로 자막(VTT) 추출 — **단일 영상 URL 전용** |
| `claude_prompts` | `collect/claude_prompts.rs` | `~/.claude/projects` 아래 세션 JSONL의 user 메시지 |
| `codex_prompts` | `collect/codex_prompts.rs` | `~/.codex/sessions/YYYY/MM/DD` 아래 세션 JSONL의 user 메시지 |
| `browser_history` | `collect/browser_history.rs` | Chrome/Edge/Brave/Vivaldi/Whale History sqlite에서 직접 읽은 방문 기록(Windows 전용) |

`claude_prompts`/`codex_prompts`/`browser_history`는 네트워크가 아니라 로컬 파일·로컬 sqlite를
읽는다는 공통점으로 "로컬 가져오기" 3종으로 묶어 부른다(`PLAN-2026-09-04-local-import.md`) — 이
셋만 항목 단위가 아니라 항목 안 줄(part) 단위로 seen을 판정한다(§2.5). 어댑터별 디테일은 §2.8.

**유튜브 채널 구독은 별도 kind가 아니다** — 채널 RSS(`feeds/videos.xml?channel_id=UC…`)를
`kind='rss'`로 등록한다. 설정 UI의 "유튜브 채널" 유형(UI 전용 의사 kind)과 자연어 등록의 채널형
youtube 초안 재작성(`rewrite_youtube_channel_draft`)이 채널 URL을
`collect_resolve_youtube_channel` 커맨드로 해석해 rss로 저장한다(`/channel/UC…`는 무네트워크 변환,
`@handle` 등은 채널 페이지에서 channelId 추출 — 홉마다 SSRF 재검증). rss로 들어온 유튜브 watch
링크 항목은 ingest 전에 yt-dlp 자막으로 본문이 보강된다(§2.4a).

소스마다 활성/비활성, 드라이런 모드, 저장 대상 폴더(기본 인박스), 수집 주기(분), AI 후처리
(`post_process: "none" | "suggest" | "summary"`)를 설정한다. UI는 목록 + 자연어 빠른 등록(AI가 URL/요청을
구조화된 소스로 변환) + "지금 실행"/"드라이런(테스트 실행)" 버튼으로 구성된다
(`src/components/settings/CollectSection.tsx`).

## 2. 동작 방식

### 2.1 러너 — 60초 tick과 due 판정

`collect::start(data_dir)`가 앱 부팅 시 1회 백그라운드 스레드를 띄운다(`src-tauri/src/collect/mod.rs`).
이 스레드는 자체 DB 커넥션과 자체 `tokio::runtime`(current-thread)을 들고 `run_loop`을 무한
반복한다 — 60초(`TICK_INTERVAL`) 자고, `run_cycle` 한 번, 다시 잔다.

`run_cycle`은 `repo::collect::find_due(conn, now)`로 "enabled AND dry_run=0"인 소스 중 주기가
도래한 것만 골라 `run_one`으로 하나씩 실행한다. due 판정(`repo::collect::is_due`)은:
- `last_run_at`이 없으면(한 번도 안 돎) 항상 due.
- 있으면 `last_run_at + interval_minutes <= now`. `interval_minutes`는 컬럼값 우선, 없으면
  config JSON의 `interval_minutes` 폴백, 최종 기본값은 `DEFAULT_INTERVAL_MINUTES = 60`.
- 사용자가 아무리 짧게 설정해도 `MIN_INTERVAL_MINUTES = 15`분 아래로는 클램프된다(60초 tick
  러너가 같은 소스를 매 tick 재실행하는 사고 방지).
- 타임스탬프 파싱 실패는 "due로 취급"(소스가 영원히 멈춰있는 것보다 한 번 더 도는 게 안전).

`collect_for_kind`는 kind 문자열 → 어댑터 함수로 매치 하나로 디스패치한다(트레이트 오브젝트 없음
— kind가 6종뿐이라 과추상화하지 않음, ponytail). 아직 실행 어댑터가 없는 kind가 등록돼 있으면
`None`을 반환해 조용히 스킵한다 — `last_status`를 "not yet supported" 에러로 더럽히지 않는다.

### 2.2 락 규율 — 어댑터 fetch 동안 DB 락 해제

핵심 불변식: **네트워크/파일시스템 작업(초 단위로 걸릴 수 있음) 동안 전역 DB 뮤텍스를 잡고
있지 않는다.** RSS fetch·yt-dlp 자막 추출·웹 리더 요청이 전역 락을 물고 있으면 그동안 autosave를
포함한 다른 모든 커맨드가 막힌다.

패턴은 "지금 실행"(`collect_source_run_now`)과 "드라이런"(`collect_source_dry_run`) 두 커맨드
모두 동일하다(`src-tauri/src/commands/collect.rs`):

1. **스냅샷**: 짧게 락을 잡고 `collect::get`으로 소스 메타데이터만 읽고 즉시 락 해제.
2. **락 해제 상태로 어댑터 실행**: `collect::collect_source(&source, &rt, data_dir)` — `conn`을
   전혀 받지 않는 시그니처라 컴파일 타임에 락을 안 쥐고 있음이 보장된다.
3. **재획득**: 결과를 들고 다시 짧게 락을 잡아 `finish_run_now`(실행) 또는 `finish_dry_run`(미리보기)
   으로 ingest/상태 기록만 처리.

백그라운드 러너(`run_one`)도 `conn`을 `&mut Connection`으로 들고 있지만 `collect_source`(어댑터
호출)는 `conn`을 넘기지 않으므로 러너 스레드 자체가 이 규율을 지킨다 — 러너는 애초에 메인 스레드의
`state.db`와 별개 커넥션을 쓰므로 잠금 경합의 대상이 다르지만, 같은 함수 분리 패턴을 공유한다.

이 분리는 테스트로 고정돼 있다: `finish_dry_run_reports_seen_state_after_an_out_of_lock_fetch`가
"어댑터 fetch는 conn을 전혀 빌리지 않고 끝난다"를 명시적으로 검증한다.

### 2.3 dry_run 모드 — 쓰기 0건 불변식

소스에 `dry_run: true`가 설정돼 있으면:

- **백그라운드 러너에서 절대 실행되지 않는다** — `find_due`의 SQL이 `WHERE ... AND dry_run = 0`으로
  아예 걸러낸다.
- **"지금 실행"(`collect_source_run_now`)이 명시적으로 거부한다** — `finish_run_now`가 진입
  직후(어댑터 fetch·ingest 전) `source.dry_run`을 확인해 `RunNowOutcome{ok:false, added:0,
  error:Some("... use the dry-run preview instead of run-now")}`을 반환한다. 이 가드는 모든
  ingest 경로(`collect_source_run_now`, `run_one`/백그라운드, `run_now`)가 수렴하는 단일 지점
  (`finish_run_now`)에 있다 — 호출자별로 중복 방지 로직을 두지 않는다.
- **전용 경로 "드라이런"(`collect_source_dry_run` → `finish_dry_run`)만 dry_run 소스를 다룬다.**
  이 경로는 다음을 절대 하지 않는다:
  1. `claim_seen` 호출 — `collect_seen`에 DB 쓰기 0건.
  2. 노트 생성 — `notes` 테이블 쓰기 0건.
  3. `record_result` 호출 — `last_run_at`/주기 시계가 전진하지 않는다.

  대신 `collect_seen`을 SELECT만 해서(N+1 방지를 위해 `repo::collect::seen_guids`로 배치 조회)
  각 항목의 `seen` 여부를 판정하고, 항목 본문 앞 200자를 `preview`로 잘라 돌려준다. 결과는
  UI의 "총 N개 발견 (신규 M / 기수집 K)" 요약 + 항목별 preview 카드로 렌더된다.

이 불변식은 `collect::mod`의 테스트
`dry_run_does_not_claim_seen_or_write_notes_and_keeps_last_run_at_null`이 왕복 검증한다: 드라이런
실행 → seen/notes/last_run_at 모두 무변화 확인 → dry_run을 끄고 실제 `run_now` 실행 → 다시
드라이런 → 이번엔 `seen: true`로 나오는지까지 확인한다.

### 2.4 yt-dlp (youtube kind)

`collect/ytdlp.rs`가 사이드카 바이너리를 관리한다. **설치본은 yt-dlp를 동봉하지 않는다** —
유료 판매 시 다운로더 바이너리 동봉은 스토어 심사·유튜브 약관 노출 리스크라, 사용자가 자기
선택으로 내려받는 구조로 책임을 분리했다(tauri.conf.json에 externalBin 없음). 바이너리 확보는
2단계다:

1. **씨앗 복사(무료·오프라인, 있으면 우선)**: `ensure_ytdlp`가 `data_dir/bin/yt-dlp(.exe)`가
   없을 때 실행파일 옆·`binaries/` 서브디렉토리·개발 환경 경로 순으로 훑어 있으면 그대로
   앱 데이터(쓰기 가능 위치)로 복사한다. 이 경로는 네트워크를 타지 않는다 — 씨앗이 있으면
   `collect_ytdlp_status`가 이미 "설치됨"으로 보고하므로 아래 2단계는 아예 일어나지 않는다.
2. **온디맨드 다운로드(씨앗이 없을 때만, 항상 사용자 동의 경유)**: 설정 > 수집에서 유튜브
   kind 소스를 저장(dry_run=false)하거나 "지금 실행"·"테스트 실행"을 누르면
   `CollectSection.tsx::ensureYtdlp`가 `collect_ytdlp_status`로 먼저 확인하고, 미설치면
   `ask()` 동의 다이얼로그를 띄운다("공식 배포처(GitHub)에서 내려받을까요? 사용과 YouTube
   약관 준수는 사용자 책임"). 수락해야만 `collect_ytdlp_install` → `ytdlp::ytdlp_download`가
   호출된다:
   - URL은 릴리스 페이지가 아니라 고정 상수(`https://github.com/yt-dlp/yt-dlp/releases/
     latest/download/<자산명>`) — OS별 자산명은 Windows `yt-dlp.exe` / macOS `yt-dlp_macos` /
     그 외 `yt-dlp`.
   - **체크섬 검증**: 같은 릴리스의 `SHA2-256SUMS`를 먼저 받아 자산명 행의 SHA-256 해시를
     파싱(`parse_sha256sums`, 순수 함수)하고, 바이너리를 스트리밍으로 받으며 직접 해시를
     계산해 대조한다. 불일치하면 설치하지 않고 IO 에러.
   - **원자적 설치**: 스트리밍 대상은 실제 경로가 아니라 `data_dir/bin/.yt-dlp.download`
     임시 파일 — 검증 성공 시에만 `verify_and_install`이 최종 경로로 rename한다. 중단/크래시가
     나도 `ensure_ytdlp`가 찾아 실행하려 들 반쪽짜리 바이너리를 남기지 않는다.
   - **멱등**: `collect_ytdlp_install`은 호출 전 `ytdlp_installed`를 다시 확인해, 이미 있으면
     재다운로드 없이 즉시 `ok:true`(동의 다이얼로그를 두 번 띄우지 않기 위한 프론트 쪽
     `collect_ytdlp_status` 선확인과 별개의 서버 쪽 방어선).
   - **폭주 방어**: 50MB 초과 시 스트리밍 중단(Content-Length 미신뢰, 실물은 ~20-30MB).
   - **락 규율**: `collect_ytdlp_install`은 `state.db`를 아예 건드리지 않는 시그니처라
     (§2.2와 동일 원칙) 다운로드 동안 전역 DB 뮤텍스를 애초에 쥐지 않는다.
   - **러너는 절대 다운로드를 트리거하지 않는다** — 백그라운드 러너(`run_one`)와 "지금
     실행"/"드라이런"의 실제 fetch 경로(`collect_source`)는 `ensure_ytdlp`의 씨앗 복사만
     보고, 미설치면 그대로 실패해 `last_error`에 "yt-dlp is not installed — add or edit a
     YouTube source in Settings > Collect to download it" 형태의 실행 가능한 메시지를 남긴다.
     설치는 항상 설정 화면의 명시적 사용자 동작(저장/지금 실행/드라이런 버튼)을 거쳐야만
     일어난다 — 러너가 조용히 GitHub에 네트워크 요청을 쏘는 경로는 없다.
- **일일 자기업데이트**: `.last-update-check` 스탬프 파일로 하루 1회만 `-U` 실행 — 스탬프는
  업데이트 성공 여부와 무관하게 먼저 기록해 같은 날 재시도를 막는다. 업데이트는 **fire-and-forget
  백그라운드 스레드**로 fetch 경로와 완전히 분리돼 있다(예전엔 이 호출이 fetch를 동기로 막았다
  — 지금은 실패/타임아웃이 로그만 남기고 다음 실행에 영향 없음).
- **60초 타임아웃**(`FETCH_TIMEOUT`)과 별개로 업데이트 스레드도 60초 타임아웃(`UPDATE_TIMEOUT`)을
  가진다. `std::process`엔 내장 타임아웃이 없으므로 `run_with_timeout`이 stdout/stderr를
  백그라운드 스레드로 드레인하며 `try_wait`을 폴링하고, 데드라인 초과 시 `child.kill()`한다
  (드레인 스레드 없이 timeout만 걸면 대용량 stdout이 OS 파이프 버퍼를 채워 자식이 죽기 전에
  데드락한다 — yt-dlp가 자막을 stdout으로 스트리밍하므로 실제로 걸리는 함정).
- **Windows `CREATE_NO_WINDOW`**: yt-dlp가 콘솔 exe라, 이 플래그 없이는 호출마다 GUI 위로 콘솔
  창이 깜빡인다.
- URL은 검증된 http(s) 공인 호스트만 통과(config 스키마 단계에서 loopback/파일 스킴 거부),
  인자는 배열로 전달(셸 경유 금지).
- 가져온 VTT는 `clean_vtt`가 헤더/타임스탬프/HTML 인라인 태그/연속 중복 라인을 제거하고
  3분(180초) 간격으로 `### ⏱️ HH:MM:SS` 마크다운 챕터를 만든다.
- guid는 영상 URL 자체 — 재실행해도 멱등.

### 2.4a 유튜브 자막 보강 (rss 항목)

`collect_source()`(세 호출 경로 — 러너 `run_one`·"지금 실행"·드라이런 — 가 전부 지나는 래퍼,
`collect/mod.rs`)가 rss 어댑터 결과에 한해 보강 단계를 돌린다:

- 항목의 `source_url`이 유튜브 watch URL(`youtube.com/watch?v=`·`youtu.be/<id>`)이고 **unseen**이면
  `ytdlp::fetch_subtitles`로 본문을 자막으로 교체. 실패(자막 없음/타임아웃)하면 원본
  본문(피드 설명)을 유지한 채 그대로 ingest — 링크+설명이라도 저장하는 쪽을 택한다.
- **seen 판정은 자체 커넥션**으로 한다(러너의 `start()`와 같은 `db::open`) — SELECT 후 즉시 drop,
  fetch(네트워크/yt-dlp) 동안 어떤 커넥션도 잡지 않는다(§2.2 락 규율 유지). 유튜브 링크가 하나도
  없는 일반 피드는 DB조차 열지 않는다.
- **run당 `ENRICH_CAP = 5`건**만 보강하고, 캡을 넘는 unseen 유튜브 항목은 이번 결과에서 제거한다 —
  seen 처리가 안 되므로 다음 due 주기에 자연히 재수집(신규 채널 구독의 백필 15건이 3주기에 걸쳐
  이월 소화). 드라이런도 같은 경로라 미리보기에 자막이 보인다(미리보기=실제 저장물).

### 2.5 guid/collect_seen 중복 방지 — 항목 단위와 부분(parts) 단위

각 어댑터는 항목마다 `guid`(RSS `<guid>`/Atom `<id>`, 없으면 링크로 대체 — RSS는 guid도 link도
없는 항목을 통째로 스킵)를 정한다. `collect_seen(source_id, guid)` 복합 PK 테이블이 중복 판정의
전부다 — 다만 그 guid가 무엇을 가리키는지는 어댑터 계열에 따라 둘로 갈린다(`ingest_item_with_note_id`가
`item.parts`가 비어 있는지로 분기).

**항목 전체 단위(rss/web/youtube)** — 기존 동작. `CollectedItem.guid` 하나가 그대로
`collect_seen`의 키이고, `ingest_item_whole`이 처리한다.

- **원자적 클레임**: 노트를 만들기 *전에* `claim_seen`(`INSERT OR IGNORE`)으로 선점한다 — PK
  충돌이 동시성 경계라, 백그라운드 러너와 수동 "지금 실행"이 같은 피드 항목을 동시에 관찰해도
  정확히 한쪽만 `true`를 받아 노트를 만든다.
- **실패 시 릴리스**: 노트 생성(`pet::create_inbox_note`)이 실패하면 `release_seen_claim`으로
  클레임을 되돌린다 — 실패를 영구 seen으로 취급하면 재시도 기회가 영영 사라진다.
- **배치 조회**: 드라이런의 seen 판정은 항목마다 SELECT 하나(N+1)였던 것을
  `repo::collect::seen_guids`가 청크당 배치 쿼리 1회로 줄였다(100건 RSS 피드가 100쿼리를 쏘던
  문제).
- **소스 삭제 시 정리**: `repo::collect::delete`가 같은 트랜잭션에서 `collect_seen` 행도 함께
  지운다(FK 없음, V40_SQL 주석) — 삭제 후 재등록해도 과거 seen 기록이 남지 않는다.

**항목 안 부분(parts) 단위(claude_prompts/codex_prompts/browser_history)** — "로컬 가져오기"
3종은 항목 하나가 "하루치 노트"를 대표하고(예: "클로드 프롬프트 — brise 2026-09-04"), seen
판정은 그 안 각 줄(`CollectedPart`)마다 따로 이뤄진다. `ingest_item_parts`가 처리한다
(`PLAN-2026-09-04-local-import.md` §2.1):

```rust
pub struct CollectedPart { pub guid: String, pub line: String, pub dedupe_needle: Option<String> }
pub struct CollectedItem { …, pub parts: Vec<CollectedPart> }  // 비어 있으면 위 "항목 전체 단위" 그대로
```

- **`item.guid`는 절대 클레임되지 않는다** — 날짜 묶음 자체가 seen이 되면 그 뒤로 늘어난 줄이
  영영 안 들어온다.
- **같은 제목 노트에 append**: 같은 target 폴더에 `item.title`과 완전일치하는 노트가 이미
  있으면 그 첫 섹션 `body_md`를 직접 `UPDATE` + `fts_upsert`로 이어붙이고, 없으면
  `pet::create_inbox_note`로 새로 만든다 — `sync_server::ingest.rs`의 가계부 일자 노트와
  같은 자세다. **`activity_log`는 여기서 남기지 않는다** — 워크스페이스당 2000행
  상한을 하루치 줄 append가 밀어내지 않도록.
- **part마다 개별 클레임**: 각 `part.guid`를 `claim_seen`으로 선점한다 — 이미 seen이면 그 줄만
  스킵하고 같은 항목의 다른 새 줄은 그대로 붙인다.
- **`dedupe_needle`**: 있고, 지금까지 쌓인 본문(같은 run 안에서 앞서 붙은 줄 포함)에 이미
  있으면 그 part는 **클레임은 되지만 줄은 붙지 않는다** — `browser_history`가 같은 URL을
  재방문마다 새 `visit.id`(=새 guid)로 다시 실어와도 노트에 중복 줄이 쌓이지 않게 하는 장치.
- **`browser_history`의 도메인 제외**: 이 어댑터는 conn이 없어 `collect_excluded_domains`를
  스스로 걸러낼 수 없다 — 유일하게 conn을 쥐는 `ingest_item_parts`가
  `urlfilter::read_excluded_domains`로 대신 걸러낸다(`dedupe_needle`이 `(url)` 모양이라는
  어댑터 계약에서 URL을 다시 뽑아 판정).
- **드라이런**: seen 판정을 part guid 배치로 하여 "새 것/기수집"을 part 수 기준으로 낸다 —
  parts가 있는 항목은 `item.guid`가 절대 클레임되지 않으므로 item.guid로만 물으면 언제나
  `false`다. preview는 unseen part의 줄만 이어붙여 보여준다(이미 seen인 줄까지 섞으면 "뭐가
  새로 들어오는지"를 못 보여준다).
- **활동 이력은 항목 전체 단위와 동일하게 run당 한 줄**: `finish_run_now`가 이번 run에서 실제로
  쓴 노트 수(`added`, 줄 수가 아니다)가 1건이라도 있으면
  `activity::record(KIND_COLLECT, "<소스 이름> N건")`을 딱 한 번 남긴다 — 같은 날짜 노트 하나에
  여러 줄이 붙어도 그 run의 `added`는 1이다.
- **동기화 수렴 규칙**: 두 기기가 오프라인에서 각자 같은 제목의 일자 노트를 만든 뒤 동기화되면
  같은 폴더에 제목이 같은 노트가 두 개 이상 남는다 — LWW(§SYNC.md §1)는 그중 더 최근에 쓰인
  쪽의 몸통만 살리므로, 병합 규칙 없이 그냥 append하면 다른 쪽 줄을 통째로 잃는다.
  `collect::daynote::find_or_merge_day_note`가 append 직전에 이를 감지해 가장 오래된 노트(동률이면
  id가 작은 쪽)를 생존자로 삼아 첫 섹션 줄을 오래된 순으로 합치고(정확히 같은 줄·같은 `(url)`
  needle은 첫 것만, `## 요약` 블록은 최신 것이 이김), 나머지는 `deleted_at` + `fts_delete`로
  소프트 삭제한다. 결정적 노트 id(날짜+제목 해시로 시드)는 기각했다 — 노트 id는 이미 첨부·태그·
  내부 링크가 참조하는 진짜 식별자라 사후에 결정적으로 바꾸면 그 참조가 깨진다. `ingest_item_parts`
  와 `sync_server::ingest.rs::append_visit`이 이 헬퍼를 공유한다.

### 2.6 AI 후처리 제안

소스의 `post_process`가 `"suggest"`면, `ingest_item`이 노트를 만든 직후
`insert_collect_post_process_suggestion`이 `suggestions` 테이블에 `kind='collect_post_process'`
pending 행을 하나 적재한다. payload는 `{source_id, source_name, post_process_model}`.

실제 INSERT는 `repo::suggestions::insert_collect_post_process`가 소유한다 — "테이블 쓰기는 한
곳에 모은다"는 정책에 따라 `collect::mod`는 payload만 조립해 넘긴다(자세한 제안 시스템 계약은
`docs/SUGGESTIONS.md`). 이 삽입이 실패해도 노트 생성 자체는 이미 성공했으므로 ingest는 실패로
치지 않고 로그만 남긴다.

**소비(수락) 경로 — AI 호출은 수락 시점에만**: 이 제안은 펫/사이드바 채팅 카드
("`소스명`에서 수집한 `노트제목` — AI로 정리할까요?")로 렌더되고, "정리하기" 수락 시
`petCollectBridge.ts::acceptCollectSuggestion`이 ①제안 accepted ②노트 열기 ③기존 organize 계약
(`ai_organize_note` → `lastProposal` → `AiConfirmModal` → `ai_apply_organize`)을 그 노트에 돌린다.
러너는 여전히 AI를 부르지 않는다 — 계획서 §3.4의 "러너가 제안 생성" 대신 **수락 시 지연 실행**을
택했다(무시한 항목엔 LLM 호출 0회, §0.1 "되풀이 비용 0" 원칙; 확인 없이 쓰는 경로 없음 불변식은
동일하게 유지). `post_process_model`은 이 호출의 model 오버라이드로 쓰이고, `origin:
"collect_post_process"` 파라미터가 이 호출을 `ai_history`/`ai_usage`에 `collect_post_process`
action_type으로 기록해 수집 탭 통계 카드(`collect_get_stats`)에 집계된다.

**`summary`(`PLAN-2026-09-04-local-import.md` §2.4) — 프롬프트 요약 upsert**: `post_process`가
`"summary"`인 소스는 `suggest`와 달리 제안 카드를 만들지 않는다. 노트가 실제로 갱신된 직후
곧바로 AI를 불러 그 노트 첫 섹션 맨 위에 "## 요약" 블록을 upsert한다(`collect/summary.rs`).

- **보내는 것은 프롬프트 줄뿐**: 본문에서 `- `로 시작하는 줄만 추려 이어 붙인 것(최대
  `PROMPT_CHAR_CAP = 8_000`자, 넘으면 뒤쪽/최신 문자만 유지)을 모델에 보낸다 — 원래 대화의
  AI 응답은 절대 읽지 않는다(Q6 유지). 프롬프트 줄이 하나도 없으면 AI를 부르지 않는다.
  프라이버시 게이트(`ai::privacy_gate_ok`)가 닫혀 있어도 마찬가지로 조용히 스킵한다(자동
  백그라운드 작업이라 에러로 표면화하지 않는다).
- **구조화 출력(JSON)으로 요청**: 모델에게 평문 세 줄이 아니라 `{goal, recurring, unresolved}`
  세 필드짜리 JSON 객체를 요청한다(`TextTransport::send_json`) — 2026-09-05 실측으로 Gemma가
  평문 모드에서는 사고 과정을 답에 흘려("* Input: … * Constraints: …" 식 불릿) 세 줄 계약이
  깨졌기 때문. 응답을 목표/반복/미해결 세 줄로 변환해
  `## 요약\n<!-- summarized_at: <ISO-8601 UTC> -->\n<3줄>\n\n`으로 노트 첫 섹션 맨 위에 붙인다.
  본문이 이미 `## 요약`로 시작하면(재실행) 그 블록(마커 포함)만 통째로 교체하고 나머지 본문은
  그대로 둔다 — 재실행마다 블록이 쌓이지 않는다. `post_process_model`이 있으면 그 모델로,
  없으면 설정 기본 모델로 호출한다.
- **디바운스(30분)**: AI를 부르기 전에 기존 블록의 `summarized_at` 마커를 읽어, 마지막 요약이
  `SUMMARY_DEBOUNCE = 30분` 안이면 AI 호출 없이 조용히 스킵한다(본문도 그대로) — 짧은 러너
  주기(예: 15분)로 소스가 돌 때마다 재요약하면 하루 수십 번 AI를 낭비하기 때문. 마커를 노트
  본문 자체에 저장해 앱 재시작·기기 간 동기화를 그대로 견딘다(러너 프로세스 메모리나 별도 DB
  컬럼이 아니다). 마커가 없거나(마커 도입 이전 구버전 블록) 파싱에 실패하면 "한 번도 요약된
  적 없음"으로 관대하게 처리해 그대로 요약을 진행한다.
- **백그라운드 전용 120초 예산**: 이 후처리는 사용자가 기다리는 화면이 없는 백그라운드
  호출이라, 사용자 대면 텍스트 호출의 45초 예산(`TEXT_OPERATION_DEADLINE`) 대신
  `RealTextTransport::background()`(`BACKGROUND_OPERATION_DEADLINE = 120초`)를 쓴다 — Ollama
  콜드 스타트나 큰 프롬프트가 45초를 넘기는 실측 때문.
- **락 규율은 §2.2와 동일**: `conn`은 ①크레덴셜+본문 읽기 ②upsert 트랜잭션, 이 두 짧은
  구간만 쥐고 그 사이(AI 네트워크 호출) 동안은 아무 conn도 열려 있지 않는다(`conn_factory`
  클로저가 매번 새 커넥션을 연다).
- **호출 지점 둘**: 백그라운드 러너(`run_one`)는 `finish_run_now_collecting_notes`가 돌려주는
  이번 run에서 실제로 쓴 노트 id들에 곧바로 `summary::maybe_summarize`를 건다. "지금
  실행"(`commands::collect::collect_source_run_now`)도 전역 DB 뮤텍스를 이미 놓은 뒤 별도
  `std::thread::spawn`으로 같은 요약을 돌려, AI 호출(초 단위)이 "지금 실행" 토스트를
  기다리게 하지 않는다 — 두 경로 모두 실패는 로그만 남기고 소스의 `last_error`는 건드리지
  않는다(노트 자체는 이미 성공했으므로).

### 2.7 실패 기록

`finish_run_now`가 어댑터 에러 또는 부분 ingest 실패를 `repo::collect::record_result(conn, id,
"ok"|"error"|"partial", error_msg)`로 기록한다 — `last_run_at`/`last_status`/`last_error`를 한
번에 갱신한다. 부분 실패(일부 항목만 실패)는 `ingest_error_message`가 실패한 guid+에러를 join한
메시지를 만들고, 성공한 항목은 그대로 `added` 카운트에 반영된다(전부 실패가 아니면 성공분은
유지 — 롤백하지 않는다).

**`"partial"`(백필 이어받기, §2.8)** — 실패는 0건이지만 `browser_history` 소스가 이번 run에서
`VISIT_LIMIT`(500)개를 정확히 채워 돌려줬을 때만 기록된다: History에 아직 더 가져올 방문이
남아있다는 신호다. `repo::collect::is_due`가 `last_status == "partial"`이면 주기/
`ON_OPEN_SENTINEL`과 무관하게 즉시 due로 판정해, 사용자가 기본 60분 주기를 다 기다리지 않고
다음 60초 tick에 바로 이월분을 마저 받는다. 500건 미만이면 평소처럼 `"ok"`.

### 2.8 로컬 가져오기 — AI 세션 프롬프트 · 브라우저 기록 (`PLAN-2026-09-04-local-import.md`)

**프롬프트 어댑터(`collect/claude_prompts.rs`, `collect/codex_prompts.rs`)**

- 경로: Claude는 `~/.claude/projects/<프로젝트 디렉터리>/<세션>.jsonl`(루트 바로 아래 첫
  서브디렉터리 이름 = 프로젝트), Codex는 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`(날짜별
  디렉터리라 프로젝트는 각 세션 첫 줄 `session_meta.payload.cwd`의 마지막 경로 성분에서 뽑는다).
  두 루트 다 `config.rs::resolve_dir_under_root`가 `..` 순회와 심링크 우회를 거부해 그 루트
  밖을 못 벗어난다.
- 관심 있는 줄만: Claude는 `type=="user"` && `message.role=="user"`, Codex는
  `type=="response_item"` && `payload.type=="message"` && `payload.role=="user"` — 그 외
  이벤트(assistant 응답·도구 결과·큐 오퍼레이션·Codex의 `event_msg` 에코 등)는 애초에 스키마를
  안다고 가정하지 않고 건너뛴다. 노이즈 필터(`is_noise`)도 별도: Claude는 `<command-name>`·
  `<local-command`·`[Request interrupted`·100자 이상 `system-reminder` 4가지, Codex는 세션
  첫 응답이 항상 앱 주입 `<environment_context>` 블록이라는 것 하나뿐.
- **오늘 포함**: seen이 이제 (project,date) 항목이 아니라 프롬프트 줄(part) 단위라, 그날 계속
  자라는 세션도 더 이상 뺄 필요가 없다 — 새 줄이 생기면 새 part guid로 그때그때 append된다
  (예전엔 "오늘 묶음을 seen 처리하면 이후 프롬프트가 영영 안 들어온다"는 이유로 오늘을 통째로
  제외했었다).
- **`backfill_days`**(기본 14, 1~365 클램프 — `config.rs`, `{}`로도 파싱됨): 그보다 오래된
  날짜(`YYYY-MM-DD` 문자열 비교)의 프롬프트는 건너뛴다. 첫 실행이 세션 히스토리 전체(관측:
  Claude 71개·Codex 228개 day-note)를 한 번에 인박스로 쏟은 실기 결함의 수정 — `min_seconds`/
  `backfill_days` 클램프 관례와 같은 자세(거부 대신 문턱 안으로).
- **mtime 스킵**: `CollectCtx.since`(= `source.last_run_at`)가 있으면 그보다 **하루 더 오래된**
  mtime인 JSONL 파일은 통째로 건너뛴다 — seen이 정본 판정이고 이건 순전히 IO 절약이다(파일이
  그 이후로 안 바뀌었으면 이미 본 줄들만 들어있을 것). `since`가 없으면(첫 실행) `backfill_days`
  문턱만 적용된다(그 이후로 안 바뀐 파일은 안에 든 날짜도 전부 cutoff 이전일 수밖에 없다) —
  두 문턱 중 더 최근 쪽을 쓴다(OR 조건은 max와 동치).
- **같은 분 중복 제거**: 같은 (project,date) 묶음 안에서 렌더된 줄("- HH:MM 텍스트")이 앞서 나온
  줄과 완전히 같으면 뒤엣것을 버린다 — 초 단위만 다른 채로 같은 텍스트가 두 번 로그되면 part
  guid는 타임스탬프가 섞여 달라 seen만으로는 못 거르지만, 노트에는 똑같은 줄 두 개로 보이는
  걸 막는다. 정렬·중복 제거가 끝난 뒤에 `body_md`/`parts`를 만들어 둘이 항상 일치한다.
- **part guid 공식**: `claude:<project>:<date>:<sha256(원본 타임스탬프+텍스트)[..16]>`(Codex는
  접두사만 `codex:`) — `item.guid`(= `claude:<project>:<date>`, 미클레임)와는 다른 키다. 16
  hex(64bit)는 같은 (project,date) 묶음 안에서 충돌 걱정이 사실상 없다(`sha256_hex16`,
  `collect/mod.rs`).
- 파일 크기 상한 `MAX_FILE_BYTES = 500MB`(로컬 파일이라 RSS 스트리밍 상한 3MB보다 훨씬 여유 —
  옛 50MB 상한은 이 PC 실측 125MB/102MB/65MB Claude 세션·15개 초과 Codex 세션을 조용히 통째로
  삼켰다). 그래도 넘거나(권한 등으로) 열 수 없는 파일은 부분 파싱하지 않고 여전히 통째로
  스킵하지만, 이제 조용히 사라지지 않는다 — 그 파일 mtime의 로컬 날짜(내용을 못 읽으므로 근사치)
  노트에 `- (건너뜀) 세션 파일 1개가 너무 커서 읽지 않았습니다 (NNNMB)` 줄 하나가
  `skip_notice_part`(`collect/mod.rs`, claude/codex 공유)로 붙는다. guid가 파일 경로 해시라
  파일이 그대로면(계속 너무 크면) 재실행마다 같은 줄이 중복 붙지 않는다. Codex는 프로젝트명이
  파일 내용(session_meta.cwd)에서 나오는데 그 파일을 못 여니 `unknown` 프로젝트로 남는다.
- `project` config 필드로 프로젝트명 부분일치 필터, `dir` config 필드로 표준 루트 아래 하위
  경로 override(둘 다 `deny_unknown_fields` 스키마, `collect/config.rs`).

**브라우저 기록 어댑터(`collect/browser_history.rs`, Windows 전용)**

- 지원 브라우저 5종(`chrome`\|`edge`\|`brave`\|`vivaldi`\|`whale`, `config.rs`가 그 외는 거부):
  전부 크로미움 기반이라 History sqlite 스키마가 같다. 경로는
  `%LOCALAPPDATA%/<vendor>/<app>/User Data/<profile>/History` — Chrome은
  `Google/Chrome`, Edge는 `Microsoft/Edge`, Brave는 `BraveSoftware/Brave-Browser`, Whale은
  `Naver/Naver Whale`. **Vivaldi만 예외**로 앱 이름 서브폴더가 없다(`Vivaldi/User Data` 그대로,
  `browser_user_data_subpath`). Windows가 아니면
  `AppError::Validation("browser history import is Windows-only")`로 즉시 거절.
- Chrome/Edge 등이 실행 중이면 History 파일을 잠그므로, `data_dir/tmp/history-<uuid>.db`로
  복사한 뒤 그 사본을 `SQLITE_OPEN_READ_ONLY`로 연다. 복사본은 `TempCopyGuard`(Drop)가 함수를
  빠져나갈 때(정상 반환이든 `?` 조기 반환이든) 항상 지운다. **강제 종료로 못 지워진 복사본**은
  `collect::start` 부팅 시 1회 `browser_history::cleanup_stale_temp_copies`가
  `data_dir/tmp/history-*.db` 패턴으로 훑어 지운다.
- **손상된 복사본 재시도**: Chrome이 쓰는 도중 복사됐거나 디스크 오류로 sqlite 헤더가 깨지면
  ("malformed"/"not a database" 에러 메시지) `with_corrupt_copy_retry`가 한 번 더 재복사해
  재시도한다 — 그래도 실패하면 그 에러를 그대로 표면화(2회 초과 재시도 없음).
- 질의: `visits JOIN urls`, `hidden = 0`, `visit_duration >= min_seconds * 1_000_000`(µs),
  `visit_time > max(since - 1일, now - backfill_days)`, `visit_time DESC LIMIT 500`
  (`VISIT_LIMIT` — **최신순**으로 캡을 건 뒤 다시 `visit_time` 오름차순으로 정렬해 노트 줄
  순서는 시간순을 유지한다. 초과분은 이번 run에서 seen 처리가 안 되므로 다음 run이 자연히
  이어받는다 — 단, 잘려나가는 건 **오래된 쪽**이다: 사용자는 최신 며칠을 먼저 보고 싶어하고,
  이월된 과거 방문은 다음 run에서 자연히 채워진다. 예전엔 `ASC LIMIT`이라 500건을 넘기면
  거꾸로 최신 날짜가 통째로 잘려나가는 결함이 있었다 — 실기 스모크테스트에서 첫 run이
  08-29~09-03만 채우고 09-04/09-05는 두 번째 run에야 들어온 것으로 발견).
  config 클램프: `min_seconds`는 5~600초, `backfill_days`는 1~90일(`config.rs`, 극단값을
  넣어도 소스 등록 자체는 성공하고 문턱 안으로 조용히 맞춰진다).
  **VISIT_LIMIT을 정확히 채운 run은 `last_status = "partial"`로 기록된다**(§2.7) — History에
  더 가져올 방문이 남아있다는 신호라, `repo::collect::is_due`가 이 상태를 60분 기본 주기와
  무관하게 다음 tick(최대 60초 뒤)에 바로 다시 잡히게 한다. 미만이면 평소처럼 "ok".
- Chrome 시각 변환: Chrome/WebKit epoch(1601-01-01 UTC)는 Unix epoch보다 11,644,473,600초
  앞선다 — `chrome_us / 1_000_000 - 11_644_473_600`로 유닉스초로 뒤집는다.
- 필터: 검색결과 4종 정규식(Google/Bing/DuckDuckGo/Naver)과 제외 도메인 판정은
  `collect/urlfilter.rs`가 소유한다(2026-09-09 익스텐션 철수 전에는 `sync_server::ingest`의
  방문 기록 경로와 공유했다). `http`/`https` 스킴이 아닌 URL(`chrome://` 등)도
  제외. **URL 스크럽**: 노트에 적히기 전 `urlfilter::scrub_url`이 `token`/`access_token`/
  `session`/`password`/`oauth_*` 등 자격증명 성격 쿼리 파라미터를 없앤다(`q` 등 일반 파라미터는
  유지, F-C16).
- 출력은 날짜별 항목 하나(`title = "브라우징 기록 — YYYY-MM-DD"`,
  `urlfilter::VISIT_NOTE_TITLE_PREFIX`) — 같은 날짜면 한 노트에 합쳐진다(Q1). 줄 형식은
  `- HH:MM [제목](url) · N분`
  (`urlfilter::link_label`/`humanize_seconds` 공유, 60초 미만은 "N초"). part.guid =
  `visit:<browser>:<profile>:<visits.id>`, `dedupe_needle = "(url)"` — 같은 URL을 재방문해
  `visits.id`(=guid)가 달라져도 dedupe_needle이 겹치면 줄은 안 붙고 클레임만 된다(§2.5).

**설정 화면 진입점 — 프리셋 버튼 2개(`CollectSection.tsx`)**

"소스 추가" 옆에 고정 버튼 두 개가 있다: **"AI 대화 가져오기"**는 `claude_prompts`+
`codex_prompts` 소스가 없으면 `post_process="summary"`·주기 "창 열 때"(0)·인박스로 만들고,
**"브라우저 기록 가져오기"**는 `browser_history` 소스가 없으면 `{browser:"chrome",
profile:"Default", min_seconds:15, backfill_days:7}`·`post_process="none"`으로 만든다. 둘 다
있으면 생성 없이 그대로, 어느 쪽이든 만든 직후(또는 이미 있으면 곧바로) `collect_source_run_now`를
호출해 즉시 1회 실행하고 토스트로 "N건 수집"을 띄운다(실패하면 건수 대신 에러 문구). 노트
위치는 토스트가 아니라 활동 이력이 담당한다(§2.5의 run당 1행). 챗 자연어 등록도 두 kind를
인식한다(F-C11).

**로컬 소스 감지·가져오기(`collect/detect.rs`, W7, F-C15)**

`collect_detect_local`(순수 조회)은 크롬/엣지/브레이브/비발디/웨일의 프로필별 `History`(있는
것만, 표시 이름은 `Local State`의 `profile.info_cache[dir].name` → 없으면 dir명)와 클로드/코덱스
세션 로그 루트(존재하는 것만)를 훑어 `LocalCandidate[]`를 반환한다 — 브라우저는 최근 7일·15초
이상 방문 수(`browser_history::open_temp_readonly_copy` 재사용), 프롬프트는 mtime 14일 이내
파일만(최대 200개) 열어 줄 수를 센다(1.2GB 전체 파싱 없음). 순서는
크롬(Default 먼저)→엣지→브레이브→비발디→웨일→클로드→코덱스, 비Windows는 브라우저 후보 없음.
각 후보의 `source_id`는 같은 kind(프롬프트) 또는 같은 browser+profile(브라우저) 소스가 이미
있으면 채워진다. `collect_import_local(key)`은 그 후보를 1클릭 등록 — 이미 있으면 그 소스를
그대로 반환(멱등), 없으면 평평한 고정 폴더("수집 — AI 대화" / "수집 — 브라우징",
`repo::folders::ensure_named_folder_id`)를 찾거나 만들어 주기 "창을 열 때"(0)로 소스를
생성한다. **이 두 고정 폴더는 처음 만들어질 때 `search_excluded = 1`로 시작한다**(F-C15) —
하루치 방문/프롬프트 노트가 계속 append되는 소음성 폴더라 일반 검색 결과를 채우지 않게 하려는
기본값. 사용자가 폴더 UI에서 직접 검색 포함으로 되돌리면 이후 `ensure_named_folder_id`가 같은
이름으로 다시 찾아 써도 그 선택은 건드리지 않는다(기존 폴더는 절대 재설정하지 않음).

**첫 부팅 자동 감지 + 뱃지(§3b, PLAN-2026-09-04-local-import)** — 위 감지를 사용자가 직접
누르지 않아도, 앱 부팅 5초 후 `App.tsx`의 이펙트(`lib/collectDetectOnce.ts`)가 `collect_detect_seen`
설정이 아직 false면 `collect_detect_local`을 딱 한 번 무음(`callSilent`, 실패해도 토스트 없음)으로
불러 `source_id`가 없는 후보 개수를 `collect_detect_pending`에 저장한다. 설정 > 수집 레일
항목이 그 숫자를 뱃지로 보여준다(0이면 평범한 라벨). 수집 페이지를 한 번이라도 열면
(`CollectSection` 마운트) `collect_detect_seen=true`·`collect_detect_pending=0`이 되어 뱃지가
사라지고 이후 부팅에서는 자동 감지 자체가 다시 돌지 않는다 — 감지 결과 목록 위에는 "읽기
전용으로 훑었을 뿐 아직 아무것도 저장하지 않았다"는 신뢰 문구가 항상 먼저 뜬다.

## 3. 데이터 모델

`collect_sources` 테이블(핵심 컬럼, `repo/collect.rs::CollectSource`):

| 컬럼 | 의미 |
|---|---|
| `kind` | `rss` \| `web` \| `youtube` \| `claude_prompts` \| `codex_prompts` \| `browser_history` |
| `config` | kind별 엄격한 JSON 문자열(`deny_unknown_fields`) — 스키마는 `collect/config.rs` |
| `enabled` | 러너 대상 여부 |
| `dry_run` | true면 러너/실행 경로 모두 진짜 쓰기를 거부(§2.3) |
| `target_folder_id` | NULL이면 인박스 |
| `post_process` | `none` \| `suggest` \| `summary`(§2.6) |
| `post_process_model` | AI 모델 오버라이드(선택) |
| `interval_minutes` | NULL이면 config JSON 폴백 → 기본 60분, 최소 15분 |
| `last_run_at` / `last_status` / `last_error` | `record_result`가 갱신 |

`collect_seen(source_id, guid)` 복합 PK — 중복 방지 전용, 다른 컬럼 없음.

각 kind의 config 스키마(`collect/config.rs`, 전부 `#[serde(deny_unknown_fields)]`):
- `RssConfig { url, interval_minutes? }`
- `WebConfig { url }`
- `YoutubeConfig { url }`
- `ClaudePromptsConfig { project?, dir?, backfill_days=14 }` — `dir`는 `~/.claude/projects`
  아래로만 강제(`resolve_claude_projects_dir`가 `..` 순회와 심볼릭 링크 우회를 둘 다 거부).
  `backfill_days`는 1~365로 클램프(§2.8).
- `CodexPromptsConfig { project?, dir?, backfill_days=14 }` — 같은 자세, `dir`는
  `~/.codex/sessions` 아래로만 강제(`resolve_codex_sessions_dir`). `project`는 세션의
  `session_meta.payload.cwd`에서 뽑은 이름에 대한 부분일치 필터일 뿐, 디렉터리 구조와는
  무관하다(§2.8).
- `BrowserHistoryConfig { browser?, profile?, min_seconds?, backfill_days? }` — 전부 기본값
  있음(`chrome`/`Default`/15/7). `browser`는 `"chrome"`\|`"edge"`\|`"brave"`\|`"vivaldi"`\|
  `"whale"`만 허용, 그 외는 거부. `min_seconds`는 5~600, `backfill_days`는 1~90으로 클램프
  (거부 대신 조용히 문턱 안으로, §2.8).

URL 필드는 `validate_url`이 http(s) + 호스트 존재 + loopback/사설 IP 거부(`web_reader::ip_is_internal`
재사용) + username/password 금지를 검사한다. 이 검증은 소스 생성/수정(`normalize_value`)과 각
어댑터의 실제 fetch(RSS는 리다이렉트 매 홉마다 `guard_public_host` 재검사) 양쪽에서 이뤄진다.

## 4. 핵심 코드 경로

| 관심사 | 파일 |
|---|---|
| 러너(tick·due·락 분리·ingest·guid 클레임) | `src-tauri/src/collect/mod.rs` |
| RSS/Atom 파싱 | `src-tauri/src/collect/rss.rs` |
| 웹페이지 어댑터 | `src-tauri/src/collect/web.rs` |
| yt-dlp 사이드카·VTT 정제 | `src-tauri/src/collect/ytdlp.rs` |
| Claude 세션 프롬프트 어댑터 | `src-tauri/src/collect/claude_prompts.rs` |
| Codex CLI 세션 프롬프트 어댑터 | `src-tauri/src/collect/codex_prompts.rs` |
| 브라우저 기록(History sqlite) 어댑터 | `src-tauri/src/collect/browser_history.rs` |
| 방문 줄 형식·검색결과/제외 도메인 필터·URL 스크럽 | `src-tauri/src/collect/urlfilter.rs` |
| `summary` 후처리(프롬프트 요약 upsert) | `src-tauri/src/collect/summary.rs` |
| kind별 config 스키마·검증 | `src-tauri/src/collect/config.rs` |
| CRUD·자연어 추가·지금실행/드라이런·yt-dlp 설치 상태/온디맨드 설치 커맨드(락 분리) | `src-tauri/src/commands/collect.rs` |
| `collect_sources`/`collect_seen` 테이블 접근 | `src-tauri/src/repo/collect.rs` |
| 수집 후처리 제안 삽입 | `src-tauri/src/repo/suggestions.rs::insert_collect_post_process` |
| 설정 UI(목록·폼·NL 추가·드라이런 모달) | `src/components/settings/CollectSection.tsx` |
| 기능 카탈로그(케이스별 기대값) | `specs/features/collect.yaml` |

## 5. 알려진 한계 / 결정

- **`collect_seen` 은 지우지 않는다**(2026-09-07 결정, ponytail). 브라우저 기록이 하루 500건이면 연 18만 행 ≈ 10MB 로
  PK 조회 성능에 영향이 없고, 스윕하려면 시각 컬럼 마이그레이션이 필요하다. 소스 삭제가 유일한 정리 경로다.
  업그레이드 경로: `created_at` 컬럼을 더한 뒤 `backfill_days + 30일` 보다 오래된 행만 지운다(그 밖은 재수집 위험).

- **수집 기본값 OFF (D2)** — `default_settings`의 `collect_paused_until`을 far-future로 시드하여 새 DB에서는 수집이 기본 비활성. 이미 시드된 기기는 영향 없음. 마이그레이션 없음.
- **메일 수집은 범위 밖** — `PLAN-2026-08-23-collect-advanced.md` §4 "별도 단계, 이번 계획 밖".
- **주기 하한 15분** — 더 짧은 폴링은 지원하지 않는다(ponytail: 60초 tick 러너 자체가 그보다
  촘촘한 정밀도를 보장 못함).
- **어댑터 확장은 `collect_for_kind`의 match 팔 하나 추가** — 트레이트 오브젝트 도입은 kind가
  더 늘어나기 전까지 보류(ponytail 주석, `collect/mod.rs` 파일 헤더).
- **수동 폼에서 kind=youtube에 채널 URL을 넣으면 여전히 단일영상 어댑터가 받아 타임아웃으로
  실패한다** — UI 힌트("유튜브 영상 URL")와 전용 "유튜브 채널" 유형으로 유도만 하고,
  `collect_source_create` 서버 측 채널형 URL 거부는 넣지 않았다(자연어 등록 경로는
  `rewrite_youtube_channel_draft`가 자동 수리). 실사용 오류가 관찰되면 config 검증에 arm 추가.
- **유튜브 자막 보강은 watch URL만** — shorts/재생목록 항목은 보강 대상 밖(`is_youtube_url`의
  ponytail 주석 참고).
- **온디맨드 설치 동의 게이트는 kind='youtube' 소스에만 걸린다** — §2.4a의 rss 채널 자막
  보강은 별도 게이트를 타지 않는다(설정 UI에 그 경로용 명시적 버튼이 없다). yt-dlp가
  미설치 상태에서 보강이 시도되면 `fetch_subtitles`가 실행 가능한 에러로 실패하고, §2.4a가
  이를 다른 fetch 실패와 동일하게 취급해 피드 설명을 그대로 ingest한다(조용한 성능 저하,
  크래시나 사용자 노출 에러 없음) — 실사용에서 자막 보강이 자주 걸리면 이 경로에도 동의
  트리거를 추가할 수 있다.
- **RSS는 guid/link 없는 항목을 스킵**하고 카테고리·저자·enclosure 등 부가 필드는 파싱하지
  않는다 — 필요해지면 `rss.rs`의 필드 매치에 arm 추가.
- **yt-dlp 자기업데이트는 "다음 실행"에만 반영** — 자막 fetch는 디스크에 이미 있는 바이너리만
  쓴다(업데이트 스레드와 fetch가 동시에 같은 바이너리를 쓰지 않게 하는 설계).
- **`effective_interval_minutes`(config JSON 폴백)는 레거시 호환용** — 주기는 지금 전용 컬럼
  (`interval_minutes`)으로 승격됐고, 이 함수는 컬럼이 없는(구버전) 행을 위해 남아 있다.
- **"브라우저 기록 가져오기" 프리셋은 Chrome 고정, 계획서와의 차이** —
  `PLAN-2026-09-04-local-import.md` Q1은 이 버튼이 Chrome이 있으면 Chrome, 없으면 Edge를
  고르도록 정했지만, 실제 `CollectSection.tsx::presetImportBrowser`는 브라우저 존재 여부를
  확인하지 않고 항상 `browser: "chrome"`으로 소스를 만든다(§2.8). Edge만 설치된 기기에서는
  프리셋 대신 수동 폼(브라우저 select에 Edge 옵션 있음)을 써야 한다.
- **브라우저 기록 어댑터는 macOS/Linux 경로가 없다** — Windows가 아니면 즉시
  `AppError::Validation`으로 거절(§2.8). `PLAN-2026-09-04-local-import.md` §5가 남긴 것.
- **브라우저 기록에는 `summary` 후처리가 없다** — 프리셋이 `post_process: "none"`으로 고정
  생성한다(§2.8). "하루 뭘 읽었나" 요약은 프롬프트 요약이 자리 잡은 뒤로 미뤄졌다
  (`PLAN-2026-09-04-local-import.md` §5).
