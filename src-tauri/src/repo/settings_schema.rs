// 설정 스키마 런타임 정책 (R4 분리: db/migrations.rs에서 이동) — 기본값 시드/settings_set 검증.
// = 노트북 용어 무관, 순수 설정 키 스키마. SSOT 키 목록은 db/schemas/settings.sql 주석.
// 함정 3(CLAUDE.md): 새 설정 키는 validate_setting에 arm을 추가하지 않으면 저장이 조용히 실패한다.
use crate::error::{AppError, AppResult};

/// 기본 설정 값 (JSON 인코딩). 키 목록 SSOT: db/schemas/settings.sql 주석.
pub fn default_settings(active_workspace_id: &str) -> Vec<(&'static str, String)> {
    vec![
        // E5-a: 신규 설치 기본값은 "시스템 따름". 기존 사용자는 이미 저장된 값이 있으므로
        // 영향 없다(시드는 키가 없을 때만 쓰인다). 프런트의 첫 페인트 짝은
        // lib/appearance.ts::defaultSeed() 와 index.html 인라인 스크립트.
        ("theme", "\"system\"".to_string()),
        ("accent", "\"#9cc5a4\"".to_string()),
        ("font_scale", "1".to_string()),
        // 2026-09-09: 기본 글꼴 serif → 번들 Pretendard(오너). 시드는 키가 없을 때만 쓰이므로
        // 기존 설치는 migrations.rs::V78_SQL 이 한 번 옮긴다.
        ("font_family", "\"pretendard\"".to_string()),
        // PLAN-2026-10-27-fonts Q2/Q3 — 노트 본문 글꼴(빈 값 = font_family 를 따름)과 코드체.
        ("font_editor", "\"\"".to_string()),
        ("font_mono", "\"source-code-pro\"".to_string()),
        ("bg_dim", "0".to_string()),
        ("bg_tone", "0".to_string()),
        // PLAN-2026-09-12 §3/E3: 배경 채도 슬라이더. 0 = 채도 없음 = 지금까지의 화면과 픽셀
        // 동일이다(프런트 lib/appearance.ts::saturateCanvas 가 0 에서 입력을 그대로 돌려준다).
        ("bg_sat", "0".to_string()),
        // PLAN-2026-09-12 §5/D6: 본문(.content-canvas) 전용 틴트 슬라이더. 값은 **부호 있는
        // 오프셋**이라 0 = 지금까지의 화면 그대로다 — 자세한 의미는 아래 validate_setting arm 주석.
        ("content_tint", "0".to_string()),
        ("surface_style", "\"flat\"".to_string()),
        ("sheet_alpha", "0.85".to_string()),
        ("ai_provider", "\"ollama\"".to_string()),
        ("ai_endpoint", "\"\"".to_string()),
        ("ai_enabled", "false".to_string()),
        // PLAN-2026-08-30 §6-A: 전역 AI 정책 사다리(gather<refine<organize, §2 의 3계층과 값이
        // 같다) — 이 레벨을 넘는 커맨드는 commands::ai::ai_gate_and_key /
        // require_ai_policy_level 에서 거부된다. 기본 "organize"(가장 넓음) = 기존 동작 유지,
        // 회귀 없음(오너 확정). 정책을 낮춰도 개별 토글(ai_post_process 등)의 저장값은 지우지
        // 않는다 — 정책은 "덮개"일 뿐이다(프런트 lib/aiCapabilities.ts::isTierAllowed).
        ("ai_policy_level", "\"organize\"".to_string()),
        // PLAN-2026-09-27 §7.1 & Q5(b): 엔진 지침(관계도/시트 JSON 규칙, 에이전트 계획, 메타데이터 기준 등) 재정의 맵.
        ("ai_internal_instructions", "{}".to_string()),
        ("ai_post_process", "true".to_string()),
        // PLAN-2026-08-30 §3 W2: 사이드바 챗에서 사실을 추출해 chat_memory 에 자동 저장하는
        // 기능의 킬 스위치. 기본 ON(다른 자동 기능들과 동일한 관례) — lib/chatMemoryExtractor.ts
        // 가 이 키가 false 면 추출 자체를 건너뛴다.
        ("ai_chat_memory", "true".to_string()),
        // PLAN-2026-09-05 §2 B-4: 어시스트 AI 결과를 노트에 삽입/교체하기 전에 AiResultModal 로
        // 사람이 확인하는 게이트. 기본 ON — 끄면 현행처럼 즉시 삽입(반복 작업 사용자용 킬 스위치).
        ("ai_confirm_before_apply", "true".to_string()),
        // PLAN-2026-09-27 §7-4: 어시스트 패널 AI 프리셋 클릭 시 모달 열린 직후 바로 실행할지 여부. 기본 OFF.
        ("assist_preset_autorun", "false".to_string()),
        // PLAN-2026-09-05 §3 C-3: AI 호출 로그(ai-calls.jsonl)에 프롬프트/응답 앞 2000자를 함께
        // 남긴다. 기본 OFF — 켜면 노트 내용이 로그 파일에 기록되므로 디버그 때만.
        ("ai_debug_verbose", "false".to_string()),
        // PLAN-2026-08-30 §4 W7 — FeatureBriefModal "본 브리핑" id 목록. 빈 배열 = 아직 아무
        // 브리핑도 못 봤고 소급 시딩(useFeatureBrief.ts)도 아직 안 돌았음. 시딩이 돌면 여기에
        // sentinel(lib/featureBriefs.ts::FEATURE_BRIEF_SEED_SENTINEL)이 얹힌다 — 별도 "시딩
        // 완료" 키를 새로 만들지 않기 위해서다.
        ("seen_feature_briefs", "[]".to_string()),
        // PLAN-2026-09-01 W0 — 챗이 수집 소스를 등록하는 경로의 킬 스위치. 기본 OFF: 사용자가
        // 문장 하나로 부르면 IPC 가 소스를 만들어 이후 자동으로 도는 구조라, ai_chat_memory 처럼
        // "부르지 않아도 도는 것"에 준해 옵트인으로 둔다. 실효 게이트는 프런트
        // lib/chatPipeline.ts 의 add_collect_source 분기 한 지점.
        ("collect_chat_register", "false".to_string()),
        // PLAN-2026-09-01 W0 — 노트 진행 상태(workspace_statuses)에 새 상태를 추가하는 진입점
        // 잠금. 기본 OFF(=추가 가능, 지금까지의 동작). 켜면 사이드바 필터·대시보드 상단의 "+"
        // 진입점이 숨고 stores/taxonomy.ts::addStatus 가 IPC 를 쏘지 않는다 — 내장 3종
        // (lib/status.ts::BUILT_IN_STATUSES)과 기존 커스텀 상태의 개명·삭제는 영향받지 않는다.
        ("status_add_locked", "false".to_string()),
        // 대시보드 탭별 설정(PLAN-2026-10-27 W3b, 2026-10-28) — 전부 앱 전역(status_add_locked 와 같은 부류).
        // 타임라인 첫 화면 범위: fit(노트에 맞춤, 지금까지의 동작) | around_now(올해 ±1) | recent_3m | recent_1y.
        ("timeline_default_range", "\"fit\"".to_string()),
        // 칸반 완료 카드 자동 숨김: off | 7d | 30d (완료 열에서 updated_at 이 이보다 오래된 카드).
        ("board_done_autohide", "\"off\"".to_string()),
        // 칸반 카드 표시 요소 — 기본 모두 보임(지금까지의 동작).
        ("board_card_thumb", "true".to_string()),
        ("board_card_date", "true".to_string()),
        // 관계 탭: 연결 없는 노트 숨기기, 노드 수 상한(0 = 서버 기본 500).
        ("graph_hide_isolated", "false".to_string()),
        ("graph_node_cap", "0".to_string()),
        // 내보내기 저장 대화상자가 처음 여는 폴더(2026-10-28). 빈 문자열 = 지정 안 함(대화상자 기본).
        ("export_default_dir", "\"\"".to_string()),
        // 사이드패널 갤러리(설정 › 첨부파일, 2026-10-28): 타일 크기 / 정렬 / 파일 이름 상시 표시. 앱 전역.
        ("gallery_tile_size", "\"medium\"".to_string()),
        ("gallery_sort", "\"newest\"".to_string()),
        ("gallery_show_names", "false".to_string()),
        ("ai_api_key", "\"\"".to_string()),
        // 프로바이더별 크리덴셜 보관함(오너: "키를 비우면 안 된다"). 활성 프로바이더의 값은 여전히
        // ai_api_key/ai_endpoint 하나뿐이고, 여기는 **비활성** 프로바이더의 키·엔드포인트를 바꿔 끼울
        // 때 넣어 두는 자리다(프런트 lib/aiProviderSwitch.ts 가 유일한 작성자). ai_api_key 와 같은
        // 비밀이라 export::is_secret_setting_key 에 있고, 앱 전역이다(NOTEBOOK_KEYS 아님).
        ("ai_provider_creds", "{}".to_string()),
        ("ai_model", "\"\"".to_string()),
        // 1회 폴백 모델(2026-08-05). 빈 값 = "설정 안 함" — gemini 는 그때
        // repo::ai::DEFAULT_GEMINI_FALLBACK_MODEL 로 떨어진다(오너 고정 조합), 나머지
        // 프로바이더는 폴백 없이 원래 오류를 그대로 낸다.
        ("ai_model_fallback", "\"\"".to_string()),
        ("ui_lock", "false".to_string()),
        ("sidebar_collapsed", "false".to_string()),
        ("favorites_open", "true".to_string()),
        ("left_width", "300".to_string()),
        ("source_pct", "25".to_string()), // 2026-08-20: 어시스트 기본 폭 축소(50→25) — 에디터가 주인공
        ("source_original_policy", "\"ask\"".to_string()),
        ("ui_lang", "\"ko\"".to_string()),
        // 빈 배열 = "저장된 적 없음" — 프런트가 canonical 순서(region/timeline/advanced/gallery/
        // calendar) 전부 활성으로 폴백한다(settings.ts::defaultFilterRoster). recent_color_hues
        // 와 같은 패턴(빈 배열 시드 + 프런트 폴백), 기본값을 두 곳에 중복 정의하지 않는다.
        ("filter_roster", "[]".to_string()),
        // §2.6: 새 DB는 온보딩을 아직 안 거쳤으므로 false. 기존 사용자가 이 필드가 새로 생긴
        // 버전으로 업그레이드하는 경우도 settings 테이블에 값이 없으니 이 기본값(false)을 받는데,
        // 이미 앱을 쓰고 있던 사용자에게도 마법사가 뜨는 게 맞는지는 §2.6 구현 시점에 결정할 것 —
        // 지금은 "새 DB든 기존 DB든 값이 없으면 온보딩 안 한 것"으로 단순하게 둔다.
        ("onboarding_completed", "false".to_string()),
        ("spellcheck_enabled", "false".to_string()),
        ("translate_enabled", "false".to_string()),
        ("translate_target_lang", "\"en\"".to_string()),
        // 에디터 너비 토글(Toolbar.tsx chevrons 버튼) — 기본 편안한 모드(false).
        ("editor_full_width", "false".to_string()),
        ("recent_color_hues", "[]".to_string()),
        ("emoji_recent", "[]".to_string()),
        ("emoji_favorites", "[]".to_string()),
        // QA8 Wave 3A — device-local recent search queries (newest first). Cap/promote is
        // frontend-owned; seed empty so get_all always has a typed array for fresh DBs.
        ("search_recent", "[]".to_string()),
        // QA8 Wave 4A — recently closed note tab ids (newest first). Session convenience for
        // "reopen closed tab" (Ctrl+Shift+T); NOT mixed into activity_log. Cap is frontend-owned.
        ("recent_closed_tabs", "[]".to_string()),
        (
            "default_map_location",
            // City-scale k=150 — keep in lockstep with FACTORY_DEFAULT_MAP_ZOOM (settings.ts)
            // and V32_DEFAULT_MAP_CITY_ZOOM (migration raises lower stored zooms to this).
            "{\"lat\":37.5665,\"lng\":126.978,\"zoom\":150.0}".to_string(),
        ),
        // Wave 8 header phrase pack id: "off" | "bundled:…" | "user:…". Frontend defaults to
        // first bundled pack when unset; this seed is the same default for fresh DBs.
        ("phrase_pack_id", "\"bundled:knowledge\"".to_string()),
        (
            "active_workspace_id",
            format!("\"{active_workspace_id}\""),
        ),
        // Settings redesign (Données ①②): 자동 전체 백업(zip) 스케줄. off/daily/weekly, 개수는
        // 1..=5 로 제한(db/mod.rs::maybe_spawn_auto_backup, repo/transfer/backup.rs 참고). 기존
        // 부팅시 DB-only 스냅샷 회전(KEEP_BACKUPS=3, db/mod.rs)과는 별개 — 그건 R3 손상 복구용
        // 안전망이라 그대로 둔다.
        ("backup_auto_interval", "\"weekly\"".to_string()),
        ("backup_auto_keep", "3".to_string()),
        // 앱 데이터(DB+첨부) 용량 알림 한도, GB. 0 = 끔. 프런트가 시작 시 db_stats 와 비교해 넘으면 한 번 알린다.
        ("storage_alert_gb", "0".to_string()),
        // 동기화(beta, docs/SYNC.md 전송 준비): sync_token은 하드코딩 기본값이 아니라 첫 활성화 시
        // sync_set_enabled 커맨드가 new_id()로 생성해 이 빈 문자열 위에 덮어쓴다(빈 토큰은
        // sync_server::handlers::authorized 에서 fail-closed — 아무 요청도 통과 못함).
        ("sync_enabled", "false".to_string()),
        ("sync_port", "7332".to_string()),
        ("sync_token", "\"\"".to_string()),
        // 트레이 상주 — 창을 닫아도 종료하지 않고 숨긴 채 백그라운드 실행(동기화(beta) 서버가
        // 계속 돌 수 있게). 기본 true: X 버튼은 트레이로 숨긴다(지금까지의 무조건 동작과 같은
        // 기본값) — 설정 > 펫 카드의 체크박스로 끄면 X가 실제 종료로 바뀐다(lib.rs::run() 의
        // CloseRequested 핸들러가 매 이벤트마다 이 값을 다시 읽는다).
        ("close_to_tray", "true".to_string()),
        ("week_start", "\"sunday\"".to_string()),
        // 시간축 표현 범위 — 24시 아래에 이어 붙이는 익일 시간(0 = 당일만). 기본 3 = 익일 03시까지(새벽 일정이 잦은 오너 요청,
        // 2026-10-27). 대시보드·사이드바·브리핑의 TimeAxis 가 같은 값을 읽는다.
        ("calendar_axis_tail_hours", "3".to_string()),
        // PLAN-2026-09-15 R2 — "기준 지역 활용" 마스터 토글. 기본 ON("1"): 지금까지의 동작
        // (지도 기본 위치 → 날씨·현지시간·장소명·AI 컨텍스트)이 그대로 유지된다. 끄면 프런트의
        // 한 지점(useWeatherLocation / lib/weather.ts::savedWeatherLocation)이 위치를 안 돌려
        // 주므로 met.no 요청 자체가 없어진다. pet_enabled 와 같은 "0"/"1" 문자열 플래그다.
        ("region_enabled", "\"1\"".to_string()),
        // 달력 공휴일 지역(2026-09-08). "none" 기본 — 켜는 건 사용자 선택(설정 > 보기 > 달력).
        // 데이터는 프런트 정적 표(src/lib/holidays.ts); 백엔드는 값만 보관한다.
        ("holiday_region", "\"none\"".to_string()),
        // W8-g 2단계 노출: 마스터(pet_enabled, 시드 없음 — 위 주석들과 같은 패턴, get_all에
        // 키 자체가 없으면 꺼짐)와 별개로 타이틀바/트레이의 표시·숨기기 상태. pet_enabled 와
        // 달리 이건 시드한다 — 마스터를 처음 켤 때 "기본 보임"이어야 하므로, 키가 아예 없는
        // 상태를 tray.rs::pet_visible_setting 의 fail-open 폴백에만 맡기지 않고 명시적으로
        // "1"을 심는다.
        ("pet_visible", "\"1\"".to_string()),
        // P2 3단계 링크 붙여넣기 후행 제안(docs/PLAN-2026-08-07-second-brain.md Q5): 켜면 에디터에
        // 단독 URL을 붙여넣을 때마다 그 페이지를 백엔드가 fetch 해 요약한다 — "외부 fetch는
        // 프라이버시 게이트 옵트인" 원칙(attachment_fetch_reader의 "명시적 사용자 액션에서만
        // fetch" 규칙의 의도적 예외, 이 옵트인 설정 자체가 그 동의를 대신한다). 기본 OFF. 실효
        // 게이트는 repo::suggestions::link_suggestions_active(ai_enabled && link_suggestions)
        // 한 지점 — commands::suggestions::link_suggest 가 진입 즉시 이 함수만 지난다.
        ("link_suggestions", "false".to_string()),
        // link_suggest 가 요약 생성에 쓸 모델 오버라이드. NULL 이면 전역 ai_model 사용
        // (commands::suggestions::link_proposal). 같은 프로바이더 안에서 모델만 바꿀 수 있게 —
        // 프로바이더 자체는 link_suggestions_active(ai_enabled && link_suggestions) 게이트가
        // 이미 검증한다. 빈 문자열/공백은 NULL 과 동등(소비처 trim 후 빈 값이면 ai_model 폴백).
        // 기본 NULL — 시드하지 않는다(키 없음 = 폴백).
        //
        // PLAN-2026-09-18-nl-dates.md §W4 — 에디터 타이핑 넛지(dateNudge.ts, §W3b)의 완전자동
        // 등록 옵트인. D4 확정: 기본은 "넛지"(칩 확인 후 1키 수락)이고, 이 키를 켜면 칩 없이
        // 캐럿이 매치 범위를 벗어나는 즉시 등록된다(되돌리기 토스트는 그대로 남는다). link_suggestions
        // 와 같은 성격의 옵트인 킬스위치 — 기본 OFF. 실효 게이트는 프런트 dateNudge.ts 단독(이
        // 값은 저장만 담당, 백엔드 다른 경로는 이 키를 보지 않는다).
        ("date_nudge_auto", "false".to_string()),
        //
        // PLAN-2026-09-19-date-region-ui.md §P3 D12 — 지역 사전 매칭 넛지(§P3, Phase B 팝오버)의
        // 강도. 기본 ON(엄격) — 후보 지역명 앞뒤 문자가 한글 음절/영문자/숫자가 아닐 때만(또는
        // 문자열 시작/끝) 매칭으로 친다("경주"가 "경주마"·"불경주의보"에서 안 걸린다). false 면
        // 경계 검사 없는 순수 substring 으로 완화된다. 오너 원문: "주소는 오탐이 잦을거같아서
        // 확실한 부분이 없으면 안나오는게 경험적으로 좋아" — link_suggestions 류 옵트인 킬스위치와
        // 달리 이 키는 "기본으로 꺼진 기능을 켜는" 스위치가 아니라 "이미 켜진(넛지 자체는 항상
        // 도는) 기능의 강도"라 기본이 true 다. 실효 게이트는 프런트 regionDetect.ts 단독(이 값은
        // 저장만 담당).
        ("region_nudge_strict", "true".to_string()),
        //
        // 오너 결정(2026-09-20) — 설정 > 에디터: 날짜/지역 제안을 3단(off/suggest/auto,
        // off/strict/loose)으로 UI 노출하되, 저장은 **불리언 두 개**로 계속 한다(새 enum 키를
        // 만들지 않는다). 이유(WHY): date_nudge_auto/region_nudge_strict 를 불리언 → enum 으로
        // 바꾸면 이 값이 사는 두 테이블(전역 settings, 노트북별 workspace_settings V86) 모두에
        // 마이그레이션이 필요하고, 옛 내보내기 번들·노트북 복제가 나르는 불리언 값과도 깨진다 —
        // 반면 "enabled" 불리언 하나를 앞에 세우면 기존 두 키의 값 모양·의미가 전혀 안 바뀌어
        // 마이그레이션이 필요 없다. off = date_nudge_enabled/region_nudge_enabled 가 false, 이때
        // date_nudge_auto/region_nudge_strict 는 **건드리지 않는다**(다시 켜면 이전 suggest/auto
        // 또는 strict/loose 선택이 그대로 돌아온다) — 프런트 stores/settings.ts 의
        // setDateNudgeMode/setRegionNudgeMode 가 이 계약을 지킨다. 기본 true = 오늘까지의 동작
        // (넛지는 항상 켜져 있었다) 유지.
        ("date_nudge_enabled", "true".to_string()),
        ("region_nudge_enabled", "true".to_string()),
        // 오너 결정(2026-09-20) — 붙여넣기 자동 동작 3종을 각각 토글 가능하게: 단독 URL 붙여넣기
        // 후행 제안(link_suggestions 와는 별개 — 이건 붙여넣기 "행동" 자체의 on/off, link_suggestions
        // 는 그 뒤 AI 요약 옵트인), 파일 경로 붙여넣기 시 인라인 코드 서식, 표 모양 텍스트(TSV/CSV
        // 붙여넣기) 시트 변환 제안. 기본 true = 오늘까지의 동작 유지.
        ("paste_link_nudge", "true".to_string()),
        ("paste_path_inline_code", "true".to_string()),
        ("paste_table_sheet_suggest", "true".to_string()),
        // 오너 결정(2026-09-20) — 마크다운 자동 서식(타이핑 중 `**bold**`/`# heading` 등을 즉시
        // 리치 서식으로 바꾸는 에디터 동작)의 킬 스위치. 기본 true = 오늘까지의 동작 유지.
        ("editor_md_autoformat", "true".to_string()),
        //
        // S2 입력(docs/PLAN-2026-10-06-s2-input.md §1.3) — 폰 사진/음성 입력의 자동 반영 정책, 3단
        // 문자열 "off"|"ask"|"auto". 서버 훅(repo::attachments::exif_region)이 읽으므로 PC 공유
        // 전역 키다(폰 설정 화면에서 바꿀 수 있어 PHONE_SETTINGS_KEYS 에 있다).
        // - photo_meta_mode: 사진 EXIF(GPS·촬영시각)·음성 업로드 메타 → 노트 날짜/경유지. 기본 auto.
        //   off 면 EXIF 읽기·역지오코딩(외부 요청) 자체를 건너뛴다.
        // - voice_transcribe_mode: 녹음 전사 삽입. 기본 auto(실효는 ai_enabled 일 때만 — 그 동의가 SSOT).
        // - voice_cleanup_mode: 전사 블록 정리 프리셋. 기본 off(원문 보존 우선).
        ("photo_meta_mode", "\"auto\"".to_string()),
        ("voice_transcribe_mode", "\"auto\"".to_string()),
        ("voice_cleanup_mode", "\"off\"".to_string()),
        //
        // 오너 결정(2026-09-20, "4~7번도 넣어봐, 보고 이상하면 지울게") — **실험적** 에디터 설정
        // 4종(§4~7). 앞의 6키(바로 위)와 달리 "오늘까지의 동작을 지키는 킬스위치"가 아니라 새
        // 동작/값이라 각자 키 하나·스토어 필드 하나·설정 UI 행 하나로 자기완결시켰다 — 오너가
        // 앱에서 보고 별로면 그 한 줄씩만 들어내면 된다(빼는 김에 이 default_settings 시드 줄,
        // validate_setting arm, stores/settings.ts 의 대응 줄, EditorSection.tsx 행 하나를 함께
        // 지우면 흔적이 안 남는다).
        //
        // link_open_on_click — 링크를 일반 클릭으로 열지, 지금처럼 Ctrl/Cmd+클릭에서만 열지.
        // 기본 false(오늘까지의 동작 유지: Ctrl/Cmd+클릭만 연다). 실효 게이트는 다른 에이전트가
        // 얹는다(이 웨이브는 키·스토어·UI만).
        ("link_open_on_click", "false".to_string()),
        // editor_word_count — 상태줄의 글자 수·단어 수 표시. 기본 **true**: 그 표시는 이 키가 생기기
        // 전부터 늘 보이던 것이라(EditorPanel 상태줄) 기본을 false 로 두면 설정을 만든 것만으로 기존
        // 사용자 화면에서 사라진다 — 이 키는 "새로 켜는" 옵트인이 아니라 "끌 수 있게" 하는 스위치다.
        ("editor_word_count", "true".to_string()),
        // editor_width — 본문 최대 폭. "normal"(기본) = 오늘까지의 800px 상한. editor_full_width 가
        // 켜져 있으면(전체 너비) 이 값은 쓰이지 않는다 — 설정 화면에서 그 상태의 행을 잠근다.
        ("editor_width", "\"normal\"".to_string()),
        // new_note_date_precision — 새 노트가 받는 오늘 날짜의 정밀도. "day"(기본) = 오늘까지의
        // 동작(연·월·일까지). 노트별로 언제든 바꿀 수 있으므로 이 값은 "새로 만들 때의 시작값"만
        // 정한다.
        ("new_note_date_precision", "\"day\"".to_string()),
        // new_note_section_name — 새 노트의 첫 섹션 이름. 빈 문자열(기본) = 백엔드 내장 기본 이름
        // (repo/notes/mod.rs 의 "Overview" 리터럴 — 이 웨이브는 그 파일을 건드리지 않는다, 다른
        // 에이전트가 note 생성 경로를 병행 작업 중이라 참조만 한다).
        ("new_note_section_name", "\"\"".to_string()),
        //
        // collect_excluded_domains — 모든 collection 경로(방문기록·브라우저 클리핑·링크 붙여넣기)
        // 가 공유하는 도메인 차단 목록. capture_visit_excluded_domains 의 상위 호환으로 신설 —
        // visits 채널은 새 키 우선 + 구 키 폴백(read fallback, write 는 새 키만). 형식은
        // capture_visit_excluded_domains 와 동일한 "문자열 배열, 200개 캡, 각 253자" 규칙.
        ("collect_excluded_domains", "[]".to_string()),
        // collect_paused_until — 수집 자동 러너 일시중지 마스터 스위치. ISO-8601 문자열 또는
        // 빈 문자열. 비어있거나 과거 시각이면 정상 동작. 미래 시각이면 crate::collect::run_cycle
        // 이 tick 마다 한 번 읽어 find_due 자체를 건너뛴다(자동 수집만 — "지금 실행" 버튼과
        // visits(크롬 익스텐션 수동)은 영향받지 않는다, 사용자가 명시적으로 트리거한 경로).
        // **기본 OFF 결정(2026-08-31)** — 수집 자동 러너를 기본 일시중지 상태로 시작하기 위해
        // far-future 로 시드한다. 마이그레이션은 없다: db::migrations::seed() 는 워크스페이스가
        // 0개일 때만(신규 DB) 이 값을 실제 행으로 써넣는다. 단, repo::settings::get_all() 은
        // DB에 저장된 행이 없는 키를 항상 이 기본값으로 채우므로, 이 키를 한 번도 명시적으로
        // 설정(토글)한 적 없는 연결은 신규/기존 DB 구분 없이 이 far-future 값을 본다 — 이미
        // 값을 저장해본 기기만 자신의 저장값으로 덮어써 영향받지 않는다.
        ("collect_paused_until", "\"2099-12-31T23:59:59+00:00\"".to_string()),
        // 일정 알림 마스터 스위치(docs/PLAN-schedule-system.md §1.4·§5.5, 2026-08-09 오너 확정).
        // **기본 OFF** — 꺼져 있으면 분 단위 틱(repo::schedule::tick)이 아무것도 쏘지 않고
        // 워터마크만 전진시킨다(나중에 켜도 그동안의 과거가 쏟아지지 않게). 노트별 게이트
        // (notes.remind)와 두 겹이다: 시각만 넣는다고 알림이 울리지 않는다.
        ("notifications_enabled", "false".to_string()),
        // 종일(시각 없는) 노트의 기준 발화 시각. 기본 "00:00"(2026-08-09 확정) — 오프셋을
        // "1일 전"으로 걸면 전날 자정이 되어 산수가 직관적으로 맞는다(09:00 이면 어긋난다).
        ("reminder_all_day_at", "\"00:00\"".to_string()),
        // W10: 사용자 이름 (선택, 최대 64자). 기본 빈 문자열.
        ("user_name", "\"\"".to_string()),
        // 브리핑 창(PLAN-2026-09-30-briefing §3). 전부 기기 전역(NOTEBOOK_KEYS 아님) — 하루 1회 자동 표시는
        // 앱 단위다. 화면 구성 키 5종(briefing_view/presets/layout/cards/options)은 브리핑 재작성으로
        // 은퇴했다(PLAN-2026-10-19-briefing-rewrite §9.1) — 아래 RETIRED_KEYS 참고.
        ("briefing_enabled", "false".to_string()),
        ("briefing_when", "\"time\"".to_string()),
        ("briefing_time", "\"08:00\"".to_string()),
        ("briefing_last_shown", "\"\"".to_string()),
        // W10 저녁 회고·알림 방식(PLAN-2026-09-30-briefing §9).
        ("briefing_evening_enabled", "false".to_string()),
        ("briefing_evening_time", "\"21:00\"".to_string()),
        ("briefing_last_shown_evening", "\"\"".to_string()),
        ("briefing_notify", "\"window\"".to_string()),
        // W7: 브리핑이 마지막으로 "새 항목"을 보여 준 시각(RFC3339, 빈 값 = 없음 → 지금-24h).
        ("briefing_last_seen", "\"\"".to_string()),
        // W18: pet_click_action 삭제 (클릭=채팅 고정). pet_dblclick_action 허용값 chat|new_note|off.
        ("pet_dblclick_action", "\"new_note\"".to_string()),
        // P3 수집 v2: 첨부 저장 모드 ("copy" | "link" | "reference")
        ("attachment_storage_mode", "\"copy\"".to_string()),
        // pptx 슬라이드 미리보기. "auto" = LibreOffice 가 있으면 pdf 로 변환해 보여준다,
        // "off" = 항상 텍스트 폴백. 기본 auto — 변환기가 없으면 어차피 조용히 폴백한다.
        ("slide_preview", "\"auto\"".to_string()),
        // soffice 실행 파일 override. 빈 값이면 PATH → OS 표준 설치 경로 자동 탐지.
        ("soffice_path", "\"\"".to_string()),
        // W13: 챗봇 메모리 (결정 10, 최대 50개)
        ("chat_memory", "[]".to_string()),
        // F-P01 비서/펫 노트 쓰기 게이트. 기본 true — 기존 웹뷰 localStorage 가 fail-open
        // 이었고, 키 없는 구 설치도 켜진 채로 읽어야 업그레이드 직후 갑자기 쓰기가 막히지 않는다.
        ("chat_write_enabled", "true".to_string()),
        // 챗봇 권한: 이전 대화 내용 및 사용자 파일/노트 참조 게이트 (기본 true)
        ("chat_read_history", "true".to_string()),
        ("chat_read_files", "true".to_string()),
        // E4: 자동 업데이트 확인 킬스위치. 기본 true.
        ("update_check_auto", "true".to_string()),
        // reminder_last_tick_at(워터마크)은 **시드하지 않는다** — 부재 = 첫 실행이고, 첫 실행은
        // 과거를 소급 발화하지 않는다(§5.4). window_geometry/pet_pos_* 와 같은 패턴.
    ]
}

/// "모양"(테마) 키 — 설정 › 모양 페이지가 소유하는 키 전부, 그리고 그뿐이다.
/// 초기화·내보내기·불러오기(repo/theme.rs)가 모두 이 목록 하나를 탄다
/// (docs/PLAN-2026-09-19-theme-presets.md §1). 모양 페이지에 새 손잡이를 달면 여기에도 넣는다.
pub const APPEARANCE_KEYS: [&str; 12] = [
    "theme",
    "accent",
    "font_family",
    "font_editor",
    "font_mono",
    "font_scale",
    "bg_dim",
    "bg_tone",
    "bg_sat",
    "content_tint",
    "surface_style",
    "sheet_alpha",
];

pub fn is_appearance_setting_key(key: &str) -> bool {
    APPEARANCE_KEYS.contains(&key)
}

/// 노트북 키 — 노트북을 바꾸면 따라 바뀌고, 노트북과 함께 내보내지는 설정
/// (docs/PLAN-2026-09-19-notebook-settings.md §2 ①, 오너 결정: 노트북마다 완전 격리).
/// 값은 `workspace_settings` 에 노트북별로 살고, `repo::settings::get_all` 이 활성 노트북 값으로
/// 덮어 읽고 `set` 이 활성 노트북에 쓴다 — 소비처는 이 구분을 모른다.
/// 여기 없는 키는 앱·기기 전역이다(비밀·기기 식별·백그라운드 동작·창 배치). 새 키를 만들면 어느
/// 쪽인지부터 정한다 — 기본 방향은 노트북.
///
/// ⚠️ 마이그레이션 V86 이 이 목록의 **그 시점 사본**으로 전역 값을 옮겼다. 목록에 키를 **더할** 때는
/// 기존 전역 값이 노트북으로 넘어가지 않는다(새 마이그레이션이 필요하다) — 새로 만드는 키면 무관.
pub const NOTEBOOK_KEYS: [&str; 50] = [
    // 모양 (= APPEARANCE_KEYS)
    "theme",
    "accent",
    "font_family",
    "font_editor",
    "font_mono",
    "font_scale",
    "bg_dim",
    "bg_tone",
    "bg_sat",
    "content_tint",
    "surface_style",
    "sheet_alpha",
    // 언어
    "ui_lang",
    "spellcheck_enabled",
    "translate_enabled",
    "translate_target_lang",
    "phrase_pack_id",
    // 달력·지역
    "week_start",
    "calendar_axis_tail_hours",
    "holiday_region",
    "region_enabled",
    "region_nudge_enabled",
    "region_nudge_strict",
    "date_nudge_enabled",
    "date_nudge_auto",
    // 편집·보기
    "editor_full_width",
    // 2026-09-20 — 붙여넣기 자동 동작 3종 + 마크다운 자동 서식. 위 date/region 넛지와 같은
    // "에디터가 저 혼자 도는 동작"이라 노트북별(오너 결정: 노트북마다 완전 격리).
    "paste_link_nudge",
    "paste_path_inline_code",
    "paste_table_sheet_suggest",
    "editor_md_autoformat",
    // 2026-09-20 — 실험적 4종(오너: "4~7번도 넣어봐, 보고 이상하면 지울게"). 같은 "에디터가 저
    // 혼자 도는 동작" 부류라 노트북별. 오너가 써보고 빼라고 하면 이 네 줄만 지우면 된다.
    "link_open_on_click",
    "editor_word_count",
    "editor_width",
    "new_note_date_precision",
    "new_note_section_name",
    "filter_roster",
    "link_suggestions",
    "status_add_locked",
    "source_original_policy",
    "slide_preview",
    // AI 행동(연결 — 공급자·키·모델 — 은 전역)
    "ai_enabled",
    "ai_policy_level",
    "ai_post_process",
    "ai_confirm_before_apply",
    "assist_preset_autorun",
    "ai_chat_memory",
    "chat_memory",
    "chat_write_enabled",
    "chat_read_history",
    "chat_read_files",
];

pub fn is_notebook_setting_key(key: &str) -> bool {
    NOTEBOOK_KEYS.contains(&key)
}

/// 없어진 설정 키. 기존 설치의 settings 행은 그대로 남고(get_all 은 무검증이라 무해) export 도
/// 그 행을 번들에 싣는다 — 그런데 번들 가져오기는 validate_setting 을 fail-closed 로 태우므로
/// 이 키 하나 때문에 replace 가져오기가 통째로 거부된다. 가져오기는 이 목록을 조용히 건너뛴다.
/// 키를 없앨 때(arm 삭제) 여기에 한 줄 보탠다.
const RETIRED_KEYS: &[&str] = &[
    // 브리핑 재작성(2026-10-19, PLAN-2026-10-19-briefing-rewrite §9.1) — 블록 격자·프리셋·레거시 화면 구성.
    "briefing_view",
    "briefing_presets",
    "briefing_layout",
    "briefing_cards",
    "briefing_options",
    "canvas_enabled",         // 캔버스 플러그인 제거(2026-09-28)
    "canvas_shortcut",        // 〃
    "header_weather_visible", // D11(2026-09-12)
    "mica_alpha",             // sheet_alpha 로 리네임(2026-07-24)
];

pub fn is_retired_setting_key(key: &str) -> bool {
    RETIRED_KEYS.contains(&key)
}

/// 절대 경로 판정 — OS 와 무관하게 윈도 드라이브("D:\x", "D:/x")·UNC("\\srv\share")·POSIX("/x") 형태를 모두 받는다.
/// `Path::is_absolute` 는 현재 OS 의 문법만 봐서(리눅스 CI 에선 "D:\exports" 가 상대 경로다) 설정 값 검증에 그대로 쓰면 플랫폼마다
/// 결과가 갈린다. 드라이브 상대("C:x")·상대 경로는 거부한다.
fn is_absolute_path_any_os(s: &str) -> bool {
    let b = s.as_bytes();
    s.starts_with('/')
        || s.starts_with("\\\\")
        || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || std::path::Path::new(s).is_absolute()
}

/// 설정 키 검증 (settings_set). 알 수 없는 키/타입·범위 위반 시 VALIDATION.
pub fn validate_setting(key: &str, value: &serde_json::Value) -> AppResult<()> {
    let ok = match key {
        "theme" => matches!(value.as_str(), Some("dark") | Some("light") | Some("system")),
        "accent" => value.as_str().map(is_hex_color).unwrap_or(false),
        "font_scale" => value
            .as_f64()
            .map(|n| (0.85..=1.35).contains(&n))
            .unwrap_or(false),
        "bg_dim" => value.as_i64().map(|n| (0..=40).contains(&n)).unwrap_or(false),
        // 테마 커스터마이즈: 범위는 대비(본문 4.5:1) 보장을 위해 좁게 고정한다.
        "bg_tone" => value.as_i64().map(|n| (-10..=10).contains(&n)).unwrap_or(false),
        // PLAN-2026-09-12 §3/E3 — 배경 채도. bg_tone/bg_dim 과 **다른 축**이다: 저 둘은 배경의
        // 밝기를 흰/검정 쪽으로 움직이고, 이 키는 밝기를 그대로 둔 채 **테마색(`--theme`)
        // 쪽으로 물들이는 세기**다(강조색이 아니다 — 배경은 구조다, §2 판정 기준).
        //
        // 0..=100 은 퍼센트가 아니라 **상한의 몇 %인가**이고, 상한은 프런트
        // lib/appearance.ts::BG_SAT_MAX_CHROMA(OKLCH 채도 0.0226)다. 그 숫자는 구분선
        // (`color-mix(--theme 26%, transparent)`) 합성색의 채도 — 즉 "배경은 머리카락 선보다
        // 더 색을 띠지 않는다"가 상한의 뜻이고, 두 테마에서 같은 값으로 떨어진다.
        // 0 = 지금까지의 화면과 픽셀 동일(업데이트만으로 배경이 물들지 않는다).
        //
        // 프런트 짝: stores/settings.ts::setBgSat(live/commit 분리) → applyCssVars 가
        // `--app-canvas` 한 줄에 얹고, 확정 시 OS 아크릴 틴트에도 같은 색을 한 번 보낸다.
        "bg_sat" => value.as_i64().map(|n| (0..=100).contains(&n)).unwrap_or(false),
        // PLAN-2026-09-12 §5/D6 — 본문 캔버스(.content-canvas) 틴트. bg_dim 과 같은 0..=40 범위를
        // 쓰지만 **의미가 다르다**: bg_dim 은 "배경을 n% 어둡게"라는 절대값이고, 이 키는 테마별
        // 기준 틴트에 더하는 **오프셋(퍼센트 포인트)** 이다.
        //   0  = 지금까지의 화면과 픽셀 동일 (다크 16% / 라이트 7% — tokens.css 의 --content-tint)
        //   40 = 다크 56% / 라이트 47%
        // 0 이 "현재와 동일"이어야 하는 이유: 이 키는 기존 화면에 슬라이더를 붙이는 것이고, 시드가
        // 기존 사용자에게 적용되는 순간(get_all 은 행 없는 키를 기본값으로 채운다) 본문 밝기가
        // 저절로 바뀌면 안 된다. 음수를 안 여는 이유도 같은 쪽 — 기준값 아래로 내리면 사이드바와
        // 본문의 구분이 사라지는데, 그건 2026-09-09 오너 결정(10%→16%)을 되돌리는 방향이다.
        // 본문(.content-canvas) 틴트 **오프셋**. 실효값 = 테마 기준값(다크 16 / 라이트 7) + 이 값.
        //
        // **음수를 허용하는 이유**(2026-09-12 오너 QA): 틴트가 검정 한 색이면 본문이 사이드바보다
        // *밝아질* 수 없다 — 검정을 0% 까지 줄여야 겨우 같아진다. 라이트 테마에서 "본문이
        // 사이드바보다 밝았으면 좋겠다"가 나왔고, 그러려면 실효값이 음수로 내려가 틴트가 흰색으로
        // 뒤집혀야 한다. -30 이면 라이트 실효값이 -23(23% 흰색), 다크는 -14(14% 흰색)이다.
        // 0 = 지금까지의 화면 그대로(기본값) — 업데이트만으로 본문 밝기가 바뀌지 않는다.
        //
        // 프런트 짝: stores/settings.ts 의 PREFS 한 줄 + lib/appearance.ts::applyCssVars 가
        // 실효값의 **부호로 `--content-tint-color`(#000/#fff), 절댓값으로 `--content-tint-amount`**
        // 를 setProperty 한다. 부호가 색을 표현하므로 amount 는 항상 양수다.
        "content_tint" => value.as_i64().map(|n| (-30..=40).contains(&n)).unwrap_or(false),
        // 표면 프리셋 = flat + acrylic (mica→acrylic 리네임, 2026-07-24; glass 는 2026-07-21
        // 제거(WebGL 제거)). 기존 DB 에 "glass"/구 "mica" 가 저장돼 있어도 프런트 load() 하이드레이션이
        // 각각 flat/acrylic 으로 매핑하므로(settings.ts) 여기서 거부해도 안전하다 — validate_setting
        // 은 settings_set(쓰기) 전용이라 기존 값을 읽는 경로에는 관여하지 않는다.
        "surface_style" => matches!(value.as_str(), Some("flat") | Some("acrylic")),
        // acrylic 표면 불투명도 — float. 사용자 요청으로 하한 제거(2026-07-23): 과거엔 0.72(본문 대비
        // 4.5:1 유지 최소값)였으나 지금은 0~1.0 전 구간 허용 — 낮은 값의 가독성 저하는 사용자 선택
        // (settings.ts 주석 참고). 키 이름은 mica_alpha→sheet_alpha 로 리네임(2026-07-24) — 구
        // mica_alpha 는 프런트 load() 가 폴백으로 읽되(settings.ts), 새 쓰기는 항상 sheet_alpha.
        "sheet_alpha" => value.as_f64().map(|n| (0.0..=1.0).contains(&n)).unwrap_or(false),
        "ai_provider" => matches!(
            value.as_str(),
            Some("ollama")
                | Some("openai")
                | Some("claude")
                | Some("gemini")
                | Some("minimax")
                | Some("openrouter")
        ),
        "ai_endpoint" => value.is_string(),
        "ai_enabled" => value.is_boolean(),
        // PLAN-2026-08-30 §6-A — 전역 AI 정책 사다리. 세 문자열만 허용(commands::ai::AiPolicyLevel
        // 의 parse() 와 값 집합이 반드시 같아야 한다 — 여기서 막히지 않은 값은 그쪽에서 전부
        // "organize"로 폴백해 조용히 무제한이 되므로, 오탈자를 여기서 잡는 게 유일한 방어선이다).
        "ai_policy_level" => matches!(
            value.as_str(),
            Some("gather") | Some("refine") | Some("organize")
        ),
        // AI가 노트에 새 내용을 넣은 뒤 도는 백그라운드 메타데이터 제안(lib/aiPostProcess.ts)의
        // 킬 스위치. 기본 ON(default_settings 에 시드) — 제안일 뿐이고 적용은 항상 확인 모달을
        // 거치므로 조용히 쓰이는 경로가 없다.
        "ai_post_process" => value.is_boolean(),
        // 챗 메모리 자동 추출(lib/chatMemoryExtractor.ts) 킬 스위치. 기본 ON(default_settings 에 시드).
        "ai_chat_memory" => value.is_boolean(),
        // PLAN-2026-09-05 §2 B-4 — 어시스트 결과 프리뷰 게이트 킬 스위치(기본 ON, default_settings 에 시드).
        "ai_confirm_before_apply" => value.is_boolean(),
        // PLAN-2026-09-27 §7-4 — 어시스트 패널 AI 프리셋 바로 실행 토글(기본 OFF, default_settings 에 시드).
        "assist_preset_autorun" => value.is_boolean(),
        // PLAN-2026-09-05 §3 C-3 — AI 호출 로그에 본문 앞 2000자 동봉(기본 OFF, default_settings 에 시드).
        "ai_debug_verbose" => value.is_boolean(),
        // PLAN-2026-09-01 W0 — 챗 경유 수집 소스 등록 킬 스위치(기본 OFF, default_settings 에 시드).
        "collect_chat_register" => value.is_boolean(),
        // PLAN-2026-09-01 W0 — 상태 추가 진입점 잠금(기본 OFF, default_settings 에 시드).
        "status_add_locked" => value.is_boolean(),
        "timeline_default_range" => matches!(value.as_str(), Some("fit") | Some("around_now") | Some("recent_3m") | Some("recent_1y")),
        "board_done_autohide" => matches!(value.as_str(), Some("off") | Some("7d") | Some("30d")),
        "board_card_thumb" | "board_card_date" | "graph_hide_isolated" => value.is_boolean(),
        "graph_node_cap" => value.as_i64().map(|n| (0..=500).contains(&n)).unwrap_or(false),
        "gallery_tile_size" => matches!(value.as_str(), Some("small") | Some("medium") | Some("large")),
        "gallery_sort" => matches!(value.as_str(), Some("newest") | Some("oldest") | Some("name")),
        "gallery_show_names" => value.is_boolean(),
        // 내보내기 기본 폴더 — "" 이거나 절대 경로(상대 경로는 저장 대화상자가 시작하는 자리가 실행 위치에 따라 흔들린다).
        // 이 기기 전용 키라 번들·원격에서 빠진다(export.rs::is_device_local_setting_key, remote_policy.rs).
        "export_default_dir" => value
            .as_str()
            .map(|s| s.is_empty() || (s.len() <= 1024 && !s.contains('\0') && is_absolute_path_any_os(s)))
            .unwrap_or(false),
        // PLAN-2026-09-04-local-import §3b — 첫 부팅 자동 감지 후보 개수(설정 > 수집 탭 레일
        // 뱃지). 시드하지 않음(부재 = 0, 프런트 coerce가 fallback) — pet_pos_x 류 "기기 로컬,
        // 저장된 적 없음이 정상"과 같은 부류. collect_detect_local 후보 중 source_id 없는 것의
        // 개수, 0..=99.
        "collect_detect_pending" => value.as_i64().map(|n| (0..=99).contains(&n)).unwrap_or(false),
        // PLAN-2026-09-04-local-import §3b — 첫 실행 자동 감지를 이미 돌렸는지(수집 페이지를
        // 한 번이라도 열면 true). 시드하지 않음(부재 = false) — 이 값이 false인 동안만 App.tsx의
        // 부팅 이펙트가 collect_detect_local을 무음(callSilent) 호출한다(lib/collectDetectOnce.ts).
        "collect_detect_seen" => value.is_boolean(),
        // PLAN-2026-08-30 §4 W7 — FeatureBriefModal "본 브리핑" id 배열(+ 소급 시딩 sentinel).
        // ai_action_presets 와 같은 "배열이면 각 원소를 검사, 하나라도 어긋나면 전체 거부" 모양이되,
        // 원소가 객체가 아니라 문자열이라 search_recent/recent_closed_tabs 의 문자열-배열 검증
        // 형태를 따른다. id 는 lib/featureBriefs.ts 의 짧은 kebab_case 문자열 + sentinel 하나뿐이라
        // 상한은 넉넉하게(64) 잡아 이후 브리핑이 몇 개 늘어도 여유가 있게 한다.
        "seen_feature_briefs" => value
            .as_array()
            .map(|arr| {
                arr.len() <= 64
                    && arr.iter().all(|v| {
                        v.as_str()
                            .map(|s| !s.is_empty() && s.len() <= 64)
                            .unwrap_or(false)
                    })
            })
            .unwrap_or(false),
        "ai_api_key" => value.is_string(),
        // { "<프로바이더 소문자>": { "api_key"?: string, "endpoint"?: string } } — default_settings 주석.
        // 프로바이더 이름은 알려진 목록으로 묶지 않는다: 옛/모르는 ai_provider 값이 저장돼 있으면 그
        // 이름으로 보관되는데, 여기서 거부하면 전환 배치 전체가 실패해 키가 갈 곳을 잃는다. 대신 모양과
        // 크기만 묶는다(항목 16개, 이름 32자 영숫자·_·-, 값 4KB).
        "ai_provider_creds" => value
            .as_object()
            .map(|obj| {
                obj.len() <= 16
                    && obj.iter().all(|(name, creds)| {
                        !name.is_empty()
                            && name.len() <= 32
                            && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
                            && creds
                                .as_object()
                                .map(|c| {
                                    c.iter().all(|(field, v)| {
                                        matches!(field.as_str(), "api_key" | "endpoint")
                                            && v.as_str().map(|s| s.len() <= 4096).unwrap_or(false)
                                    })
                                })
                                .unwrap_or(false)
                    })
            })
            .unwrap_or(false),
        // ai_model_fallback: 기본 모델 호출이 재시도할 만한 실패(429/5xx/모델 없음)로 끝났을 때
        // 딱 한 번 갈아탈 모델 id. 형식 검증만 한다(ai_model 과 같은 이유 — 프로바이더가 최종 판정자).
        "ai_model" | "ai_model_fallback" => value.is_string(),
        "ui_lock" => value.is_boolean(),
        "sidebar_collapsed" => value.is_boolean(),
        "favorites_open" => value.is_boolean(),
        "left_width" => value.as_i64().map(|n| n > 0).unwrap_or(false),
        "source_pct" => value
            .as_i64()
            .map(|n| (24..=74).contains(&n))
            .unwrap_or(false),
        "active_workspace_id" => value.is_string(),
        "active_tab_id" => value.is_string() || value.is_null(),
        "window_geometry" => value.is_string() || value.is_null(),
        "open_tabs" => value
            .as_array()
            .map(|arr| arr.iter().all(|v| v.is_string()))
            .unwrap_or(false),
        "source_original_policy" => matches!(value.as_str(), Some("ask") | Some("keep") | Some("discard")),
        "attachment_storage_mode" => matches!(value.as_str(), Some("copy") | Some("link") | Some("reference")),
        "slide_preview" => matches!(value.as_str(), Some("auto") | Some("off")),
        "soffice_path" => value.is_string(),
        // 자동 전체 백업 스케줄 — default_settings() 주석 참고.
        "backup_auto_interval" => matches!(value.as_str(), Some("off") | Some("daily") | Some("weekly")),
        "backup_auto_keep" => value.as_i64().map(|n| (1..=5).contains(&n)).unwrap_or(false),
        "storage_alert_gb" => value.as_i64().map(|n| (0..=500).contains(&n)).unwrap_or(false),
        // 자동 백업 마지막 실패 기록(리스크 감사 A) — "타임스탬프: 메시지" 문자열, 성공 시 빈
        // 문자열로 되돌린다(repo/transfer/backup.rs::record_auto_backup_error). default_settings
        // 에 시드하지 않는다 — 없는 게 정상 상태(아직 실패한 적 없음/성공).
        "backup_auto_last_error" => value.is_string(),
        // 동기화(beta) — default_settings() 주석 참고. 포트는 well-known 대역(<1024)과 동적/사설
        // 포트 상한을 피해 1024..=65535 로 제한한다. 토큰은 sync_set_enabled/
        // sync_regenerate_token 이 new_id()로만 채운다(사용자가 임의 문자열을 직접 넣게 하지 않지만,
        // settings_set 자체는 문자열이면 허용 — UUID 형식 강제는 여기서 하지 않는다: import
        // 왕복/백업 복원 시에도 그대로 통과해야 하므로).
        "sync_enabled" => value.is_boolean(),
        "sync_port" => value.as_i64().map(|n| (1024..=65535).contains(&n)).unwrap_or(false),
        "sync_token" => value.is_string(),
        // 트레이 상주(default_settings() 주석 참고) — lib.rs::run() 의 CloseRequested 핸들러가
        // 매번 이 키를 다시 읽어 hide-instead-of-exit 여부를 결정한다.
        "close_to_tray" => value.is_boolean(),
        // N2-5: 업그레이드 백업 안내 배너의 표시 여부. migrations::run 이 실제 버전 상승 시 true 로
        // 세우고, 프런트가 배너를 닫거나 "지금 백업"을 누르면 false 로 되돌린다(settings_set).
        "backup_nudge_pending" => value.is_boolean(),
        "ui_lang" => matches!(value.as_str(), Some("en") | Some("fr") | Some("ko")),
        "week_start" => matches!(value.as_str(), Some("sunday") | Some("monday")),
        "calendar_axis_tail_hours" => value.as_i64().map(|n| (0..=12).contains(&n)).unwrap_or(false),
        // 기준 지역 활용 마스터(PLAN-2026-09-15 R2). pet_enabled 와 같은
        // "0"/"1" 문자열 — boolean 이 아니다. default_settings 가 "1" 로 시드한다.
        "region_enabled" => matches!(value.as_str(), Some("0") | Some("1")),
        "holiday_region" => matches!(value.as_str(), Some("none") | Some("kr") | Some("fr")),
        // `header_weather_visible` 은 2026-09-12 오너 결정 D11 로 없어졌다(날씨는 항상 표시).
        // 기존 설치의 DB 행은 그대로 남아 있어도 무해하다 — validate_setting 은 **쓰기 전용**이고
        // (repo::settings::set 만 부른다) get_all 은 검증 없이 행을 돌려주므로, 마지막 쓰는 쪽이
        // 사라진 지금은 이 arm 이 없어도 아무것도 실패하지 않는다. surface_style arm 옆의 같은 주석 참고.
        // 데스크톱 펫 창(W6-d1 스캐폴딩, tray.rs "펫 표시/숨기기" 토글이 소유). 이 파일의 다른
        // on/off 토글과 달리 is_boolean()이 아니라 "0"/"1" 문자열이다(태스크 브리프 지정) — 새
        // 코드를 여기 붙일 때 boolean으로 착각하지 말 것.
        "pet_enabled" => matches!(value.as_str(), Some("0") | Some("1")),
        // `canvas_enabled`/`canvas_shortcut` 은 캔버스 플러그인 제거(2026-09-28)로 없어졌다.
        // 기존 설치의 DB 행은 남아도 무해하다 — 위 header_weather_visible 과 같은 이유(get_all 무검증).
        // 표시/숨기기(W8-g) — 마스터(pet_enabled)와 별개, 타이틀바 버튼·트레이 "펫 표시/숨기기"
        // 가 쓴다. 위와 같은 이유로 boolean이 아니라 "0"/"1" 문자열.
        "pet_visible" => matches!(value.as_str(), Some("0") | Some("1")),
        // 펫 창 위치(로지컬 px, pet_window.rs 가 소비). 음수 허용 — 보조 모니터가 주 모니터 좌/위에
        // 있으면 정상적으로 음수 좌표를 갖는다. default_settings()에 시드하지 않는다(window_geometry/
        // active_tab_id와 같은 패턴): 저장된 적 없음 = get_all()에 키 자체가 없음 → pet_window.rs
        // 가 계산된 기본 위치로 폴백.
        "pet_pos_x" | "pet_pos_y" => value.as_i64().is_some(),
        // 펫 우클릭 "화면 저장"(docs/PLAN-2026-08-09-pet-capture.md Phase 1). Q7: 신규 수집 채널은
        // **기본 전부 OFF** — default_settings() 에 시드하지 않는다(키 없음 = 꺼짐, pet_pos_* 와
        // 같은 패턴). pet_enabled 와 마찬가지로 boolean 이 아니라 "0"/"1" 문자열이다.
        "capture_screenshot_enabled" => matches!(value.as_str(), Some("0") | Some("1")),
        // 화면 저장 폴더(설정 > 일반). 시드 없음/"" = 기본(<사진>/Brise, repo::screenshot::capture_dir).
        // 상대 경로는 실행 위치에 따라 흔들리므로 절대 경로만. 원격 settings_set 은 막는다(remote_policy.rs).
        "capture_screenshot_dir" => value
            .as_str()
            .map(|s| s.is_empty() || (s.len() <= 1024 && std::path::Path::new(s).is_absolute()))
            .unwrap_or(false),
        // ingest 리스너 자격증명. capture_ingest_token 은 sync_token 과 같은 규칙(new_id() 로만
        // 채우지만 형식은 강제하지 않는다 — import/백업 복원 왕복도 통과해야 한다), 포트는
        // sync_port 와 같은 범위.
        "capture_ingest_token" => value.is_string(),
        "capture_ingest_port" => value.as_i64().map(|n| (1024..=65535).contains(&n)).unwrap_or(false),
        // 가계부 캡처(결제문자/알림, Tasker/단축어 연동). 시드 없음 = OFF — 문턱·모델 오버라이드는
        // 두지 않는다(SMS 볼륨이 자연히 낮아 RSS의 post_process_model 같은 비용 제어가 이 단계에선
        // 과함, ponytail). 2026-09-09 크롬 익스텐션 철수 전에는 이 리스너에 clip/visits 채널이
        // 같이 얹혀 있었다(capture_clip_enabled / capture_visits_enabled / capture_visit_min_seconds).
        "capture_ledger_enabled" => matches!(value.as_str(), Some("0") | Some("1")),
        // 구 키 — 익스텐션 시절 사용자가 쌓아둔 제외 목록을 collect_excluded_domains 가 폴백으로
        // 한 번 읽어 이관한다(collect::urlfilter::host_excluded). 그래서 읽기 경로만 남긴다.
        "capture_visit_excluded_domains" => value
            .as_array()
            .map(|arr| {
                arr.len() <= 200
                    && arr.iter().all(|v| {
                        v.as_str().map(|s| !s.trim().is_empty() && s.len() <= 253).unwrap_or(false)
                    })
            })
            .unwrap_or(false),
        // 펫 페르소나(W6-d2). preset 은 프리셋 2종 + "custom"; custom 일 때만 pet_persona_prompt
        // (자유 편집 시스템 프롬프트)가 쓰인다 — repo::pet::persona_prompt 가 이 두 값을 해석한다.
        // 길이 상한은 프롬프트 예산 보호용(자유 텍스트를 무제한으로 시스템 프롬프트에 싣지 않는다).
        "pet_persona_preset" => matches!(value.as_str(), Some("secretary") | Some("friend") | Some("custom")),
        "pet_persona_prompt" => value.as_str().map(|s| s.chars().count() <= 2000).unwrap_or(false),
        // Codex 패키지 프리셋 선택값. 패키지 설치/선택 커맨드만 쓰며 디렉터리명과 같은
        // 소문자 slug라 경로 조각으로 안전하다. 공유 Codex zip 은 id 에 `_` 를 쓴다.
        "pet_selected_package" => value
            .as_str()
            .map(|s| {
                !s.is_empty()
                    && s.len() <= 64
                    && s.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_'
                    })
            })
            .unwrap_or(false),
        // 펫 에셋 등록표(W7-h, W8-d cycle_ms 추가). {mood: {file, frames, cycle_ms}} — 프런트가
        // 직접 쓰지 않고 commands::pet 의 pet_asset_set/clear 만 쓴다(파일 복사와 설정 갱신이
        // 한 묶음이라 갈라지면 안 된다). file 은 앱 데이터 폴더 안의 **파일명만** — 경로
        // 구분자가 들어오면 거부한다(경로 순회).
        "pet_assets" => value
            .as_object()
            .map(|obj| {
                obj.iter().all(|(mood, entry)| {
                    crate::repo::pet::PET_MOODS.contains(&mood.as_str())
                        && entry
                            .as_object()
                            .map(|e| {
                                let file_ok = e
                                    .get("file")
                                    .and_then(|v| v.as_str())
                                    .map(|f| {
                                        !f.contains('/')
                                            && !f.contains('\\')
                                            && std::path::Path::new(f)
                                                .extension()
                                                .and_then(|x| x.to_str())
                                                .map(|x| {
                                                    crate::repo::pet::PET_ASSET_EXTS
                                                        .contains(&x.to_ascii_lowercase().as_str())
                                                })
                                                .unwrap_or(false)
                                    })
                                    .unwrap_or(false);
                                let frames_ok = match e.get("frames") {
                                    None | Some(serde_json::Value::Null) => true,
                                    Some(v) => v
                                        .as_u64()
                                        .map(|n| (2..=crate::repo::pet::PET_ASSET_FRAMES_MAX).contains(&n))
                                        .unwrap_or(false),
                                };
                                // PNG 재생 속도(W8-d). frames 와 같은 규약: 없음/null 은 통과,
                                // 있으면 상수 범위(200~5000ms) 안에 있어야 한다.
                                let cycle_ok = match e.get("cycle_ms") {
                                    None | Some(serde_json::Value::Null) => true,
                                    Some(v) => v
                                        .as_u64()
                                        .map(|n| {
                                            (crate::repo::pet::PET_ASSET_CYCLE_MS_MIN as u64
                                                ..=crate::repo::pet::PET_ASSET_CYCLE_MS_MAX as u64)
                                                .contains(&n)
                                        })
                                        .unwrap_or(false),
                                };
                                file_ok && frames_ok && cycle_ok
                            })
                            .unwrap_or(false)
                })
            })
            .unwrap_or(false),
        // §2.4 HANDOFF-calendar-onboarding.md: 필터 로스터(체크 on/off + 순서). `tree`는 제외 —
        // 필터가 아니라 기본 노트 목록. 각 항목은 {mode, enabled}; mode 는 YearFilterMode(tree
        // 제외) 허용목록으로 제한한다. 완전성(5개 전부 존재)은 강제하지 않는다 — 프런트가 없는
        // 항목을 기본값(활성, 끝에 추가)으로 보정해 향후 모드 추가에도 깨지지 않는다.
        "filter_roster" => value
            .as_array()
            .map(|arr| {
                arr.iter().all(|entry| {
                    entry.as_object().map(|obj| {
                        matches!(
                            obj.get("mode").and_then(|v| v.as_str()),
                            Some("region") | Some("timeline") | Some("gallery") | Some("calendar") | Some("chat")
                        ) && obj.get("enabled").map(|v| v.is_boolean()).unwrap_or(false)
                    }).unwrap_or(false)
                })
            })
            .unwrap_or(false),
        // W7 §7.3: 대시보드 탭 순서. 각 항목은 {id, enabled}; id 는 DashboardTabId 허용목록으로 제한.
        // default_settings() 에 시드하지 않는다("빈 배열 = 저장된 적 없음"이 유일한 SSOT).
        "dashboard_tabs" => value
            .as_array()
            .map(|arr| {
                arr.iter().all(|entry| {
                    entry.as_object().map(|obj| {
                        matches!(
                            obj.get("id").and_then(|v| v.as_str()),
                            Some("board") | Some("calendar") | Some("timeline") | Some("map") | Some("graph")
                        ) && obj.get("enabled").map(|v| v.is_boolean()).unwrap_or(false)
                    }).unwrap_or(false)
                })
            })
            .unwrap_or(false),
        // §2.6 HANDOFF-calendar-onboarding.md: 7단계(그릴링 후 5단계로 통합) 첫 실행 온보딩
        // 마법사 완료 플래그. false(기본)면 부팅 시 마법사를 띄운다. 설정의 "온보딩 다시 하기"
        // 버튼은 이 값을 false로 되돌려 즉시 마법사를 재실행한다.
        "onboarding_completed" => value.is_boolean(),
        // 에디터 툴바 토글(마이크 아이콘 옆) — 맞춤법 밑줄 데코레이션 on/off, 번역 뷰 on/off +
        // 대상 언어. 둘 다 순수 UI 영속 상태(기능 자체는 프론트 전용 또는 ai_translate_text
        // 커맨드가 처리하며, 이 키들은 토글 상태만 기억한다).
        "spellcheck_enabled" => value.is_boolean(),
        "translate_enabled" => value.is_boolean(),
        // 에디터 너비 토글(툴바 chevrons 버튼) — false(기본) 편안한 모드(가운데 정렬 X, 800px
        // 상한) / true 전체 너비(패널 폭 그대로). 위 두 토글과 같은 순수 boolean UI 상태.
        "editor_full_width" => value.is_boolean(),
        "translate_target_lang" => matches!(value.as_str(), Some("fr") | Some("en") | Some("ko")),
        "recent_color_hues" => value
            .as_array()
            .map(|arr| arr.iter().all(|v| v.as_i64().map(|n| (0..=359).contains(&n)).unwrap_or(false)))
            .unwrap_or(false),
        "default_map_location" => value
            .as_object()
            .map(|obj| {
                obj.len() == 3
                    && obj.get("lat").and_then(|v| v.as_f64()).map(|n| (-90.0..=90.0).contains(&n)).unwrap_or(false)
                    && obj.get("lng").and_then(|v| v.as_f64()).map(|n| (-180.0..=180.0).contains(&n)).unwrap_or(false)
                    // 상한은 지도의 줌 클램프(WorldMap.tsx: 1..400)와 같아야 한다 — 예전 12 는 최대
                    // 배율이 12 이던 시절 값이라, 그보다 확대한 화면을 기본 위치로 저장하면
                    // VALIDATION 으로 거부됐다(기본값 서울 zoom 50 조차 저장 불가).
                    && obj.get("zoom").and_then(|v| v.as_f64()).map(|n| (1.0..=400.0).contains(&n)).unwrap_or(false)
            })
            .unwrap_or(false),
        // Wave 8: header phrase pack selection. "off" hides the line; "bundled:*" / "user:*"
        // select a pack. Length cap only — unknown ids soft-hide on the frontend.
        "phrase_pack_id" => value
            .as_str()
            .map(|s| !s.is_empty() && s.len() <= 256 && !s.contains("..") && !s.contains('/') && !s.contains('\\'))
            .unwrap_or(false),
        // 최근 사용/즐겨찾기 이모지 — 값은 매니페스트 unicode 키(소문자 hex, 하이픈 조인, 예:
        // "1f600", "0023-fe0f-20e3"). emoji_recent 는 LRU 상한을 프런트(settings.ts)가 강제하므로
        // 여기선 형식만 검증한다.
        "emoji_recent" | "emoji_favorites" => value
            .as_array()
            .map(|arr| arr.iter().all(|v| v.as_str().map(is_safe_emoji_key).unwrap_or(false)))
            .unwrap_or(false),
        // QA8 Wave 3A — recent search history (device-local, excluded from export). Array of
        // non-empty query strings. Cap (20) is frontend-owned; allow a little headroom so a
        // slightly larger write from an older build still validates. Per-item length mirrors
        // SEARCH_RECENT_ITEM_MAX_LEN in src/stores/search.ts.
        "search_recent" => value
            .as_array()
            .map(|arr| {
                arr.len() <= 40
                    && arr.iter().all(|v| {
                        v.as_str()
                            .map(|s| !s.is_empty() && s.len() <= 200)
                            .unwrap_or(false)
                    })
            })
            .unwrap_or(false),
        // QA8 Wave 4A — recently closed tab note ids (session convenience, NOT activity_log).
        // Frontend-owned LRU (~10); allow headroom so an older build's slightly larger write
        // still validates. Items are note uuids (non-empty strings). Device-local — excluded
        // from export via is_device_local_setting_key.
        "recent_closed_tabs" => value
            .as_array()
            .map(|arr| {
                arr.len() <= 20
                    && arr.iter().all(|v| {
                        v.as_str()
                            .map(|s| !s.is_empty() && s.len() <= 64)
                            .unwrap_or(false)
                    })
            })
            .unwrap_or(false),
        // Wave 2 (new-note inbox): 워크스페이스별 "미분류" 폴더 id — 키는 `inbox_<workspace_id>`.
        // 클라이언트가 folder_create 의 id 를 지정할 수 없으므로(Rust는 new_id() 고정), 워크스페이스
        // 별로 lazy create 한 inbox 폴더의 id 를 settings_store 에 영속한다. 글로벌 settings store
        // 의 기존 키 매커니즘을 그대로 재사용 — 새 persistence 레이어 도입 없음. 값은 폴더 id 문자열.
        key if key.starts_with("inbox_") => value.is_string(),
        // AI 작업 프리셋(데스크톱/모바일 공유, stores/aiPresets.ts) — 내장 4개(list/organize/
        // summarize/metadata) + 사용자 커스텀을 한 배열로 저장한다. 각 항목은 프론트 JS 객체를
        // 그대로 직렬화한 것이라(별도 Rust 구조체 없음) 키는 camelCase(isBuiltin)로 온다.
        // kind="metadata"의 prompt는 ai_organize_note의 custom_prompt로 그대로 전송된다(Wave
        // EDITABLE METADATA PROMPT) — repo::ai::compose_organize_system_prompt가 backend 고정
        // OUTPUT CONTRACT 뒤에 guidance로만 덧붙이므로 JSON 스키마 자체는 이 값으로 못 바꾼다.
        // 여기서는 여전히 형식 검증만 한다(값이면 뭐든 저장 가능해야 프론트가 자유 편집 UI를
        // 얹을 수 있다 — 프롬프트 내용의 의미 검증은 이 계층의 책임이 아니다).
        "ai_action_presets" => value
            .as_array()
            .map(|arr| {
                arr.iter().all(|entry| {
                    entry
                        .as_object()
                        .map(|obj| {
                            obj.get("id").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
                                && obj.get("name").and_then(|v| v.as_str()).is_some()
                                && obj.get("prompt").and_then(|v| v.as_str()).is_some()
                                // "template" (2026-08-08 프리셋 통합, docs/PLAN-2026-08-08-presets-schedule.md
                                // Q5·Q7): LLM 을 부르지 않는 노트 스캐폴드 kind — prompt 필드에 노트 본문이
                                // 담긴다. 내용 검증은 다른 kind 의 prompt 와 같은 이유로 하지 않는다.
                                // "tool" (PLAN-2026-09-27 §7-5, Q10): 전용 실행기를 타는 도구 항목(자동 각주 등).
                                && matches!(
                                    obj.get("kind").and_then(|v| v.as_str()),
                                    Some("text") | Some("metadata") | Some("diagram") | Some("template") | Some("sheet") | Some("tool")
                                )

                                && obj.get("isBuiltin").map(|v| v.is_boolean()).unwrap_or(false)
                                && obj.get("hidden").map(|v| v.is_boolean()).unwrap_or(false)
                                // PLAN-2026-09-15-askai-composer §2.1 — 타일 필드. 전부 **optional**:
                                // 없으면 통과(옛 클라이언트·동기화 호환), 있으면 타입만 본다.
                                && obj.get("label").map(|v| v.is_string()).unwrap_or(true)
                                && obj.get("icon").map(|v| v.is_string()).unwrap_or(true)
                                && obj.get("blank").map(|v| v.is_boolean()).unwrap_or(true)
                                && obj.get("order").map(|v| v.as_i64().is_some()).unwrap_or(true)
                                && obj
                                    .get("targets")
                                    .map(|v| {
                                        v.as_array()
                                            .map(|a| {
                                                a.iter().all(|t| {
                                                    matches!(
                                                        t.as_str(),
                                                        Some("note") | Some("section") | Some("selection") | Some("diagram") | Some("sheet")
                                                    )
                                                })
                                            })
                                            .unwrap_or(false)
                                    })
                                    .unwrap_or(true)
                                && obj
                                    .get("where")
                                    .map(|v| matches!(v.as_str(), Some("section") | Some("note") | Some("replace") | Some("proposal")))
                                    .unwrap_or(true)
                                && obj
                                    .get("proposal")
                                    .map(|v| matches!(v.as_str(), Some("metadata") | Some("tags") | Some("split")))
                                    .unwrap_or(true)
                                // needs (6안 D17) — 이 프리셋이 필요로 하는 컨텍스트 참조 종류.
                                // CtxRef["k"] 의 문자열 배열(composer/types.ts).
                                && obj
                                    .get("needs")
                                    .map(|v| {
                                        v.as_array()
                                            .map(|a| {
                                                a.iter().all(|n| {
                                                    matches!(
                                                        n.as_str(),
                                                        Some("body")
                                                            | Some("section")
                                                            | Some("selection")
                                                            | Some("note")
                                                            | Some("file")
                                                            | Some("folder")
                                                            | Some("weather")
                                                    )
                                                })
                                            })
                                            .unwrap_or(false)
                                    })
                                    .unwrap_or(true)
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false),
        // PLAN-2026-09-27 §7.1 & Q5(b): 엔진 지침(관계도/시트 JSON 규칙, 에이전트 계획, 메타데이터 기준 등 16종) 재정의 맵.
        "ai_internal_instructions" => value
            .as_object()
            .map(|obj| {
                obj.iter().all(|(k, v)| !k.is_empty() && v.is_string())
            })
            .unwrap_or(false),
        // Empty-state note presets (desktop TabBar "프리셋으로 저장" 컨텍스트 메뉴 → stores/
        // presets.ts::saveFromNote, PresetList/TreeHeaderActions·MobileCapturePresets가 같은 키를
        // 읽는다). Builtins(blank/todo/ai)는 정적 프런트 상수라 여기 오지 않는다 — custom만. 각
        // 항목은 CustomPreset 그대로: id/name/bodyMd, 전부 plain string(bodyMd는 HTML/MD 패스스루,
        // 내용 검증은 ai_action_presets의 prompt 필드와 같은 이유로 여기서 하지 않는다).
        "note_presets" => value
            .as_array()
            .map(|arr| {
                arr.iter().all(|entry| {
                    entry
                        .as_object()
                        .map(|obj| {
                            obj.get("id").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
                                && obj.get("name").and_then(|v| v.as_str()).is_some()
                                && obj.get("bodyMd").and_then(|v| v.as_str()).is_some()
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false),
        // "제거"한 빌트인 프리셋(blank/todo/diagram/daily/travel/retro/ai) id 목록 — ai_action_presets
        // 의 hidden:true 패턴과 달리 빌트인은 정적 프런트 상수라 편집할 name/prompt가 없으므로,
        // note_presets(커스텀 전용) 배열에 hidden 플래그를 얹는 대신 별도 키로 "숨긴 id 집합"만
        // 둔다(stores/presets.ts::hideBuiltin/restoreHiddenBuiltins). 값 자체를 알려진 7개 id로
        // 제한해 임의 문자열이 저장되는 걸 막는다.
        "note_presets_hidden_builtins" => value
            .as_array()
            .map(|arr| {
                arr.iter().all(|v| {
                    matches!(
                        v.as_str(),
                        Some("blank")
                            | Some("todo")
                            | Some("diagram")
                            | Some("budget")
                            | Some("sheet")
                            | Some("daily")
                            | Some("travel")
                            | Some("retro")
                            | Some("ai")
                    )
                })
            })
            .unwrap_or(false),
        // P2 3단계 링크 후행 제안 킬 스위치(default_settings() 주석 참고) — 함정 3: 이 arm이
        // 없으면 설정 화면의 토글이 켜지는 것처럼 보이고 재시작하면 꺼져 있다(settings_set이
        // 조용히 VALIDATION으로 거부, 프런트가 .catch(()=>{})로 삼킴).
        "link_suggestions" => value.is_boolean(),
        // PLAN-2026-09-18-nl-dates.md §W4 — 날짜 넛지 완전자동 등록 킬스위치(default_settings()
        // 주석 참고). 함정 3: 이 arm이 없으면 설정 화면 토글이 켜지는 것처럼 보이고 재시작하면
        // 꺼져 있다.
        "date_nudge_auto" => value.is_boolean(),
        // PLAN-2026-09-19-date-region-ui.md §P3 D12 — 지역 사전 매칭 넛지 강도 킬스위치
        // (default_settings() 주석 참고). 함정 3: 이 arm이 없으면 설정 화면 토글이 켜지는 것처럼
        // 보이고 재시작하면 꺼져 있다(단, D12 는 기본이 true — 꺼지면 "완화"로 느슨해진다).
        "region_nudge_strict" => value.is_boolean(),
        // 오너 결정(2026-09-20) — 3단 UI(off/suggest/auto, off/strict/loose)의 앞쪽 "enabled"
        // 불리언. default_settings() 주석 참고(WHY: 값 모양을 안 바꾸는 이유). 함정 3: 이 arm이
        // 없으면 설정 화면 토글이 켜지는 것처럼 보이고 재시작하면 꺼져 있다.
        "date_nudge_enabled" => value.is_boolean(),
        "region_nudge_enabled" => value.is_boolean(),
        // 오너 결정(2026-09-20) — 붙여넣기 자동 동작 3종(default_settings() 주석 참고). 함정 3 동일.
        "paste_link_nudge" => value.is_boolean(),
        "paste_path_inline_code" => value.is_boolean(),
        "paste_table_sheet_suggest" => value.is_boolean(),
        // 오너 결정(2026-09-20) — 마크다운 자동 서식 킬 스위치(default_settings() 주석 참고).
        "editor_md_autoformat" => value.is_boolean(),
        // S2 입력 3종(default_settings() 주석 참고) — 함정 3: 이 arm 이 없으면 폰 설정의 선택이 켜지는
        // 것처럼 보이고 저장은 조용히 거부된다. 값은 정확히 "off"|"ask"|"auto".
        "photo_meta_mode" | "voice_transcribe_mode" | "voice_cleanup_mode" => {
            matches!(value.as_str(), Some("off") | Some("ask") | Some("auto"))
        }
        // 오너 결정(2026-09-20, "4~7번도 넣어봐") — **실험적** 4종(default_settings() 주석 참고).
        // 각 arm 이 자기 키 하나만 검증한다 — 빼려면 이 arm 한 줄만 지우면 된다(함정 3: 지우지
        // 않고 프런트만 걷으면 무해하지만, 반대로 프런트 등록 없이 arm 만 남아도 무해하다 — 둘
        // 다 지워야 "완전히 없앤" 상태).
        "link_open_on_click" => value.is_boolean(),
        "editor_word_count" => value.is_boolean(),
        "editor_width" => matches!(value.as_str(), Some("narrow") | Some("normal") | Some("wide")),
        "new_note_date_precision" => matches!(value.as_str(), Some("day") | Some("month") | Some("year")),
        // 첫 섹션 이름 — trim 후 40자 이하(문자 수, 바이트 아님), 줄바꿈 금지(섹션 탭에 한 줄로
        // 그려진다). 빈 문자열(trim 후에도)은 허용 — "" = 백엔드 내장 기본 이름을 쓴다는 신호.
        "new_note_section_name" => value
            .as_str()
            .map(|s| {
                s.trim().chars().count() <= 40 && !s.contains('\n') && !s.contains('\r')
            })
            .unwrap_or(false),
        // link_suggest 가 요약에 쓸 모델 오버라이드. 빈 문자열도 허용(소비처에서 NULL 동등 처리).
        // 프로바이더 자체는 검증하지 않는다 — link_suggestions_active 게이트가 ai_enabled 를
        // 보장하므로 별도 provider 검증은 중복.
        "link_suggestions_model" => value.is_string(),
        // collect_excluded_domains — capture_visit_excluded_domains 와 같은 형식·캡(200개·253자).
        // visits·clip·link_paste 가 같은 리스트를 공유하기 위한 상위 호환 키. 기존
        // capture_visit_excluded_domains 값은 visits 가 새 키 우선으로 읽고 구 키를 폴백으로
        // 사용하므로 마이그레이션 불필요.
        "collect_excluded_domains" => value
            .as_array()
            .map(|arr| {
                arr.len() <= 200
                    && arr.iter().all(|v| {
                        v.as_str().map(|s| !s.trim().is_empty() && s.len() <= 253).unwrap_or(false)
                    })
            })
            .unwrap_or(false),
        // collect_paused_until — 빈 문자열(OFF) 또는 RFC3339/ISO-8601 datetime 문자열. 형식 검증은
        // chrono::DateTime::parse_from_rfc3339 �로 — 파싱 실패는 VALIDATION. tick 마다
        // chrono::Utc::now() 와 비교하므로 시계가 과거로 가면 자동으로 풀린다(빈 문자열과 동일).
        // 시간대 표기(예: +09:00, Z) 모두 허용. 일광절약/윤초 영향 없음(chrono 가 UTC 로 정규화).
        "collect_paused_until" => match value.as_str() {
            None => false,
            Some(s) if s.trim().is_empty() => true,
            Some(s) => chrono::DateTime::parse_from_rfc3339(s.trim()).is_ok(),
        },
        // 일정 알림 3키(docs/PLAN-schedule-system.md §5.5) — 함정 3: arm 이 없으면 설정 화면의
        // 토글이 켜지는 것처럼 보이고 재시작하면 꺼져 있으며, 워터마크는 **매 틱 저장에 실패해**
        // 같은 알림이 1분마다 반복 발화한다(조용한 실패 중 제일 시끄러운 종류).
        "notifications_enabled" => value.is_boolean(),
        // 시각 형식의 진짜 관문은 repo::schedule::parse_hhmm_min 하나뿐이다(DB CHECK 의 GLOB 는
        // "24:00"을 통과시킨다) — 여기서 정규식을 다시 쓰지 않는다.
        "reminder_all_day_at" => value
            .as_str()
            .map(|s| crate::repo::schedule::parse_hhmm_min(s).is_some())
            .unwrap_or(false),
        // 기기-로컬 워터마크. 틱이 매분 쓰므로 형식만 검증한다(§5.4 "YYYY-MM-DDTHH:MM" 로컬).
        "reminder_last_tick_at" => value
            .as_str()
            .map(|s| crate::repo::schedule::parse_stamp(s).is_some())
            .unwrap_or(false),
        // 브리핑(PLAN-2026-09-30-briefing §3). 시각 형식 관문은 reminder_all_day_at 와 같은 parse_hhmm_min.
        "briefing_enabled" => value.is_boolean(),
        "briefing_when" => matches!(value.as_str(), Some("time") | Some("launch") | Some("manual")),
        "briefing_time" => value
            .as_str()
            .map(|s| crate::repo::schedule::parse_hhmm_min(s).is_some())
            .unwrap_or(false),
        "briefing_evening_enabled" => value.is_boolean(),
        "briefing_evening_time" => value
            .as_str()
            .map(|s| crate::repo::schedule::parse_hhmm_min(s).is_some())
            .unwrap_or(false),
        "briefing_notify" => matches!(value.as_str(), Some("window") | Some("os") | Some("both")),
        // 빈 문자열 = 아직 안 띄움. 아니면 실재하는 로컬일 YYYY-MM-DD(로컬일 규칙 — UTC 금지).
        "briefing_last_shown_evening" => value
            .as_str()
            .map(|s| s.is_empty() || chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok())
            .unwrap_or(false),
        "briefing_last_seen" => value
            .as_str()
            .map(|s| s.is_empty() || chrono::DateTime::parse_from_rfc3339(s).is_ok())
            .unwrap_or(false),
        "briefing_last_shown" => value
            .as_str()
            .map(|s| s.is_empty() || chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok())
            .unwrap_or(false),
        // 화면 구성 키 5종(briefing_view/presets/layout/cards/options)은 브리핑 재작성(PLAN-2026-10-19
        // -briefing-rewrite §9.1)으로 arm 째 없어졌다 — RETIRED_KEYS 에 있다. 기존 설치의 DB 행은 남아도
        // 무해하다(header_weather_visible 과 같은 이유 — get_all 무검증).
        // W10: 사용자 이름 (선택, 최대 64자).
        "user_name" => value.as_str().map(|s| s.chars().count() <= 64).unwrap_or(false),
        // W11: 글꼴 패밀리 ("serif" | "sans" | 자유 문자열, 최대 128자).
        "font_family" => value.as_str().map(|s| !s.trim().is_empty() && s.chars().count() <= 128).unwrap_or(false),
        // PLAN-2026-10-27-fonts — 값 형식은 font_family 와 같다(번들 id · `catalog:<id>` · 시스템 글꼴명).
        // font_editor 만 빈 값 허용: "앱 화면 글꼴을 따름".
        "font_editor" => value.as_str().map(|s| s.chars().count() <= 128).unwrap_or(false),
        "font_mono" => value.as_str().map(|s| !s.trim().is_empty() && s.chars().count() <= 128).unwrap_or(false),
        // W18: pet_click_action 삭제 (클릭=채팅 고정). pet_dblclick_action 허용값 chat|new_note|off.
        "pet_dblclick_action" => matches!(
            value.as_str(),
            Some("chat") | Some("new_note") | Some("off")
        ),
        // W13 (결정 10): 챗봇 메모리 — JSON 배열 [{ id, text, created_at }]. 최대 50개, 텍스트 200자 캡.
        // ponytail: settings 키 하나. 항목 50개 캡. 넘치게 쓰이면 그때 전용 테이블로
        "chat_memory" => value
            .as_array()
            .map(|arr| {
                arr.len() <= 50
                    && arr.iter().all(|entry| {
                        entry.as_object().map(|obj| {
                            let id_ok = obj.get("id").and_then(|v| v.as_str()).map(|s| !s.is_empty() && s.chars().count() <= 64).unwrap_or(false);
                            let text_ok = obj.get("text").and_then(|v| v.as_str()).map(|s| !s.is_empty() && s.chars().count() <= 200).unwrap_or(false);
                            let created_ok = obj.get("created_at").and_then(|v| v.as_str()).map(|s| !s.is_empty() && s.chars().count() <= 64).unwrap_or(false);
                            id_ok && text_ok && created_ok
                        }).unwrap_or(false)
                    })
            })
            .unwrap_or(false),
        // F-P01 비서/펫 노트 쓰기 게이트. 클라 allow_write 와 AND — 저장된 false 는 클라가 못 덮는다.
        "chat_write_enabled" => value.is_boolean(),
        // 챗봇 권한: 이전 대화 내용 및 사용자 파일/노트 참조 게이트.
        "chat_read_history" | "chat_read_files" => value.is_boolean(),
        // E4: 자동 업데이트 확인 킬스위치.
        "update_check_auto" => value.is_boolean(),
        _ => return Err(AppError::Validation(format!("unknown setting key: {key}"))),
    };
    if ok {
        Ok(())
    } else {
        Err(AppError::Validation(format!("invalid value for {key}")))
    }
}

fn is_hex_color(s: &str) -> bool {
    let s = s.strip_prefix('#').unwrap_or("");
    (s.len() == 6 || s.len() == 3) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// emoji manifest unicode key — lowercase hex codepoints hyphen-joined (see
/// scripts/emoji/build-fluent-manifest.mjs / emoji.ts::emojiKey). Only used to render a picker
/// grid, but validated anyway since it's user-writable settings state.
fn is_safe_emoji_key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.split('-').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    /// 초기화(theme_defaults)가 default_settings 에서 모양 키를 뽑아 쓰므로, 목록의 키마다
    /// 기본값이 있어야 하고 그 기본값이 검증을 통과해야 한다 — 아니면 초기화가 조용히 반쪽이 된다.
    #[test]
    fn every_appearance_key_has_a_valid_default() {
        let defaults = default_settings("ws");
        for key in APPEARANCE_KEYS {
            let raw = defaults
                .iter()
                .find(|(k, _)| *k == key)
                .unwrap_or_else(|| panic!("no default for appearance key {key}"));
            let v: serde_json::Value = serde_json::from_str(&raw.1).unwrap();
            assert!(validate_setting(key, &v).is_ok(), "default for {key} fails validation");
        }
    }

    /// 노트북 키마다 기본값이 있고 검증을 통과해야 한다 — 새 노트북은 행이 없어서 전부 기본값으로
    /// 시작한다(오너 결정). 기본값이 없으면 그 키는 새 노트북에서 조용히 빠진다.
    #[test]
    fn every_notebook_key_has_a_valid_default() {
        let defaults = default_settings("ws");
        for key in NOTEBOOK_KEYS {
            let raw = defaults
                .iter()
                .find(|(k, _)| *k == key)
                .unwrap_or_else(|| panic!("no default for notebook key {key}"));
            let v: serde_json::Value = serde_json::from_str(&raw.1).unwrap();
            assert!(validate_setting(key, &v).is_ok(), "default for {key} fails validation");
        }
    }

    /// 노트북 키는 노트북 번들에 실려 남에게 건너간다 — 비밀·기기 전용 키가 섞이면 새어 나간다.
    #[test]
    fn notebook_keys_never_include_secret_or_device_local_keys() {
        use crate::repo::transfer::export::{is_device_local_setting_key, is_secret_setting_key};
        for key in NOTEBOOK_KEYS {
            assert!(!is_secret_setting_key(key), "{key} is secret");
            assert!(!is_device_local_setting_key(key), "{key} is device-local");
        }
    }

    #[test]
    fn appearance_keys_are_notebook_keys() {
        for key in APPEARANCE_KEYS {
            assert!(is_notebook_setting_key(key), "{key} must follow the notebook");
        }
    }

    #[test]
    fn theme_accepts_dark_light_system_and_defaults_system() {
        assert!(validate_setting("theme", &json!("dark")).is_ok());
        assert!(validate_setting("theme", &json!("light")).is_ok());
        assert!(validate_setting("theme", &json!("system")).is_ok());
        assert!(validate_setting("theme", &json!("blue")).is_err());
        assert!(validate_setting("theme", &json!(true)).is_err());
        assert_eq!(
            default_settings("ws-1")
                .into_iter()
                .find(|(k, _)| *k == "theme")
                .map(|(_, v)| v),
            Some("\"system\"".to_string())
        );
    }

    #[test]
    fn ai_post_process_is_boolean_and_defaults_on() {
        assert!(validate_setting("ai_post_process", &json!(true)).is_ok());
        assert!(validate_setting("ai_post_process", &json!(false)).is_ok());
        assert!(validate_setting("ai_post_process", &json!("true")).is_err());
        assert!(validate_setting("ai_post_process", &json!(1)).is_err());
        assert_eq!(
            default_settings("ws-1")
                .into_iter()
                .find(|(k, _)| *k == "ai_post_process")
                .map(|(_, v)| v),
            Some("true".to_string())
        );
    }

    #[test]
    fn ai_chat_memory_is_boolean_and_defaults_on() {
        assert!(validate_setting("ai_chat_memory", &json!(true)).is_ok());
        assert!(validate_setting("ai_chat_memory", &json!(false)).is_ok());
        assert!(validate_setting("ai_chat_memory", &json!("true")).is_err());
        assert!(validate_setting("ai_chat_memory", &json!(1)).is_err());
        assert_eq!(
            default_settings("ws-1")
                .into_iter()
                .find(|(k, _)| *k == "ai_chat_memory")
                .map(|(_, v)| v),
            Some("true".to_string())
        );
    }

    // PLAN-2026-08-30 §4 W7 / 함정 #3: arm 없이는 저장이 조용히 실패한다 — 실제 DB 왕복까지 확인.
    #[test]
    fn test_validate_setting_seen_feature_briefs() {
        assert!(validate_setting("seen_feature_briefs", &json!([])).is_ok());
        assert!(validate_setting(
            "seen_feature_briefs",
            &json!(["ai_master", "sync_server", "__seeded_v1__"])
        )
        .is_ok());
        // empty-string id
        assert!(validate_setting("seen_feature_briefs", &json!([""])).is_err());
        // non-string entry
        assert!(validate_setting("seen_feature_briefs", &json!([1])).is_err());
        // not an array at all
        assert!(validate_setting("seen_feature_briefs", &json!("ai_master")).is_err());
        // 상한(64) 초과
        let too_many: Vec<String> = (0..65).map(|i| format!("id-{i}")).collect();
        assert!(validate_setting("seen_feature_briefs", &json!(too_many)).is_err());

        assert_eq!(
            default_settings("ws-1")
                .into_iter()
                .find(|(k, _)| *k == "seen_feature_briefs")
                .map(|(_, v)| v),
            Some("[]".to_string())
        );
    }

    // PLAN-2026-08-30 §6-A / 함정 #3: arm 없이는 저장이 조용히 실패한다.
    #[test]
    fn ai_policy_level_is_enum_and_defaults_to_organize() {
        assert!(validate_setting("ai_policy_level", &json!("gather")).is_ok());
        assert!(validate_setting("ai_policy_level", &json!("refine")).is_ok());
        assert!(validate_setting("ai_policy_level", &json!("organize")).is_ok());
        assert!(validate_setting("ai_policy_level", &json!("bogus")).is_err());
        assert!(validate_setting("ai_policy_level", &json!(true)).is_err());
        assert!(validate_setting("ai_policy_level", &json!(1)).is_err());
        assert_eq!(
            default_settings("ws-1")
                .into_iter()
                .find(|(k, _)| *k == "ai_policy_level")
                .map(|(_, v)| v),
            Some("\"organize\"".to_string()),
            "default must stay \"organize\" — anything else changes existing users' behavior"
        );
    }

    // PLAN-2026-09-05 (AI 가드) — 두 boolean 킬 스위치가 시드·검증·DB 왕복 모두 통과하는지.
    // arm 누락은 프런트 목으로는 안 잡히고 저장만 조용히 실패한다(CLAUDE.md 함정 #3).
    #[test]
    fn test_ai_guardrail_toggles_round_trip_through_settings_set() {
        for (key, default, flipped) in [
            ("ai_confirm_before_apply", true, false),
            ("ai_debug_verbose", false, true),
        ] {
            assert!(validate_setting(key, &json!(true)).is_ok());
            assert!(validate_setting(key, &json!(false)).is_ok());
            assert!(validate_setting(key, &json!("true")).is_err(), "{key} must reject strings");
            assert!(validate_setting(key, &json!(1)).is_err(), "{key} must reject numbers");

            let dir = tempfile::tempdir().unwrap();
            let mut conn = crate::db::bootstrap(dir.path()).unwrap();
            let before = crate::repo::settings::get_all(&conn).unwrap();
            assert_eq!(before.get(key), Some(&json!(default)), "{key} seed default");

            let mut entries = BTreeMap::new();
            entries.insert(key.to_string(), json!(flipped));
            crate::repo::settings::set(&mut conn, &entries).unwrap();
            let after = crate::repo::settings::get_all(&conn).unwrap();
            assert_eq!(after.get(key), Some(&json!(flipped)), "{key} must persist through set/get_all");
        }
    }

    // PLAN-2026-09-27 §7-4 (W5) — assist_preset_autorun 토글이 시드·검증·DB 왕복 모두 통과하는지.
    #[test]
    fn test_assist_preset_autorun_round_trip() {
        let key = "assist_preset_autorun";
        assert!(validate_setting(key, &json!(true)).is_ok());
        assert!(validate_setting(key, &json!(false)).is_ok());
        assert!(validate_setting(key, &json!("true")).is_err(), "{key} must reject strings");
        assert!(validate_setting(key, &json!(1)).is_err(), "{key} must reject numbers");

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get(key), Some(&json!(false)), "{key} seed default false");

        let mut entries = BTreeMap::new();
        entries.insert(key.to_string(), json!(true));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get(key), Some(&json!(true)), "{key} must persist true through set/get_all");
    }

    // 함정 #3: arm 없이는 저장이 조용히 실패한다. 프론트 목으로는 안 잡히므로 실제 DB 왕복.
    #[test]
    fn test_slide_preview_keys_round_trip_through_settings_set() {
        assert!(validate_setting("slide_preview", &json!("auto")).is_ok());
        assert!(validate_setting("slide_preview", &json!("off")).is_ok());
        assert!(validate_setting("slide_preview", &json!("on")).is_err());
        assert!(validate_setting("soffice_path", &json!("")).is_ok());
        assert!(validate_setting("soffice_path", &json!(1)).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("slide_preview"), Some(&json!("auto")));
        assert_eq!(before.get("soffice_path"), Some(&json!("")));

        let mut entries = BTreeMap::new();
        entries.insert("slide_preview".to_string(), json!("off"));
        entries.insert("soffice_path".to_string(), json!("C:/LibreOffice/program/soffice.exe"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("slide_preview"), Some(&json!("off")));
        assert_eq!(after.get("soffice_path"), Some(&json!("C:/LibreOffice/program/soffice.exe")));
    }

    #[test]
    fn test_ai_policy_level_round_trips_through_settings_set() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("ai_policy_level"), Some(&json!("organize")));

        let mut entries = BTreeMap::new();
        entries.insert("ai_policy_level".to_string(), json!("gather"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(
            after.get("ai_policy_level"),
            Some(&json!("gather")),
            "a missing/misvalidating allowlist arm for ai_policy_level would either reject the \
             whole settings_set call or silently drop the value — neither should happen"
        );
    }

    #[test]
    fn test_seen_feature_briefs_round_trips_through_settings_set() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("seen_feature_briefs"), Some(&json!([])));

        let list = json!(["ai_master", "ai_post_process", "__seeded_v1__"]);
        let mut entries = BTreeMap::new();
        entries.insert("seen_feature_briefs".to_string(), list.clone());
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(
            after.get("seen_feature_briefs"),
            Some(&list),
            "an allowlist arm missing/misvalidating for seen_feature_briefs would either reject \
             the whole settings_set call or silently drop the list — neither should happen"
        );
    }

    #[test]
    fn test_collect_chat_register_and_status_add_locked_round_trip() {
        // PLAN-2026-09-01 W0 — 새 키 2종. validate_setting 단위 검사만으로는 커맨드 계층이
        // 살아있는지 못 본다(docs/SETTINGS.md §2.2) — 실제 DB 왕복까지 확인한다.
        assert!(validate_setting("collect_chat_register", &json!(true)).is_ok());
        assert!(validate_setting("collect_chat_register", &json!("1")).is_err());
        assert!(validate_setting("status_add_locked", &json!(false)).is_ok());
        assert!(validate_setting("status_add_locked", &json!("0")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        // 둘 다 기본 OFF 로 시드된다 — 옵트인이므로 "키 없음"에 기대지 않고 명시적으로 심는다.
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("collect_chat_register"), Some(&json!(false)));
        assert_eq!(before.get("status_add_locked"), Some(&json!(false)));

        let mut entries = BTreeMap::new();
        entries.insert("collect_chat_register".to_string(), json!(true));
        entries.insert("status_add_locked".to_string(), json!(true));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(
            after.get("collect_chat_register"),
            Some(&json!(true)),
            "허용 목록 arm 이 없으면 settings_set 전체가 거부되거나 값이 조용히 사라진다"
        );
        assert_eq!(after.get("status_add_locked"), Some(&json!(true)));
    }

    #[test]
    fn test_collect_detect_pending_and_seen_round_trip() {
        // PLAN-2026-09-04-local-import §3b — 새 키 2종, 둘 다 시드하지 않는다(부재가 정상 상태 —
        // §2.4 docs/SETTINGS.md 의 "기기 로컬, 저장된 적 없음" 부류).
        assert!(validate_setting("collect_detect_pending", &json!(0)).is_ok());
        assert!(validate_setting("collect_detect_pending", &json!(99)).is_ok());
        assert!(validate_setting("collect_detect_pending", &json!(100)).is_err());
        assert!(validate_setting("collect_detect_pending", &json!(-1)).is_err());
        assert!(validate_setting("collect_detect_pending", &json!("3")).is_err());
        assert!(validate_setting("collect_detect_seen", &json!(true)).is_ok());
        assert!(validate_setting("collect_detect_seen", &json!("1")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        // 시드하지 않으므로 새 DB 에서는 키 자체가 없다 — "0/false 로 저장돼 있음"과는 다르다.
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("collect_detect_pending"), None);
        assert_eq!(before.get("collect_detect_seen"), None);

        let mut entries = BTreeMap::new();
        entries.insert("collect_detect_pending".to_string(), json!(7));
        entries.insert("collect_detect_seen".to_string(), json!(true));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(
            after.get("collect_detect_pending"),
            Some(&json!(7)),
            "허용 목록 arm 이 없으면 settings_set 전체가 거부되거나 값이 조용히 사라진다"
        );
        assert_eq!(after.get("collect_detect_seen"), Some(&json!(true)));
    }

    // 없어진 키는 쓰기 arm 이 없어야 한다 — 살아 있는 키를 RETIRED_KEYS 에 넣으면 가져오기가 그 값을
    // 조용히 버린다.
    #[test]
    fn retired_keys_are_not_writable() {
        for k in RETIRED_KEYS {
            assert!(validate_setting(k, &json!("1")).is_err(), "{k} is retired but still validates");
        }
    }

    /// 브리핑 화면 구성 키 5종(PLAN-2026-10-19-briefing-rewrite §9.1)이 **예전엔 통과하던 값**으로 남아
    /// 있는 기존 설치. 위 `"1"` 검사만으로는 arm 이 지워졌는지 모른다(briefing_layout 말고는 원래도
    /// `"1"` 을 거부했다) — 그래서 그때 실제로 저장되던 모양을 그대로 쓴다.
    fn retired_briefing_rows() -> [(&'static str, serde_json::Value); 5] {
        [
            ("briefing_layout", json!("a")),
            ("briefing_cards", json!([{"id": "habits", "enabled": true, "variant": "week-ring"}])),
            ("briefing_options", json!({"habit_range": "week", "tomorrow_limit": 3})),
            ("briefing_presets", json!([{"id": "a1", "name": "아침용", "view": {"v": 1, "blocks": []}, "saved_at": "2026-10-01T09:00:00Z"}])),
            ("briefing_view", json!({"v": 1, "blocks": [{"m": "habits", "w": 1, "h": 2, "x": 0, "y": 0}]})),
        ]
    }

    #[test]
    fn retired_briefing_keys_reject_their_old_values_and_are_not_seeded() {
        for (k, old) in retired_briefing_rows() {
            assert!(is_retired_setting_key(k), "{k} must be in RETIRED_KEYS");
            assert!(validate_setting(k, &old).is_err(), "{k} still has a write arm");
            assert!(default_settings("ws-1").iter().all(|(d, _)| *d != k), "{k} is still seeded");
        }
        // 미저장 표지로 쓰이던 빈 값들도 더는 받지 않는다.
        assert!(validate_setting("briefing_view", &json!("")).is_err());
        assert!(validate_setting("briefing_presets", &json!([])).is_err());
        assert!(validate_setting("briefing_cards", &json!([])).is_err());
        assert!(validate_setting("briefing_options", &json!({})).is_err());
        // 살아남는 브리핑 키는 그대로 쓸 수 있다(§9.1 — 은퇴는 다섯 개뿐).
        assert!(!is_retired_setting_key("briefing_last_seen"));
        assert!(validate_setting("briefing_last_seen", &json!("")).is_ok());
    }

    /// 은퇴 키를 실은 옛 백업(번들)이 replace 가져오기에서 통째로 거부되지 않는다. 가져오기는
    /// validate_setting 을 fail-closed 로 태우므로(transfer/import::insert_all) RETIRED_KEYS 가 빠지면
    /// 이 다섯 행 때문에 전체가 VALIDATION 으로 죽는다. merge 모드는 설정을 아예 안 가져오므로
    /// 이 검사는 반드시 replace 로 해야 한다(replace_merge.rs 의 같은 경고 참고).
    #[test]
    fn old_backup_carrying_retired_briefing_keys_still_imports() {
        use crate::repo::transfer::{db_reset, export_all, import_bundle};
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let mut conn = crate::db::bootstrap(&data_dir).unwrap();

        // 기존 설치의 묵은 행 — 신규 DB 시드가 예전엔 이 키들을 실제 행으로 남겼고, export 는 그 행을
        // 그대로 번들에 싣는다. 쓰기 경로(settings::set)는 이제 거부하므로 SQL 로 직접 심는다.
        for (k, v) in retired_briefing_rows() {
            conn.execute(
                "INSERT OR REPLACE INTO settings(key, value) VALUES (?1, ?2)",
                rusqlite::params![k, v.to_string()],
            )
            .unwrap();
        }
        // 살아 있는 전역 키 하나 — 가져오기가 설정을 실제로 복원했는지(공회전이 아닌지) 확인용.
        let mut live = BTreeMap::new();
        live.insert("briefing_time".to_string(), json!("07:30"));
        crate::repo::settings::set(&mut conn, &live).unwrap();

        let out = dir.path().join("export-out");
        export_all(&conn, &data_dir, &out).unwrap();
        let bundle = out.join("brise-bundle.json");
        let raw = std::fs::read_to_string(&bundle).unwrap();
        for (k, _) in retired_briefing_rows() {
            assert!(raw.contains(&format!("\"{k}\"")), "export must still carry the stale {k} row");
        }

        db_reset(&mut conn, &data_dir, "RESET").unwrap();
        import_bundle(&mut conn, &data_dir, &bundle, "replace", None, false)
            .expect("an old bundle carrying retired briefing keys must still import");

        let stored = |k: &str| -> Option<String> {
            conn.query_row("SELECT value FROM settings WHERE key = ?1", [k], |r| r.get(0)).ok()
        };
        for (k, _) in retired_briefing_rows() {
            assert_eq!(stored(k), None, "{k} must be dropped on import, not adopted");
        }
        assert_eq!(stored("briefing_time").as_deref(), Some("\"07:30\""));
        let all = crate::repo::settings::get_all(&conn).unwrap();
        for (k, _) in retired_briefing_rows() {
            assert_eq!(all.get(k), None, "{k} has no default any more");
        }
    }

    // PLAN-2026-09-15 R2 — pet_enabled 와 같은 문자열 플래그지만 이쪽은 **시드한다**
    // (기본 ON: 지금까지의 날씨/현지시간 동작이 업그레이드 후에도 그대로여야 한다).
    #[test]
    fn region_enabled_is_string_flag_seeded_on() {
        assert!(validate_setting("region_enabled", &json!("1")).is_ok());
        assert!(validate_setting("region_enabled", &json!("0")).is_ok());
        assert!(validate_setting("region_enabled", &json!(true)).is_err());
        assert_eq!(
            default_settings("ws-1")
                .into_iter()
                .find(|(k, _)| *k == "region_enabled")
                .map(|(_, v)| v),
            Some("\"1\"".to_string())
        );
    }

    // F-P01 쓰기 게이트 — 함정 #3: arm 이 없으면 사이드바 토글이 켜지는 것처럼 보이고
    // 재시작하면 꺼져 있다. 기본 true(현재 fail-open 과 같음).
    #[test]
    fn chat_write_enabled_is_boolean_and_defaults_on() {
        assert!(validate_setting("chat_write_enabled", &json!(true)).is_ok());
        assert!(validate_setting("chat_write_enabled", &json!(false)).is_ok());
        assert!(validate_setting("chat_write_enabled", &json!("true")).is_err());
        assert!(validate_setting("chat_write_enabled", &json!(1)).is_err());
        assert_eq!(
            default_settings("ws-1")
                .into_iter()
                .find(|(k, _)| *k == "chat_write_enabled")
                .map(|(_, v)| v),
            Some("true".to_string())
        );
    }

    #[test]
    fn chat_permissions_are_boolean_and_default_on() {
        for key in ["chat_read_history", "chat_read_files"] {
            assert!(validate_setting(key, &json!(true)).is_ok());
            assert!(validate_setting(key, &json!(false)).is_ok());
            assert!(validate_setting(key, &json!("true")).is_err());
            assert_eq!(
                default_settings("ws-1")
                    .into_iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| v),
                Some("true".to_string())
            );
        }
    }

    #[test]
    fn update_check_auto_is_boolean_and_defaults_on() {
        assert!(validate_setting("update_check_auto", &json!(true)).is_ok());
        assert!(validate_setting("update_check_auto", &json!(false)).is_ok());
        assert!(validate_setting("update_check_auto", &json!("true")).is_err());
        assert!(validate_setting("update_check_auto", &json!(1)).is_err());
        assert_eq!(
            default_settings("ws-1")
                .into_iter()
                .find(|(k, _)| *k == "update_check_auto")
                .map(|(_, v)| v),
            Some("true".to_string())
        );
    }

    // 리스크 감사 A: backup_auto_last_error 도 함정 #3 대상 — arm 없으면 record_auto_backup_error
    // (repo/transfer/backup.rs)의 settings::set 호출이 조용히 실패한다. default_settings 에는
    // 시드하지 않는다("없음" = 정상 상태이자 "실패한 적 없음"의 의미).
    #[test]
    fn backup_auto_last_error_is_string_and_not_seeded() {
        assert!(validate_setting("backup_auto_last_error", &json!("")).is_ok());
        assert!(validate_setting("backup_auto_last_error", &json!("2026-08-21T00:00:00Z: io error")).is_ok());
        assert!(validate_setting("backup_auto_last_error", &json!(123)).is_err());
        assert!(validate_setting("backup_auto_last_error", &json!(null)).is_err());
        assert!(default_settings("ws-1").into_iter().all(|(k, _)| k != "backup_auto_last_error"));
    }

    #[test]
    fn test_validate_setting_emoji_recent_and_favorites() {
        assert!(validate_setting("emoji_recent", &json!(["1f600", "0023-fe0f-20e3"])).is_ok());
        assert!(validate_setting("emoji_favorites", &json!([])).is_ok());
        // 경로이탈/비-hex 값은 거부
        assert!(validate_setting("emoji_recent", &json!(["../evil"])).is_err());
        assert!(validate_setting("emoji_recent", &json!(["1f600-"])).is_err());
        assert!(validate_setting("emoji_favorites", &json!("1f600")).is_err());
    }

    #[test]
    fn test_validate_setting_default_map_location() {
        assert!(validate_setting("default_map_location", &json!({"lat": 37.5665, "lng": 126.9780, "zoom": 5.0})).is_ok());
        // 지도의 줌 상한(400)까지 저장 가능해야 한다 — 기본값 서울이 zoom 50 이라 예전
        // 상한(12)에서는 기본값조차 거부됐다.
        assert!(validate_setting("default_map_location", &json!({"lat": 37.5665, "lng": 126.978, "zoom": 50.0})).is_ok());
        assert!(validate_setting("default_map_location", &json!({"lat": 37.5665, "lng": 126.978, "zoom": 401.0})).is_err());
        assert!(validate_setting("default_map_location", &json!({"lat": 100.0, "lng": 0.0, "zoom": 1.0})).is_err());
        assert!(validate_setting("default_map_location", &json!({"lat": 0.0, "lng": 0.0})).is_err());
    }

    #[test]
    fn test_validate_setting_briefing_keys() {
        assert!(validate_setting("briefing_enabled", &json!(false)).is_ok());
        assert!(validate_setting("briefing_enabled", &json!("true")).is_err());
        for w in ["time", "launch", "manual"] {
            assert!(validate_setting("briefing_when", &json!(w)).is_ok());
        }
        assert!(validate_setting("briefing_when", &json!("daily")).is_err());
        assert!(validate_setting("briefing_time", &json!("08:00")).is_ok());
        assert!(validate_setting("briefing_time", &json!("24:00")).is_err());
        assert!(validate_setting("briefing_time", &json!("8:00")).is_err());
        assert!(validate_setting("briefing_last_shown", &json!("")).is_ok());
        assert!(validate_setting("briefing_last_shown", &json!("2026-09-30")).is_ok());
        assert!(validate_setting("briefing_last_shown", &json!("2026-02-30")).is_err());
        assert!(validate_setting("briefing_last_shown", &json!("2026-09-30T08:00")).is_err());
        // 전역 키 — 노트북별이 아니다.
        assert!(!is_notebook_setting_key("briefing_time"));
    }

    #[test]
    fn test_validate_setting_briefing_w10_keys() {
        assert!(validate_setting("briefing_evening_enabled", &json!(true)).is_ok());
        assert!(validate_setting("briefing_evening_enabled", &json!("true")).is_err());
        assert!(validate_setting("briefing_evening_time", &json!("21:00")).is_ok());
        assert!(validate_setting("briefing_evening_time", &json!("24:00")).is_err());
        assert!(validate_setting("briefing_evening_time", &json!("9:00")).is_err());
        assert!(validate_setting("briefing_last_shown_evening", &json!("")).is_ok());
        assert!(validate_setting("briefing_last_shown_evening", &json!("2026-10-01")).is_ok());
        assert!(validate_setting("briefing_last_shown_evening", &json!("2026-02-30")).is_err());
        for n in ["window", "os", "both"] {
            assert!(validate_setting("briefing_notify", &json!(n)).is_ok());
        }
        assert!(validate_setting("briefing_notify", &json!("toast")).is_err());
        assert!(validate_setting("briefing_notify", &json!(true)).is_err());
        for k in ["briefing_evening_enabled", "briefing_evening_time", "briefing_last_shown_evening", "briefing_notify"] {
            assert!(!is_notebook_setting_key(k), "{k}");
        }
        // 왕복: 기본값이 시드되고, 저장한 값이 돌아온다(allowlist arm 누락 = 조용한 저장 실패 방지).
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let all = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(all.get("briefing_evening_enabled"), Some(&json!(false)));
        assert_eq!(all.get("briefing_evening_time"), Some(&json!("21:00")));
        assert_eq!(all.get("briefing_notify"), Some(&json!("window")));
        let mut e = std::collections::BTreeMap::new();
        e.insert("briefing_notify".to_string(), json!("both"));
        e.insert("briefing_evening_enabled".to_string(), json!(true));
        crate::repo::settings::set(&mut conn, &e).unwrap();
        let all = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(all.get("briefing_notify"), Some(&json!("both")));
        assert_eq!(all.get("briefing_evening_enabled"), Some(&json!(true)));
    }

    #[test]
    fn test_validate_setting_filter_roster() {
        assert!(validate_setting(
            "filter_roster",
            &json!([{"mode": "region", "enabled": true}, {"mode": "calendar", "enabled": false}])
        )
        .is_ok());
        // Empty is valid — the "never saved yet" default.
        assert!(validate_setting("filter_roster", &json!([])).is_ok());
        // tree is not a roster entry (always shown, not togglable).
        assert!(validate_setting("filter_roster", &json!([{"mode": "tree", "enabled": true}])).is_err());
        assert!(validate_setting("filter_roster", &json!([{"mode": "region"}])).is_err());
        assert!(validate_setting("filter_roster", &json!([{"mode": "region", "enabled": "yes"}])).is_err());
        assert!(validate_setting("filter_roster", &json!("region")).is_err());
    }

    #[test]
    fn test_validate_setting_ai_action_presets() {
        assert!(validate_setting("ai_action_presets", &json!([])).is_ok());
        assert!(validate_setting(
            "ai_action_presets",
            &json!([
                {"id": "list", "name": "리스트로 만들기", "prompt": "...", "kind": "text", "isBuiltin": true, "hidden": false},
                {"id": "custom-1", "name": "메모", "prompt": "...", "kind": "text", "isBuiltin": false, "hidden": false},
                {"id": "metadata", "name": "데이터 자동 채우기", "prompt": "...", "kind": "metadata", "isBuiltin": true, "hidden": true},
                {"id": "diagram", "name": "관계도 만들기", "prompt": "...", "kind": "diagram", "isBuiltin": true, "hidden": false},
                {"id": "sheet", "name": "시트 만들기", "prompt": "...", "kind": "sheet", "isBuiltin": true, "hidden": false},
                {"id": "auto_footnote", "name": "자동 각주", "prompt": "", "kind": "tool", "isBuiltin": true, "hidden": false, "blank": false, "order": 5},
                {"id": "start_text", "name": "글 시작하기", "prompt": "...", "kind": "text", "isBuiltin": true, "hidden": false, "blank": true, "order": 6},
            ])
        )
        .is_ok());

        // missing id
        assert!(validate_setting("ai_action_presets", &json!([{"name": "x", "prompt": "y", "kind": "text", "isBuiltin": true, "hidden": false}])).is_err());
        // bad kind
        assert!(validate_setting("ai_action_presets", &json!([{"id": "a", "name": "x", "prompt": "y", "kind": "bogus", "isBuiltin": true, "hidden": false}])).is_err());
        // isBuiltin not boolean
        assert!(validate_setting("ai_action_presets", &json!([{"id": "a", "name": "x", "prompt": "y", "kind": "text", "isBuiltin": "yes", "hidden": false}])).is_err());
        assert!(validate_setting("ai_action_presets", &json!("nope")).is_err());
    }

    // 함정 3(설정 키 allowlist) — kind 를 늘렸는데 이 arm 을 안 늘리면 프런트가 template 프리셋을
    // 하나라도 만드는 순간 **리스트 전체**의 저장이 조용히 실패한다(withPersist 가 롤백만 하고
    // 넘어간다). 프런트 목으로는 안 잡히므로 실제 DB 왕복(set → get_all)까지 확인한다.
    #[test]
    fn test_ai_action_presets_tile_fields_optional_and_typed() {
        // PLAN-2026-09-15-askai-composer §2.1: 필드 없음 → OK, 있으면 타입/enum 검사.
        let base = json!({"id": "translate", "name": "번역", "prompt": "…{{lang}}…", "kind": "text", "isBuiltin": true, "hidden": false});
        assert!(validate_setting("ai_action_presets", &json!([base])).is_ok());
        let mut full = base.as_object().unwrap().clone();
        full.insert("label".into(), json!("번역"));
        full.insert("icon".into(), json!("languages"));
        full.insert("targets".into(), json!(["note", "section", "selection"]));
        full.insert("where".into(), json!("section"));
        full.insert("proposal".into(), json!("tags"));
        full.insert("needs".into(), json!(["body", "folder", "weather"]));
        assert!(validate_setting("ai_action_presets", &json!([full.clone()])).is_ok());
        for (k, bad) in [
            ("label", json!(3)),
            ("targets", json!(["canvas"])),
            ("targets", json!("note")),
            ("where", json!("body")),
            ("proposal", json!("merge")),
            ("needs", json!(["ctx"])),
            ("needs", json!("body")),
        ] {
            let mut broken = full.clone();
            broken.insert(k.into(), bad);
            assert!(validate_setting("ai_action_presets", &json!([broken])).is_err(), "{k} should be rejected");
        }
    }

    #[test]
    fn test_ai_action_presets_template_kind_round_trips() {
        use std::collections::BTreeMap;
        assert!(validate_setting(
            "ai_action_presets",
            &json!([{"id": "tpl-1", "name": "회고", "prompt": "## 잘한 것\n\n", "kind": "template", "isBuiltin": false, "hidden": false}])
        )
        .is_ok());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        let list = json!([
            {"id": "list", "name": "리스트로 만들기", "prompt": "...", "kind": "text", "isBuiltin": true, "hidden": false},
            {"id": "tpl-1", "name": "회고", "prompt": "## 잘한 것\n\n", "kind": "template", "isBuiltin": false, "hidden": false},
        ]);
        let mut entries = BTreeMap::new();
        entries.insert("ai_action_presets".to_string(), list.clone());
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(
            after.get("ai_action_presets"),
            Some(&list),
            "kind:\"template\" must survive settings_set → settings_get_all verbatim — a missing \
             allowlist arm rejects the WHOLE list, not just the template entry"
        );
    }

    #[test]
    fn test_ai_action_presets_tool_and_fields_round_trip() {
        use std::collections::BTreeMap;
        let list = json!([
            {
                "id": "auto_footnote",
                "name": "자동 각주",
                "prompt": "",
                "kind": "tool",
                "isBuiltin": true,
                "hidden": false,
                "blank": false,
                "order": 1,
                "targets": ["note", "section"]
            },
            {
                "id": "start_text",
                "name": "글 시작하기",
                "prompt": "주제: {{text:주제}}",
                "kind": "text",
                "isBuiltin": true,
                "hidden": false,
                "blank": true,
                "order": 2,
                "targets": ["note"]
            }
        ]);
        assert!(validate_setting("ai_action_presets", &list).is_ok());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        let mut entries = BTreeMap::new();
        entries.insert("ai_action_presets".to_string(), list.clone());
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(
            after.get("ai_action_presets"),
            Some(&list),
            "kind:\"tool\", blank:bool, order:int must survive settings round-trip"
        );
    }

    #[test]
    fn test_validate_setting_ai_internal_instructions() {
        assert!(validate_setting("ai_internal_instructions", &json!({})).is_ok());
        assert!(validate_setting(
            "ai_internal_instructions",
            &json!({
                "metadata": "커스텀 메타데이터 기준",
                "diagram": "커스텀 관계도 규칙"
            })
        )
        .is_ok());

        // not an object
        assert!(validate_setting("ai_internal_instructions", &json!("string")).is_err());
        assert!(validate_setting("ai_internal_instructions", &json!([])).is_err());
        // value not a string
        assert!(validate_setting("ai_internal_instructions", &json!({"metadata": 123})).is_err());
    }

    #[test]
    fn ai_provider_creds_accepts_bounded_object_of_string_creds() {
        assert!(validate_setting("ai_provider_creds", &json!({})).is_ok());
        assert!(validate_setting(
            "ai_provider_creds",
            &json!({ "openai": { "api_key": "sk-a", "endpoint": "" }, "gemini": { "api_key": "AIza" }, "legacy-x": {} })
        )
        .is_ok());
        // 모양 위반
        assert!(validate_setting("ai_provider_creds", &json!([])).is_err());
        assert!(validate_setting("ai_provider_creds", &json!("sk")).is_err());
        assert!(validate_setting("ai_provider_creds", &json!({ "openai": "sk" })).is_err());
        assert!(validate_setting("ai_provider_creds", &json!({ "openai": { "api_key": 1 } })).is_err());
        assert!(validate_setting("ai_provider_creds", &json!({ "openai": { "model": "x" } })).is_err());
        assert!(validate_setting("ai_provider_creds", &json!({ "OpenAI": { "api_key": "x" } })).is_err());
        assert!(validate_setting("ai_provider_creds", &json!({ "": { "api_key": "x" } })).is_err());
        // 크기 상한
        assert!(validate_setting("ai_provider_creds", &json!({ "openai": { "api_key": "x".repeat(4097) } })).is_err());
        let many: serde_json::Map<String, serde_json::Value> =
            (0..17).map(|i| (format!("p{i}"), json!({}))).collect();
        assert!(validate_setting("ai_provider_creds", &serde_json::Value::Object(many)).is_err());
        // 시드는 빈 객체, 앱 전역(노트북 키 아님)
        assert_eq!(
            default_settings("ws-1").into_iter().find(|(k, _)| *k == "ai_provider_creds").map(|(_, v)| v),
            Some("{}".to_string())
        );
        assert!(!is_notebook_setting_key("ai_provider_creds"));
        assert!(crate::repo::transfer::export::is_secret_setting_key("ai_provider_creds"));
    }

    #[test]
    fn ai_provider_creds_round_trips_through_settings_set() {
        let creds = json!({ "openai": { "api_key": "sk-openai", "endpoint": "https://example.test/v1" } });
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let mut entries = BTreeMap::new();
        entries.insert("ai_provider".to_string(), json!("gemini"));
        entries.insert("ai_api_key".to_string(), json!(""));
        entries.insert("ai_provider_creds".to_string(), creds.clone());
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("ai_provider_creds"), Some(&creds));
    }

    #[test]
    fn test_ai_internal_instructions_round_trips() {
        use std::collections::BTreeMap;
        let instructions = json!({
            "metadata": "메타데이터 판단 기준: 태그는 한글 3단어 이내.",
            "diagram": "관계도 JSON 형식: 노드 최대 10개."
        });

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        let mut entries = BTreeMap::new();
        entries.insert("ai_internal_instructions".to_string(), instructions.clone());
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(
            after.get("ai_internal_instructions"),
            Some(&instructions),
            "ai_internal_instructions must survive settings_set → settings_get_all verbatim"
        );
    }

    // Bug fix 검증: settings_set이 "unknown setting key: note_presets"로 매번 VALIDATION 거부하던
    // 회귀 — stores/presets.ts::saveFromNote가 낙관적으로 메모리에 넣은 뒤 이 커맨드로 영속을
    // 시도하면 여기서 막혀 즉시 롤백됐고, TabBar의 "프리셋으로 저장"이 PresetList/
    // TreeHeaderActions에 절대 나타나지 않았다(허용 키 목록에 이 키 자체가 없었음).
    #[test]
    fn test_validate_setting_note_presets() {
        assert!(validate_setting("note_presets", &json!([])).is_ok());
        assert!(validate_setting(
            "note_presets",
            &json!([{"id": "a1", "name": "여행 메모", "bodyMd": "<p>packing list</p>"}])
        )
        .is_ok());
        // missing id
        assert!(validate_setting("note_presets", &json!([{"name": "x", "bodyMd": "y"}])).is_err());
        // missing name
        assert!(validate_setting("note_presets", &json!([{"id": "a", "bodyMd": "y"}])).is_err());
        // missing bodyMd
        assert!(validate_setting("note_presets", &json!([{"id": "a", "name": "x"}])).is_err());
        // bodyMd not a string
        assert!(validate_setting("note_presets", &json!([{"id": "a", "name": "x", "bodyMd": 1}])).is_err());
        assert!(validate_setting("note_presets", &json!("nope")).is_err());
    }

    // 프리셋 모달 "제거"(빌트인은 삭제 대신 hidden) — 저장되는 값은 알려진 7개 id로만 제한된다.
    #[test]
    fn test_validate_setting_note_presets_hidden_builtins() {
        assert!(validate_setting("note_presets_hidden_builtins", &json!([])).is_ok());
        assert!(validate_setting("note_presets_hidden_builtins", &json!(["blank", "diagram"])).is_ok());
        assert!(validate_setting("note_presets_hidden_builtins", &json!(["ai"])).is_ok());
        // "budget" (가계부 시트 템플릿, 2026-08-19) — "sheet"(빈 시트)와 별개 빌트인.
        assert!(validate_setting("note_presets_hidden_builtins", &json!(["sheet", "budget"])).is_ok());
        // unknown id rejected — not one of the 7 static builtins
        assert!(validate_setting("note_presets_hidden_builtins", &json!(["not_a_builtin"])).is_err());
        assert!(validate_setting("note_presets_hidden_builtins", &json!([1])).is_err());
        assert!(validate_setting("note_presets_hidden_builtins", &json!("blank")).is_err());
    }

    #[test]
    fn test_note_presets_hidden_builtins_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        let before = crate::repo::settings::get_all(&conn).unwrap();
        // Never saved yet — key absent, frontend falls back to [] (same as note_presets).
        assert_eq!(before.get("note_presets_hidden_builtins"), None);

        let mut entries = BTreeMap::new();
        entries.insert(
            "note_presets_hidden_builtins".to_string(),
            json!(["blank", "todo"]),
        );
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(
            after.get("note_presets_hidden_builtins"),
            Some(&json!(["blank", "todo"])),
            "note_presets_hidden_builtins must round-trip through settings_set → settings_get_all — \
             a missing validate_setting allowlist arm would make set() return Err before ever \
             reaching the DB"
        );
    }

    // 에디터 너비 토글 — 이 코드베이스의 알려진 함정: validate_setting 허용 목록에 항목을
    // 빠뜨리면 settings_set 이 매번 VALIDATION 으로 거부한다(default 매치암 `_ => Err`, 위
    // validate_setting 끝부분). 프런트(settings.ts) 여러 setter 가 그 실패를 .catch(()=>{})로
    // 삼키므로 사용자 눈엔 "토글은 켜졌는데 재시작하면 원래대로"인 조용한 저장 실패로 보인다 —
    // validate_setting 단독 테스트로 끝내지 않고, 아래에서 실제 DB 왕복(set → get_all)까지
    // 검증해 그 실패 모드 전체를 봉인한다.
    #[test]
    fn test_validate_setting_editor_full_width() {
        assert!(validate_setting("editor_full_width", &json!(true)).is_ok());
        assert!(validate_setting("editor_full_width", &json!(false)).is_ok());
        assert!(validate_setting("editor_full_width", &json!("true")).is_err());
        assert!(validate_setting("editor_full_width", &json!(1)).is_err());
    }

    // QA8 Wave 3A — search autocomplete history. validate_setting alone is not enough (the
    // classic pitfall): settings_set must actually persist through the repo. Shape checks +
    // DB round-trip below seal the full path.
    #[test]
    fn test_validate_setting_search_recent() {
        assert!(validate_setting("search_recent", &json!([])).is_ok());
        assert!(validate_setting("search_recent", &json!(["silla", "baekje"])).is_ok());
        // empty string item rejected
        assert!(validate_setting("search_recent", &json!([""])).is_err());
        // non-string item
        assert!(validate_setting("search_recent", &json!([1])).is_err());
        // not an array
        assert!(validate_setting("search_recent", &json!("silla")).is_err());
        // over per-item length
        let long = "x".repeat(201);
        assert!(validate_setting("search_recent", &json!([long])).is_err());
    }

    // QA8 Wave 4A — reopen-closed-tab list (settings kv, separate from activity_log).
    #[test]
    fn test_validate_setting_recent_closed_tabs() {
        assert!(validate_setting("recent_closed_tabs", &json!([])).is_ok());
        assert!(validate_setting("recent_closed_tabs", &json!(["note-a", "note-b"])).is_ok());
        assert!(validate_setting("recent_closed_tabs", &json!([""])).is_err());
        assert!(validate_setting("recent_closed_tabs", &json!([1])).is_err());
        assert!(validate_setting("recent_closed_tabs", &json!("note-a")).is_err());
        let long = "x".repeat(65);
        assert!(validate_setting("recent_closed_tabs", &json!([long])).is_err());
    }

    #[test]
    fn test_recent_closed_tabs_setting_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("recent_closed_tabs"), Some(&json!([])));

        let mut entries = BTreeMap::new();
        entries.insert(
            "recent_closed_tabs".to_string(),
            json!(["n1", "n2", "n3"]),
        );
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(
            after.get("recent_closed_tabs"),
            Some(&json!(["n1", "n2", "n3"])),
            "recent_closed_tabs must round-trip through settings_set → settings_get_all — a missing \
             validate_setting allowlist arm would make set() return Err before ever reaching the DB"
        );
    }

    #[test]
    fn test_search_recent_setting_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("search_recent"), Some(&json!([])));

        let mut entries = BTreeMap::new();
        entries.insert(
            "search_recent".to_string(),
            json!(["silla", "baekje", "goguryeo"]),
        );
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(
            after.get("search_recent"),
            Some(&json!(["silla", "baekje", "goguryeo"])),
            "search_recent must round-trip through settings_set → settings_get_all — a missing \
             validate_setting allowlist arm would make set() return Err before ever reaching the DB"
        );
    }

    #[test]
    fn test_editor_full_width_setting_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        // 기본값 — 시딩된 새 DB는 editor_full_width 를 쓴 적이 없어도 false 로 읽혀야 한다
        // (default_settings() 폴백; 프런트 defaultSettings()의 editorFullWidth:false 와 일치).
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("editor_full_width"), Some(&json!(false)));

        let mut entries = BTreeMap::new();
        entries.insert("editor_full_width".to_string(), json!(true));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(
            after.get("editor_full_width"),
            Some(&json!(true)),
            "editor_full_width must round-trip through settings_set → settings_get_all — a \
             missing validate_setting allowlist arm would make set() return Err before ever \
             reaching the DB, and this assertion would catch it"
        );
    }


    // 함정 3 봉인 — arm 이 빠지면 설정 화면의 "폴백 모델" 칸이 저장되는 것처럼 보이고 재시작하면
    // 사라진다(프런트가 .catch(()=>{}) 로 삼킨다). 형식 검증 + 실제 DB 왕복까지 확인한다.
    #[test]
    fn test_ai_model_fallback_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("ai_model_fallback", &json!("gemma-4-31b")).is_ok());
        assert!(validate_setting("ai_model_fallback", &json!("")).is_ok());
        assert!(validate_setting("ai_model_fallback", &json!(42)).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("ai_model_fallback"), Some(&json!("")));

        let mut entries = BTreeMap::new();
        entries.insert("ai_model_fallback".to_string(), json!("gemma-4-31b"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("ai_model_fallback"), Some(&json!("gemma-4-31b")));
    }

    // 함정 3 봉인 — 일정 알림 3키(docs/PLAN-schedule-system.md §5.5). arm 이 빠지면 (a) 설정의
    // 알림 토글이 켜지는 것처럼 보이고 재시작하면 꺼져 있으며, (b) 워터마크 저장이 매 틱 실패해
    // 같은 알림이 1분마다 다시 울린다. 형식 검증 + 실제 DB 왕복까지 확인한다.
    #[test]
    fn test_validate_setting_notification_keys() {
        assert!(validate_setting("notifications_enabled", &json!(true)).is_ok());
        assert!(validate_setting("notifications_enabled", &json!(false)).is_ok());
        assert!(validate_setting("notifications_enabled", &json!("true")).is_err());

        assert!(validate_setting("reminder_all_day_at", &json!("00:00")).is_ok());
        assert!(validate_setting("reminder_all_day_at", &json!("23:59")).is_ok());
        // DB CHECK 의 GLOB 가 통과시키는 값들도 여기서 막힌다.
        assert!(validate_setting("reminder_all_day_at", &json!("24:00")).is_err());
        assert!(validate_setting("reminder_all_day_at", &json!("9:00")).is_err());
        assert!(validate_setting("reminder_all_day_at", &json!(900)).is_err());

        assert!(validate_setting("reminder_last_tick_at", &json!("2026-08-09T09:00")).is_ok());
        assert!(validate_setting("reminder_last_tick_at", &json!("2026-08-09")).is_err());
        assert!(validate_setting("reminder_last_tick_at", &json!("2026-02-29T09:00")).is_err());
    }

    #[test]
    fn test_notification_settings_persist_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        let before = crate::repo::settings::get_all(&conn).unwrap();
        // 2026-08-09 오너 확정: 마스터는 기본 OFF, 종일 기준 시각은 00:00.
        assert_eq!(before.get("notifications_enabled"), Some(&json!(false)));
        assert_eq!(before.get("reminder_all_day_at"), Some(&json!("00:00")));
        // 워터마크는 시드하지 않는다 — 부재 = 첫 실행(과거 소급 발화 없음).
        assert_eq!(before.get("reminder_last_tick_at"), None);

        let mut entries = BTreeMap::new();
        entries.insert("notifications_enabled".to_string(), json!(true));
        entries.insert("reminder_all_day_at".to_string(), json!("09:00"));
        entries.insert("reminder_last_tick_at".to_string(), json!("2026-08-09T09:00"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("notifications_enabled"), Some(&json!(true)));
        assert_eq!(after.get("reminder_all_day_at"), Some(&json!("09:00")));
        assert_eq!(
            after.get("reminder_last_tick_at"),
            Some(&json!("2026-08-09T09:00")),
            "워터마크가 저장되지 않으면 틱이 매분 같은 창을 다시 보고 알림이 반복된다"
        );
    }

    #[test]
    fn test_validate_setting_week_start() {
        assert!(validate_setting("week_start", &json!("sunday")).is_ok());
        assert!(validate_setting("week_start", &json!("monday")).is_ok());
        assert!(validate_setting("week_start", &json!("tuesday")).is_err());
    }

    #[test]
    fn test_validate_setting_calendar_axis_tail_hours() {
        assert!(validate_setting("calendar_axis_tail_hours", &json!(0)).is_ok());
        assert!(validate_setting("calendar_axis_tail_hours", &json!(3)).is_ok());
        assert!(validate_setting("calendar_axis_tail_hours", &json!(12)).is_ok());
        assert!(validate_setting("calendar_axis_tail_hours", &json!(13)).is_err());
        assert!(validate_setting("calendar_axis_tail_hours", &json!(-1)).is_err());
        assert!(validate_setting("calendar_axis_tail_hours", &json!("3")).is_err());
        assert!(validate_setting("calendar_axis_tail_hours", &json!(true)).is_err());
    }

    #[test]
    fn test_calendar_axis_tail_hours_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("calendar_axis_tail_hours"), Some(&json!(3)));

        let mut entries = BTreeMap::new();
        entries.insert("calendar_axis_tail_hours".to_string(), json!(0));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("calendar_axis_tail_hours"), Some(&json!(0)));
    }

    #[test]
    fn test_dashboard_tab_settings_validate_and_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("timeline_default_range", &json!("recent_3m")).is_ok());
        assert!(validate_setting("timeline_default_range", &json!("all")).is_err());
        assert!(validate_setting("board_done_autohide", &json!("30d")).is_ok());
        assert!(validate_setting("board_done_autohide", &json!("1d")).is_err());
        assert!(validate_setting("board_card_thumb", &json!(false)).is_ok());
        assert!(validate_setting("board_card_date", &json!("no")).is_err());
        assert!(validate_setting("graph_hide_isolated", &json!(true)).is_ok());
        assert!(validate_setting("graph_node_cap", &json!(200)).is_ok());
        assert!(validate_setting("graph_node_cap", &json!(501)).is_err());
        assert!(validate_setting("graph_node_cap", &json!("100")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("timeline_default_range"), Some(&json!("fit")));
        assert_eq!(before.get("board_done_autohide"), Some(&json!("off")));
        assert_eq!(before.get("board_card_thumb"), Some(&json!(true)));
        assert_eq!(before.get("board_card_date"), Some(&json!(true)));
        assert_eq!(before.get("graph_hide_isolated"), Some(&json!(false)));
        assert_eq!(before.get("graph_node_cap"), Some(&json!(0)));
        let mut entries = BTreeMap::new();
        entries.insert("timeline_default_range".to_string(), json!("recent_1y"));
        entries.insert("board_done_autohide".to_string(), json!("7d"));
        entries.insert("board_card_thumb".to_string(), json!(false));
        entries.insert("graph_hide_isolated".to_string(), json!(true));
        entries.insert("graph_node_cap".to_string(), json!(200));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("timeline_default_range"), Some(&json!("recent_1y")));
        assert_eq!(after.get("board_done_autohide"), Some(&json!("7d")));
        assert_eq!(after.get("board_card_thumb"), Some(&json!(false)));
        assert_eq!(after.get("graph_hide_isolated"), Some(&json!(true)));
        assert_eq!(after.get("graph_node_cap"), Some(&json!(200)));
    }

    #[test]
    fn test_gallery_settings_validate_and_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("gallery_tile_size", &json!("large")).is_ok());
        assert!(validate_setting("gallery_tile_size", &json!("huge")).is_err());
        assert!(validate_setting("gallery_sort", &json!("name")).is_ok());
        assert!(validate_setting("gallery_sort", &json!("size")).is_err());
        assert!(validate_setting("gallery_show_names", &json!(true)).is_ok());
        assert!(validate_setting("gallery_show_names", &json!("1")).is_err());
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("gallery_tile_size"), Some(&json!("medium")));
        assert_eq!(before.get("gallery_sort"), Some(&json!("newest")));
        assert_eq!(before.get("gallery_show_names"), Some(&json!(false)));
        let mut entries = BTreeMap::new();
        entries.insert("gallery_tile_size".to_string(), json!("small"));
        entries.insert("gallery_sort".to_string(), json!("oldest"));
        entries.insert("gallery_show_names".to_string(), json!(true));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("gallery_tile_size"), Some(&json!("small")));
        assert_eq!(after.get("gallery_sort"), Some(&json!("oldest")));
        assert_eq!(after.get("gallery_show_names"), Some(&json!(true)));
    }

    #[test]
    fn test_export_default_dir_validates_and_round_trips() {
        use std::collections::BTreeMap;
        assert!(validate_setting("export_default_dir", &json!("")).is_ok());
        assert!(validate_setting("export_default_dir", &json!("D:\\exports")).is_ok());
        assert!(validate_setting("export_default_dir", &json!("a\u{0}b")).is_err());
        // 상대 경로·드라이브 상대("C:x")는 거부 — 절대 경로만.
        for rel in ["relative/dir", "exports", "..\\x", "C:exports", "./x"] {
            assert!(validate_setting("export_default_dir", &json!(rel)).is_err(), "{rel} must be rejected");
        }
        for abs in ["D:/exports", "\\\\server\\share\\exports", "/home/me/exports"] {
            assert!(validate_setting("export_default_dir", &json!(abs)).is_ok(), "{abs} must be accepted");
        }
        assert!(validate_setting("export_default_dir", &json!("D:\\a\u{0}b")).is_err());
        assert!(validate_setting("export_default_dir", &json!("x".repeat(1025))).is_err());
        assert!(validate_setting("export_default_dir", &json!(5)).is_err());
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("export_default_dir"), Some(&json!("")));
        let mut entries = BTreeMap::new();
        entries.insert("export_default_dir".to_string(), json!("D:\\exports"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("export_default_dir"), Some(&json!("D:\\exports")));
    }

    #[test]
    fn test_storage_alert_gb_validates_and_round_trips() {
        use std::collections::BTreeMap;
        assert!(validate_setting("storage_alert_gb", &json!(0)).is_ok());
        assert!(validate_setting("storage_alert_gb", &json!(500)).is_ok());
        assert!(validate_setting("storage_alert_gb", &json!(501)).is_err());
        assert!(validate_setting("storage_alert_gb", &json!(-1)).is_err());
        assert!(validate_setting("storage_alert_gb", &json!("5")).is_err());
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("storage_alert_gb"), Some(&json!(0)));
        let mut entries = BTreeMap::new();
        entries.insert("storage_alert_gb".to_string(), json!(5));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("storage_alert_gb"), Some(&json!(5)));
    }

    #[test]
    fn test_validate_setting_holiday_region() {
        assert!(validate_setting("holiday_region", &json!("none")).is_ok());
        assert!(validate_setting("holiday_region", &json!("kr")).is_ok());
        assert!(validate_setting("holiday_region", &json!("fr")).is_ok());
        assert!(validate_setting("holiday_region", &json!("jp")).is_err());
        assert!(validate_setting("holiday_region", &json!(true)).is_err());
    }

    #[test]
    fn test_week_start_setting_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("week_start"), Some(&json!("sunday")));

        let mut entries = BTreeMap::new();
        entries.insert("week_start".to_string(), json!("monday"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("week_start"), Some(&json!("monday")));
    }

    #[test]
    fn test_briefing_last_seen_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("briefing_last_seen", &json!("")).is_ok());
        assert!(validate_setting("briefing_last_seen", &json!("2026-10-01T03:00:00.000Z")).is_ok());
        assert!(validate_setting("briefing_last_seen", &json!("2026-10-01")).is_err());
        assert!(validate_setting("briefing_last_seen", &json!(5)).is_err());
        assert!(!is_notebook_setting_key("briefing_last_seen"));
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        assert_eq!(crate::repo::settings::get_all(&conn).unwrap().get("briefing_last_seen"), Some(&json!("")));
        let mut e = BTreeMap::new();
        e.insert("briefing_last_seen".to_string(), json!("2026-10-01T03:00:00.000Z"));
        crate::repo::settings::set(&mut conn, &e).unwrap();
        assert_eq!(
            crate::repo::settings::get_all(&conn).unwrap().get("briefing_last_seen"),
            Some(&json!("2026-10-01T03:00:00.000Z"))
        );
    }

    // close_to_tray 부활(2026-08) — 기본값이 true 여야 지금까지의 무조건 트레이-숨김 동작과
    // 동일하다(false 였다면 기존 사용자 전원이 업그레이드 즉시 X=종료로 바뀐다).
    #[test]
    fn test_validate_setting_close_to_tray() {
        assert!(validate_setting("close_to_tray", &json!(true)).is_ok());
        assert!(validate_setting("close_to_tray", &json!(false)).is_ok());
        assert!(validate_setting("close_to_tray", &json!("true")).is_err());
    }

    #[test]
    fn test_close_to_tray_defaults_true_and_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("close_to_tray"), Some(&json!(true)));

        let mut entries = BTreeMap::new();
        entries.insert("close_to_tray".to_string(), json!(false));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("close_to_tray"), Some(&json!(false)));
    }

    // 함정 #3(allowlist): arm 이 없으면 settings_set 이 조용히 실패한다 — 프론트 목으로는 안
    // 잡히므로 실제 DB 왕복으로 확인한다(docs/PLAN-2026-08-09-pet-capture.md Phase 1 §3).
    #[test]
    fn capture_screenshot_enabled_is_off_by_default_and_survives_a_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("capture_screenshot_enabled", &json!("0")).is_ok());
        assert!(validate_setting("capture_screenshot_enabled", &json!("1")).is_ok());
        // pet_enabled 와 같은 "0"/"1" 문자열 규칙 — boolean 으로 착각하지 말 것.
        assert!(validate_setting("capture_screenshot_enabled", &json!(true)).is_err());
        assert!(validate_setting("capture_screenshot_enabled", &json!("2")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        // Q7: 신규 수집 채널은 기본 OFF — 시드하지 않으므로 키 자체가 없다.
        assert_eq!(
            crate::repo::settings::get_all(&conn).unwrap().get("capture_screenshot_enabled"),
            None
        );

        let mut entries = BTreeMap::new();
        entries.insert("capture_screenshot_enabled".to_string(), json!("1"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        assert_eq!(
            crate::repo::settings::get_all(&conn).unwrap().get("capture_screenshot_enabled"),
            Some(&json!("1"))
        );
    }

    /// 화면 저장 폴더 — 함정 #3(allowlist), 실제 DB 왕복. 시드 없음 = 기본 폴더.
    #[test]
    fn capture_screenshot_dir_accepts_empty_or_absolute_and_survives_a_round_trip() {
        use std::collections::BTreeMap;
        let abs = std::env::temp_dir().join("brise-shots").to_string_lossy().to_string();
        assert!(validate_setting("capture_screenshot_dir", &json!("")).is_ok());
        assert!(validate_setting("capture_screenshot_dir", &json!(abs)).is_ok());
        assert!(validate_setting("capture_screenshot_dir", &json!("relative/dir")).is_err());
        assert!(validate_setting("capture_screenshot_dir", &json!(1)).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        assert_eq!(crate::repo::settings::get_all(&conn).unwrap().get("capture_screenshot_dir"), None);
        let mut entries = BTreeMap::new();
        entries.insert("capture_screenshot_dir".to_string(), json!(abs));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        assert_eq!(crate::repo::settings::get_all(&conn).unwrap().get("capture_screenshot_dir"), Some(&json!(abs)));
    }

    /// ingest 리스너 자격증명 2종 — 같은 함정 #3(allowlist) 때문에 실제 DB 왕복으로 확인한다.
    #[test]
    fn capture_ingest_keys_are_absent_by_default_and_survive_a_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("capture_ingest_token", &json!("abc")).is_ok());
        assert!(validate_setting("capture_ingest_token", &json!(1)).is_err());
        assert!(validate_setting("capture_ingest_port", &json!(7333)).is_ok());
        assert!(validate_setting("capture_ingest_port", &json!(80)).is_err());
        assert!(validate_setting("capture_ingest_port", &json!(70000)).is_err());
        assert!(validate_setting("capture_ingest_port", &json!("7333")).is_err());
        // 익스텐션 철수(2026-09-09)로 사라진 키들은 이제 거부돼야 한다.
        assert!(validate_setting("capture_clip_enabled", &json!("1")).is_err());
        assert!(validate_setting("capture_visits_enabled", &json!("1")).is_err());
        assert!(validate_setting("capture_visit_min_seconds", &json!(15)).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        // Q7: 수집 채널 키는 시드하지 않는다.
        assert_eq!(before.get("capture_ingest_token"), None);
        assert_eq!(before.get("capture_ingest_port"), None);

        let mut entries = BTreeMap::new();
        entries.insert("capture_ingest_token".to_string(), json!("tok-1"));
        entries.insert("capture_ingest_port".to_string(), json!(7400));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("capture_ingest_token"), Some(&json!("tok-1")));
        assert_eq!(after.get("capture_ingest_port"), Some(&json!(7400)));
    }

    /// 구 제외 도메인 키 — 익스텐션은 사라졌지만 사용자가 쌓아둔 목록을 폴백으로 읽어야 하므로
    /// 검증 규칙은 남는다(collect_excluded_domains 와 같은 모양).
    #[test]
    fn legacy_visit_excluded_domains_key_still_validates_for_the_migration_fallback() {
        use std::collections::BTreeMap;
        assert!(validate_setting("capture_visit_excluded_domains", &json!([])).is_ok());
        assert!(validate_setting("capture_visit_excluded_domains", &json!(["mail.example.com"])).is_ok());
        assert!(validate_setting("capture_visit_excluded_domains", &json!([" "])).is_err());
        assert!(validate_setting("capture_visit_excluded_domains", &json!("mail.example.com")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        assert_eq!(crate::repo::settings::get_all(&conn).unwrap().get("capture_visit_excluded_domains"), None);

        let mut entries = BTreeMap::new();
        entries.insert("capture_visit_excluded_domains".to_string(), json!(["mail.example.com"]));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        assert_eq!(
            crate::repo::settings::get_all(&conn).unwrap().get("capture_visit_excluded_domains"),
            Some(&json!(["mail.example.com"]))
        );
    }

    #[test]
    fn capture_ledger_key_is_off_by_default_and_survives_a_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("capture_ledger_enabled", &json!("1")).is_ok());
        assert!(validate_setting("capture_ledger_enabled", &json!(true)).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("capture_ledger_enabled"), None, "Q7: 신규 채널은 시드하지 않는다");

        let mut entries = BTreeMap::new();
        entries.insert("capture_ledger_enabled".to_string(), json!("1"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("capture_ledger_enabled"), Some(&json!("1")));
    }

    #[test]
    fn test_validate_setting_pet() {
        assert!(validate_setting("pet_enabled", &json!("0")).is_ok());
        assert!(validate_setting("pet_enabled", &json!("1")).is_ok());
        assert!(validate_setting("pet_enabled", &json!(true)).is_err());
        assert!(validate_setting("pet_enabled", &json!("2")).is_err());
        // 표시/숨기기(W8-g) — 마스터와 같은 "0"/"1" 문자열 규칙.
        assert!(validate_setting("pet_visible", &json!("0")).is_ok());
        assert!(validate_setting("pet_visible", &json!("1")).is_ok());
        assert!(validate_setting("pet_visible", &json!(false)).is_err());
        assert!(validate_setting("pet_visible", &json!("2")).is_err());
        assert!(validate_setting("pet_pos_x", &json!(120)).is_ok());
        assert!(validate_setting("pet_pos_y", &json!(-40)).is_ok());
        assert!(validate_setting("pet_pos_x", &json!("120")).is_err());
        assert!(validate_setting("pet_pos_y", &json!(1.5)).is_err());
        // 페르소나(W6-d2)
        assert!(validate_setting("pet_persona_preset", &json!("secretary")).is_ok());
        assert!(validate_setting("pet_persona_preset", &json!("friend")).is_ok());
        assert!(validate_setting("pet_persona_preset", &json!("custom")).is_ok());
        assert!(validate_setting("pet_persona_preset", &json!("butler")).is_err());
        assert!(validate_setting("pet_persona_prompt", &json!("반말로 짧게 답해줘")).is_ok());
        assert!(validate_setting("pet_persona_prompt", &json!("")).is_ok());
        assert!(validate_setting("pet_persona_prompt", &json!("가".repeat(2001))).is_err());
        assert!(validate_setting("pet_persona_prompt", &json!(42)).is_err());
        // 에셋 등록표(W7-h)
        assert!(validate_setting("pet_assets", &json!({})).is_ok());
        assert!(validate_setting("pet_assets", &json!({"idle": {"file": "idle.gif", "frames": null}})).is_ok());
        assert!(validate_setting("pet_assets", &json!({"happy": {"file": "happy.png", "frames": 6}})).is_ok());
        assert!(validate_setting("pet_assets", &json!({"dancing": {"file": "a.gif"}})).is_err(), "모르는 동작");
        assert!(validate_setting("pet_assets", &json!({"idle": {"file": "a.mp4"}})).is_err(), "허용 안 된 확장자");
        assert!(validate_setting("pet_assets", &json!({"idle": {"file": "../../a.gif"}})).is_err(), "경로 순회");
        assert!(validate_setting("pet_assets", &json!({"idle": {"file": "a.png", "frames": 1}})).is_err());
        assert!(validate_setting("pet_assets", &json!({"idle": {"file": "a.png", "frames": 999}})).is_err());
        assert!(validate_setting("pet_assets", &json!("idle.gif")).is_err());
        // PNG 재생 속도(W8-d)
        assert!(
            validate_setting(
                "pet_assets",
                &json!({"happy": {"file": "happy.png", "frames": 6, "cycle_ms": null}})
            )
            .is_ok(),
            "cycle_ms 미지정은 통과"
        );
        assert!(
            validate_setting(
                "pet_assets",
                &json!({"happy": {"file": "happy.png", "frames": 6, "cycle_ms": 1500}})
            )
            .is_ok()
        );
        assert!(
            validate_setting(
                "pet_assets",
                &json!({"happy": {"file": "happy.png", "frames": 6, "cycle_ms": 50}})
            )
            .is_err(),
            "하한 미만"
        );
        assert!(
            validate_setting(
                "pet_assets",
                &json!({"happy": {"file": "happy.png", "frames": 6, "cycle_ms": 9999}})
            )
            .is_err(),
            "상한 초과"
        );
    }

    // 함정 3 봉인 — allowlist arm이 빠지면 settings_set이 조용히 실패한다(프런트 목으로는 안 잡힘).
    #[test]
    fn test_pet_settings_persist_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        // 저장된 적 없음 — window_geometry/active_tab_id와 같은 패턴으로 default_settings()에
        // 시드하지 않으므로 get_all()에 키 자체가 없어야 한다.
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("pet_enabled"), None);
        assert_eq!(before.get("pet_pos_x"), None);
        assert_eq!(before.get("pet_pos_y"), None);
        // pet_visible(W8-g)은 반대로 default_settings()가 "1"을 시드한다 — 마스터를 처음 켤 때
        // 기본 보임이어야 하므로 fresh DB에도 이미 값이 있어야 한다.
        assert_eq!(before.get("pet_visible"), Some(&json!("1")));

        let mut entries = BTreeMap::new();
        entries.insert("pet_enabled".to_string(), json!("1"));
        entries.insert("pet_visible".to_string(), json!("0"));
        entries.insert("pet_pos_x".to_string(), json!(-120));
        entries.insert("pet_pos_y".to_string(), json!(640));
        entries.insert("pet_persona_preset".to_string(), json!("friend"));
        entries.insert("pet_persona_prompt".to_string(), json!("항상 존댓말"));
        entries.insert(
            "pet_assets".to_string(),
            json!({
                "idle": {"file": "idle.gif", "frames": null, "cycle_ms": null},
                "happy": {"file": "happy.png", "frames": 6, "cycle_ms": 1500},
            }),
        );
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("pet_enabled"), Some(&json!("1")));
        assert_eq!(after.get("pet_visible"), Some(&json!("0")));
        assert_eq!(after.get("pet_pos_x"), Some(&json!(-120)));
        assert_eq!(after.get("pet_pos_y"), Some(&json!(640)));
        assert_eq!(after.get("pet_persona_preset"), Some(&json!("friend")));
        assert_eq!(after.get("pet_persona_prompt"), Some(&json!("항상 존댓말")));
        assert_eq!(
            after.get("pet_assets"),
            Some(&json!({
                "idle": {"file": "idle.gif", "frames": null, "cycle_ms": null},
                "happy": {"file": "happy.png", "frames": 6, "cycle_ms": 1500},
            })),
            "cycle_ms 도 다른 필드처럼 그대로 왕복해야 한다"
        );
    }

    // P2 3단계 링크 후행 제안 킬 스위치 — 함정 3 봉인 (arm 빠지면 조용히 저장 실패).
    #[test]
    fn test_link_suggestions_defaults_false_and_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("link_suggestions", &json!(true)).is_ok());
        assert!(validate_setting("link_suggestions", &json!(false)).is_ok());
        assert!(validate_setting("link_suggestions", &json!("true")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("link_suggestions"), Some(&json!(false)), "옵트인 — 기본 OFF");

        let mut entries = BTreeMap::new();
        entries.insert("link_suggestions".to_string(), json!(true));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("link_suggestions"), Some(&json!(true)));
    }

    // PLAN-2026-09-18-nl-dates.md §W4 — 날짜 넛지 완전자동 등록 킬스위치, link_suggestions 테스트를
    // 그대로 본뜸(함정 3 봉인).
    #[test]
    fn test_date_nudge_auto_defaults_false_and_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("date_nudge_auto", &json!(true)).is_ok());
        assert!(validate_setting("date_nudge_auto", &json!(false)).is_ok());
        assert!(validate_setting("date_nudge_auto", &json!("true")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("date_nudge_auto"), Some(&json!(false)), "옵트인 — 기본 OFF");

        let mut entries = BTreeMap::new();
        entries.insert("date_nudge_auto".to_string(), json!(true));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("date_nudge_auto"), Some(&json!(true)));
    }

    // PLAN-2026-09-19-date-region-ui.md §P3 D12 — 지역 넛지 강도 킬스위치, date_nudge_auto
    // 테스트를 그대로 본뜸(함정 3 봉인) — 단 기본값이 **true**(엄격) 라는 점이 반대다.
    #[test]
    fn test_region_nudge_strict_defaults_true_and_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("region_nudge_strict", &json!(true)).is_ok());
        assert!(validate_setting("region_nudge_strict", &json!(false)).is_ok());
        assert!(validate_setting("region_nudge_strict", &json!("true")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("region_nudge_strict"), Some(&json!(true)), "기본 ON — 엄격 매칭");

        let mut entries = BTreeMap::new();
        entries.insert("region_nudge_strict".to_string(), json!(false));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("region_nudge_strict"), Some(&json!(false)));
    }

    // 오너 결정(2026-09-20) — 3단 UI 의 "enabled" 불리언 쌍(date_nudge_enabled/region_nudge_enabled)
    // + 붙여넣기 자동 동작 3종 + 마크다운 자동 서식. region_nudge_strict 테스트를 그대로 본뜸
    // (함정 3 봉인) — 여섯 키 전부 기본 true(오늘까지의 동작 유지)라는 점만 같다.
    #[test]
    fn test_date_nudge_enabled_defaults_true_and_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("date_nudge_enabled", &json!(true)).is_ok());
        assert!(validate_setting("date_nudge_enabled", &json!(false)).is_ok());
        assert!(validate_setting("date_nudge_enabled", &json!("true")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("date_nudge_enabled"), Some(&json!(true)), "기본 ON — 오늘까지의 동작 유지");

        let mut entries = BTreeMap::new();
        entries.insert("date_nudge_enabled".to_string(), json!(false));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("date_nudge_enabled"), Some(&json!(false)));
    }

    #[test]
    fn test_region_nudge_enabled_defaults_true_and_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("region_nudge_enabled", &json!(true)).is_ok());
        assert!(validate_setting("region_nudge_enabled", &json!(false)).is_ok());
        assert!(validate_setting("region_nudge_enabled", &json!("true")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("region_nudge_enabled"), Some(&json!(true)), "기본 ON — 오늘까지의 동작 유지");

        let mut entries = BTreeMap::new();
        entries.insert("region_nudge_enabled".to_string(), json!(false));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("region_nudge_enabled"), Some(&json!(false)));
    }

    #[test]
    fn test_paste_link_nudge_defaults_true_and_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("paste_link_nudge", &json!(true)).is_ok());
        assert!(validate_setting("paste_link_nudge", &json!(false)).is_ok());
        assert!(validate_setting("paste_link_nudge", &json!("true")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("paste_link_nudge"), Some(&json!(true)), "기본 ON — 오늘까지의 동작 유지");

        let mut entries = BTreeMap::new();
        entries.insert("paste_link_nudge".to_string(), json!(false));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("paste_link_nudge"), Some(&json!(false)));
    }

    #[test]
    fn test_paste_path_inline_code_defaults_true_and_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("paste_path_inline_code", &json!(true)).is_ok());
        assert!(validate_setting("paste_path_inline_code", &json!(false)).is_ok());
        assert!(validate_setting("paste_path_inline_code", &json!("true")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("paste_path_inline_code"), Some(&json!(true)), "기본 ON — 오늘까지의 동작 유지");

        let mut entries = BTreeMap::new();
        entries.insert("paste_path_inline_code".to_string(), json!(false));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("paste_path_inline_code"), Some(&json!(false)));
    }

    #[test]
    fn test_paste_table_sheet_suggest_defaults_true_and_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("paste_table_sheet_suggest", &json!(true)).is_ok());
        assert!(validate_setting("paste_table_sheet_suggest", &json!(false)).is_ok());
        assert!(validate_setting("paste_table_sheet_suggest", &json!("true")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("paste_table_sheet_suggest"), Some(&json!(true)), "기본 ON — 오늘까지의 동작 유지");

        let mut entries = BTreeMap::new();
        entries.insert("paste_table_sheet_suggest".to_string(), json!(false));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("paste_table_sheet_suggest"), Some(&json!(false)));
    }

    #[test]
    fn test_editor_md_autoformat_defaults_true_and_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("editor_md_autoformat", &json!(true)).is_ok());
        assert!(validate_setting("editor_md_autoformat", &json!(false)).is_ok());
        assert!(validate_setting("editor_md_autoformat", &json!("true")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("editor_md_autoformat"), Some(&json!(true)), "기본 ON — 오늘까지의 동작 유지");

        let mut entries = BTreeMap::new();
        entries.insert("editor_md_autoformat".to_string(), json!(false));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("editor_md_autoformat"), Some(&json!(false)));
    }

    /// S2 입력 3종 — 저장이 조용히 실패하지 않는지 Rust 왕복으로 확인(함정 3), 기본값·거부값 고정.
    /// 전역 키라 노트북 키가 아니어야 한다(서버 훅이 노트북 전환과 무관하게 읽는다).
    #[test]
    fn test_s2_input_modes_default_validate_and_round_trip() {
        use std::collections::BTreeMap;
        let keys = [
            ("photo_meta_mode", "auto"),
            ("voice_transcribe_mode", "auto"),
            ("voice_cleanup_mode", "off"),
        ];
        for (k, _) in keys {
            for ok in ["off", "ask", "auto"] {
                assert!(validate_setting(k, &json!(ok)).is_ok(), "{k}={ok}");
            }
            for bad in [json!("on"), json!("AUTO"), json!(true), json!(1), json!(null)] {
                assert!(validate_setting(k, &bad).is_err(), "{k}={bad}");
            }
            assert!(!is_notebook_setting_key(k), "{k} 는 PC 공유 전역 키");
        }

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        for (k, d) in keys {
            assert_eq!(before.get(k), Some(&json!(d)), "{k} 기본값");
        }
        let mut entries = BTreeMap::new();
        for (k, _) in keys {
            entries.insert(k.to_string(), json!("ask"));
        }
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        let after = crate::repo::settings::get_all(&conn).unwrap();
        for (k, _) in keys {
            assert_eq!(after.get(k), Some(&json!("ask")), "{k} 왕복");
        }
        // 잘못된 값은 저장이 거부된다(조용히 삼키지 않는다).
        let mut bad = BTreeMap::new();
        bad.insert("photo_meta_mode".to_string(), json!("maybe"));
        assert!(crate::repo::settings::set(&mut conn, &bad).is_err());
    }

    /// 오너 결정(2026-09-20) — 새 6키 모두 노트북별(NOTEBOOK_KEYS)이어야 한다. NOTEBOOK_KEYS 에
    /// 없으면 값이 전역 `settings` 행으로 저장돼 모든 노트북에 새어 들어간다(격리가 깨진다) —
    /// `repo::settings::notebook_rows` 로 실제 `workspace_settings` 테이블에 떨어지는지까지
    /// 확인한다(settings.rs::notebook_keys_in_the_same_call_as_a_switch_land_in_the_new_notebook
    /// 을 본뜸).
    #[test]
    fn new_editor_settings_keys_are_notebook_keys_and_land_in_workspace_settings() {
        use std::collections::BTreeMap;
        const NEW_KEYS: [&str; 6] = [
            "date_nudge_enabled",
            "region_nudge_enabled",
            "paste_link_nudge",
            "paste_path_inline_code",
            "paste_table_sheet_suggest",
            "editor_md_autoformat",
        ];
        for key in NEW_KEYS {
            assert!(is_notebook_setting_key(key), "{key} must follow the notebook");
        }

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let ws = crate::repo::folders::active_workspace_id(&conn).unwrap();

        let mut entries = BTreeMap::new();
        for key in NEW_KEYS {
            entries.insert(key.to_string(), json!(false));
        }
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let rows = crate::repo::settings::notebook_rows(&conn, &ws).unwrap();
        for key in NEW_KEYS {
            assert!(
                rows.iter().any(|(k, v)| k == key && v == "false"),
                "{key} must land in workspace_settings (not global settings)"
            );
        }
    }

    // 오너 결정(2026-09-20, "4~7번도 넣어봐") — **실험적** 4종. 위 여섯 키 테스트와 같은 형태
    // (round trip: 유효값 저장·재조회 + 무효값 거부) — 이 넷은 "오늘까지의 동작 유지"가 아니라
    // 새 동작/값이라 기본값이 제각각이다(불리언 둘은 false, 나머지는 "오늘과 같은 뜻"의 문자열).
    #[test]
    fn test_link_open_on_click_defaults_false_and_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("link_open_on_click", &json!(true)).is_ok());
        assert!(validate_setting("link_open_on_click", &json!(false)).is_ok());
        assert!(validate_setting("link_open_on_click", &json!("true")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("link_open_on_click"), Some(&json!(false)), "기본 OFF — 오늘까지의 동작(Ctrl/Cmd+클릭만) 유지");

        let mut entries = BTreeMap::new();
        entries.insert("link_open_on_click".to_string(), json!(true));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("link_open_on_click"), Some(&json!(true)));
    }

    #[test]
    fn test_editor_word_count_defaults_true_and_persists_through_repo_settings_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("editor_word_count", &json!(true)).is_ok());
        assert!(validate_setting("editor_word_count", &json!(false)).is_ok());
        assert!(validate_setting("editor_word_count", &json!(1)).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("editor_word_count"), Some(&json!(true)));

        let mut entries = BTreeMap::new();
        entries.insert("editor_word_count".to_string(), json!(false));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("editor_word_count"), Some(&json!(false)));
    }

    #[test]
    fn test_editor_width_validate_and_roundtrip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("editor_width", &json!("narrow")).is_ok());
        assert!(validate_setting("editor_width", &json!("normal")).is_ok());
        assert!(validate_setting("editor_width", &json!("wide")).is_ok());
        assert!(validate_setting("editor_width", &json!("huge")).is_err());
        assert!(validate_setting("editor_width", &json!(1)).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("editor_width"), Some(&json!("normal")), "기본 normal — 오늘까지의 800px 상한과 같은 뜻");

        let mut entries = BTreeMap::new();
        entries.insert("editor_width".to_string(), json!("wide"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("editor_width"), Some(&json!("wide")));
    }

    #[test]
    fn test_new_note_date_precision_validate_and_roundtrip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("new_note_date_precision", &json!("day")).is_ok());
        assert!(validate_setting("new_note_date_precision", &json!("month")).is_ok());
        assert!(validate_setting("new_note_date_precision", &json!("year")).is_ok());
        assert!(validate_setting("new_note_date_precision", &json!("week")).is_err());
        assert!(validate_setting("new_note_date_precision", &json!(null)).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("new_note_date_precision"), Some(&json!("day")), "기본 day — 오늘까지의 동작과 같은 뜻");

        let mut entries = BTreeMap::new();
        entries.insert("new_note_date_precision".to_string(), json!("year"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("new_note_date_precision"), Some(&json!("year")));
    }

    #[test]
    fn test_new_note_section_name_validate_and_roundtrip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("new_note_section_name", &json!("")).is_ok(), "빈 문자열 = 내장 기본 이름");
        assert!(validate_setting("new_note_section_name", &json!("할 일")).is_ok());
        assert!(validate_setting("new_note_section_name", &json!("a".repeat(40))).is_ok());
        // 41자(문자 수, 바이트 아님 — 멀티바이트로도 확인) 거부.
        assert!(validate_setting("new_note_section_name", &json!("a".repeat(41))).is_err());
        assert!(validate_setting("new_note_section_name", &json!("가".repeat(41))).is_err());
        // 줄바꿈 금지(섹션 탭에 한 줄로 그려진다).
        assert!(validate_setting("new_note_section_name", &json!("a\nb")).is_err());
        assert!(validate_setting("new_note_section_name", &json!("a\rb")).is_err());
        assert!(validate_setting("new_note_section_name", &json!(123)).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let before = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(before.get("new_note_section_name"), Some(&json!("")));

        let mut entries = BTreeMap::new();
        entries.insert("new_note_section_name".to_string(), json!("할 일"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("new_note_section_name"), Some(&json!("할 일")));
    }

    /// 새 experimental 4종도 위 6키 테스트(new_editor_settings_keys_are_notebook_keys_and_land_in_workspace_settings)
    /// 와 같은 이유로 NOTEBOOK_KEYS + 실제 workspace_settings 왕복까지 본다.
    #[test]
    fn new_experimental_editor_settings_keys_are_notebook_keys_and_land_in_workspace_settings() {
        use std::collections::BTreeMap;
        let new_keys: [(&str, serde_json::Value); 5] = [
            ("link_open_on_click", json!(true)),
            ("editor_word_count", json!(true)),
            ("editor_width", json!("wide")),
            ("new_note_date_precision", json!("year")),
            ("new_note_section_name", json!("Log")),
        ];
        for (key, _) in &new_keys {
            assert!(is_notebook_setting_key(key), "{key} must follow the notebook");
        }

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let ws = crate::repo::folders::active_workspace_id(&conn).unwrap();

        let mut entries = BTreeMap::new();
        for (key, value) in &new_keys {
            entries.insert(key.to_string(), value.clone());
        }
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let rows = crate::repo::settings::notebook_rows(&conn, &ws).unwrap();
        for (key, value) in &new_keys {
            let expected = value.to_string();
            assert!(
                rows.iter().any(|(k, v)| k == key && v == &expected),
                "{key} must land in workspace_settings (not global settings)"
            );
        }
    }

    #[test]
    fn test_link_suggestions_model_accepts_string_and_empty() {
        // 빈 문자열은 NULL 동등(소비처 trim 후 폴백) — 거부하지 않는다. 다른 형식(숫자·배열·객체·
        // null)은 VALIDATION. ai_provider 처럼 enum 검증은 하지 않는다 — 프로바이더 자체는
        // link_suggestions_active 게이트가 검증한다.
        assert!(validate_setting("link_suggestions_model", &json!("gemini-1.5-flash")).is_ok());
        assert!(validate_setting("link_suggestions_model", &json!("")).is_ok());
        assert!(validate_setting("link_suggestions_model", &json!(null)).is_err());
        assert!(validate_setting("link_suggestions_model", &json!(42)).is_err());
        assert!(validate_setting("link_suggestions_model", &json!(["llama3.2"])).is_err());
    }

    #[test]
    fn test_collect_excluded_domains_matches_capture_visit_shape() {
        // 같은 형식·캡(200개·253자·trim-비어있지-않음) — visits·clip·link_paste 공유.
        assert!(validate_setting("collect_excluded_domains", &json!([])).is_ok());
        assert!(validate_setting("collect_excluded_domains", &json!(["mail.example.com"])).is_ok());
        assert!(validate_setting("collect_excluded_domains", &json!([" "])).is_err());
        assert!(validate_setting(
            "collect_excluded_domains",
            &json!("mail.example.com")
        )
        .is_err());
        let too_long = "a".repeat(254);
        assert!(validate_setting("collect_excluded_domains", &json!([too_long])).is_err());
        let too_many = vec!["x".to_string(); 201];
        assert!(validate_setting("collect_excluded_domains", &json!(too_many)).is_err());
    }

    // D11(2026-09-12): 날씨 표시 토글 제거 — `header_weather_visible` 의 검증/왕복 테스트는
    // 키와 함께 사라졌다. 키가 다시 필요해지는 일은 없다(날씨는 항상 표시).
    #[test]
    fn test_dashboard_tabs_validation_and_round_trip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("dashboard_tabs", &json!([])).is_ok());
        assert!(validate_setting(
            "dashboard_tabs",
            &json!([
                {"id": "board", "enabled": true},
                {"id": "calendar", "enabled": true},
                {"id": "timeline", "enabled": true},
                {"id": "map", "enabled": true},
                {"id": "graph", "enabled": true},
            ])
        )
        .is_ok());

        // invalid id
        assert!(validate_setting(
            "dashboard_tabs",
            &json!([{"id": "unknown_tab", "enabled": true}])
        )
        .is_err());
        // missing enabled
        assert!(validate_setting("dashboard_tabs", &json!([{"id": "board"}])).is_err());
        // not an array
        assert!(validate_setting("dashboard_tabs", &json!("board")).is_err());

        // Round trip test
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();

        let tabs = json!([
            {"id": "timeline", "enabled": true},
            {"id": "board", "enabled": true},
            {"id": "calendar", "enabled": true},
            {"id": "map", "enabled": true},
            {"id": "graph", "enabled": true},
        ]);
        let mut entries = BTreeMap::new();
        entries.insert("dashboard_tabs".to_string(), tabs.clone());
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("dashboard_tabs"), Some(&tabs));
    }

    #[test]
    fn test_user_name_validate_and_roundtrip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("user_name", &json!("홍길동")).is_ok());
        assert!(validate_setting("user_name", &json!("")).is_ok());
        assert!(validate_setting("user_name", &json!("a".repeat(64))).is_ok());
        assert!(validate_setting("user_name", &json!("a".repeat(65))).is_err());
        assert!(validate_setting("user_name", &json!(123)).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let initial = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(initial.get("user_name"), Some(&json!("")));

        let mut entries = BTreeMap::new();
        entries.insert("user_name".to_string(), json!("Alice"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("user_name"), Some(&json!("Alice")));
    }

    /// PLAN-2026-09-12 §5/D6 — 본문 틴트 슬라이더 키. CLAUDE.md 함정 3: arm 이 없으면 저장이
    /// **조용히** 실패하고 프런트 목으로는 안 잡힌다. 그래서 범위 검증 + 실제 DB 왕복까지 본다.
    /// 시드가 0 인 것도 함께 고정한다 — 0 = "지금 화면 그대로"라서, 이 값이 흔들리면 기존
    /// 사용자의 본문 밝기가 업데이트만으로 저절로 바뀐다.
    #[test]
    fn test_content_tint_validate_and_roundtrip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("content_tint", &json!(0)).is_ok());
        assert!(validate_setting("content_tint", &json!(40)).is_ok());
        assert!(validate_setting("content_tint", &json!(41)).is_err());
        // 음수는 "본문을 사이드바보다 밝게"(틴트가 흰색으로 뒤집힘) — 2026-09-12 오너 QA.
        assert!(validate_setting("content_tint", &json!(-30)).is_ok());
        assert!(validate_setting("content_tint", &json!(-31)).is_err());
        assert!(validate_setting("content_tint", &json!("12")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let initial = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(initial.get("content_tint"), Some(&json!(0)));

        let mut entries = BTreeMap::new();
        entries.insert("content_tint".to_string(), json!(24));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("content_tint"), Some(&json!(24)));
    }

    /// PLAN-2026-09-12 §3/E3 — 배경 채도 슬라이더 키. content_tint 와 같은 이유로 왕복까지
    /// 본다(CLAUDE.md 함정 3: arm 이 없으면 저장이 **조용히** 실패한다). 시드 0 을 함께 못
    /// 박는 것도 같은 이유다 — 0 이 "지금 화면 그대로"라서, 이 값이 흔들리면 업데이트만으로
    /// 모든 사용자의 배경이 물든다.
    #[test]
    fn test_bg_sat_validate_and_roundtrip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("bg_sat", &json!(0)).is_ok());
        assert!(validate_setting("bg_sat", &json!(100)).is_ok());
        assert!(validate_setting("bg_sat", &json!(101)).is_err());
        // 음수는 의미가 없다 — 채도는 방향이 없는 세기고, 부호를 쓰는 content_tint 와 다르다.
        assert!(validate_setting("bg_sat", &json!(-1)).is_err());
        // 프런트가 Math.round 로 정수만 보낸다(as_i64 는 소수를 통째로 거부한다).
        assert!(validate_setting("bg_sat", &json!(12.5)).is_err());
        assert!(validate_setting("bg_sat", &json!("30")).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let initial = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(initial.get("bg_sat"), Some(&json!(0)));

        let mut entries = BTreeMap::new();
        entries.insert("bg_sat".to_string(), json!(35));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("bg_sat"), Some(&json!(35)));
    }

    #[test]
    fn test_font_family_validate_and_roundtrip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("font_family", &json!("serif")).is_ok());
        assert!(validate_setting("font_family", &json!("sans")).is_ok());
        assert!(validate_setting("font_family", &json!("Pretendard")).is_ok());
        assert!(validate_setting("font_family", &json!("")).is_err());
        assert!(validate_setting("font_family", &json!("a".repeat(128))).is_ok());
        assert!(validate_setting("font_family", &json!("a".repeat(129))).is_err());
        assert!(validate_setting("font_family", &json!(123)).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let initial = crate::repo::settings::get_all(&conn).unwrap();
        // 2026-09-09: 신규 설치 기본값 serif → 번들 pretendard. 기존 설치는 migrations::V78_SQL 이
        // 옮긴다(그쪽 테스트가 "직접 고른 값은 안 건드린다"까지 함께 봉인).
        assert_eq!(initial.get("font_family"), Some(&json!("pretendard")));

        let mut entries = BTreeMap::new();
        entries.insert("font_family".to_string(), json!("sans"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("font_family"), Some(&json!("sans")));
    }

    #[test]
    fn test_font_editor_and_mono_validate_and_roundtrip() {
        use std::collections::BTreeMap;
        assert!(validate_setting("font_editor", &json!("")).is_ok());
        assert!(validate_setting("font_editor", &json!("catalog:gaegu")).is_ok());
        assert!(validate_setting("font_editor", &json!("a".repeat(129))).is_err());
        assert!(validate_setting("font_mono", &json!("")).is_err());
        assert!(validate_setting("font_mono", &json!("paper-mono")).is_ok());
        assert!(validate_setting("font_mono", &json!(1)).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let initial = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(initial.get("font_editor"), Some(&json!("")));
        assert_eq!(initial.get("font_mono"), Some(&json!("source-code-pro")));

        let mut entries = BTreeMap::new();
        entries.insert("font_editor".to_string(), json!("catalog:gaegu"));
        entries.insert("font_mono".to_string(), json!("paper-mono"));
        crate::repo::settings::set(&mut conn, &entries).unwrap();
        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("font_editor"), Some(&json!("catalog:gaegu")));
        assert_eq!(after.get("font_mono"), Some(&json!("paper-mono")));
    }

    #[test]
    fn test_pet_actions_and_chat_memory_validate_and_roundtrip() {
        assert!(validate_setting("pet_dblclick_action", &json!("chat")).is_ok());
        assert!(validate_setting("pet_dblclick_action", &json!("new_note")).is_ok());
        assert!(validate_setting("pet_dblclick_action", &json!("off")).is_ok());
        assert!(validate_setting("pet_dblclick_action", &json!("invalid")).is_err());

        assert!(validate_setting("chat_memory", &json!([])).is_ok());
        assert!(validate_setting("chat_memory", &json!([
            {"id": "m1", "text": "Likes coffee", "created_at": "2026-08-21T00:00:00Z"}
        ])).is_ok());
        assert!(validate_setting("chat_memory", &json!([
            {"id": "", "text": "Likes coffee", "created_at": "2026-08-21T00:00:00Z"}
        ])).is_err());
        assert!(validate_setting("chat_memory", &json!([
            {"id": "m1", "text": "a".repeat(201), "created_at": "2026-08-21T00:00:00Z"}
        ])).is_err());

        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let initial = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(initial.get("pet_dblclick_action"), Some(&json!("new_note")));
        assert_eq!(initial.get("chat_memory"), Some(&json!([])));

        let mut entries = BTreeMap::new();
        entries.insert("pet_dblclick_action".to_string(), json!("new_note"));
        entries.insert("chat_memory".to_string(), json!([{"id": "m1", "text": "Remember me", "created_at": "2026-08-21T00:00:00Z"}]));
        crate::repo::settings::set(&mut conn, &entries).unwrap();

        let after = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(after.get("pet_dblclick_action"), Some(&json!("new_note")));
        assert_eq!(after.get("chat_memory"), Some(&json!([{"id": "m1", "text": "Remember me", "created_at": "2026-08-21T00:00:00Z"}])));
    }
}
