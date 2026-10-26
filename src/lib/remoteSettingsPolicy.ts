/**
 * 원격(HTTP `/api/v1/invoke`) 클라이언트가 무엇을 설정으로 노출할 수 있는가 — **단일 관문**.
 *
 * 왜 있나: 원격 설정 표면이 둘이다 — 폰의 요약 화면(`src/mobile/MobileSettings.tsx`)과
 * 태블릿의 데스크톱 설정 창(`src/components/SettingsPanel.tsx`, 브라우저 모드). 둘이 각자
 * "무엇을 보여도 되는가"를 판단하면 즉시 어긋난다. 실제로 어긋났다: 2026-08/09 설정 대개편
 * 4커밋(6ee36f0e·c3d2d8fb·f966dda0·b8270b61) 동안 폰 화면이 따라가지 못해, 서버가 400 으로
 * 거부하는 `ai_enabled` 토글이 살아남았다(누르면 켜졌다가 롤백되고 에러 토스트가 뜬다 —
 * `stores/settings.ts::setSimplePref` 가 낙관적 갱신 후 실패 시 되돌리기 때문).
 *
 * 서버 쪽 SSOT 는 Rust 다: `src-tauri/src/sync_server/handlers/remote_policy.rs::is_remote_blocked_settings_key`.
 * 이 파일은 그 거부를 **UI 가 미리 반영하기 위한 미러**일 뿐 권한의 근거가 아니다 — 여기서
 * 빠뜨려도 서버는 여전히 막는다(반대로 여기에 넣었다고 서버가 허용하지도 않는다).
 * 두 목록이 갈라지는 것은 `remoteSettingsPolicy.test.ts` 가 remote_policy.rs 를 직접 읽어 잡는다
 * (선례: `src/lib/appearanceSeedDrift.test.ts` 가 index.html 을 같은 방식으로 대조한다).
 */

/** `sync_*` 외에 개별로 막히는 키들 — remote_policy.rs 의 `matches!` 팔과 같은 집합. */
const BLOCKED_EXACT: ReadonlySet<string> = new Set([
  // 서버 lifecycle: 원격 클라이언트가 자기가 붙은 서버를 끄거나 토큰을 재발급할 수 없어야 한다.
  // (`sync_*` 접두는 아래 startsWith 가 담당한다 — sync_enabled/sync_port/sync_token)
  //
  // AI 프로바이더: 유출된 sync_token 하나로 오너의 **로컬** AI 액션 엔드포인트를 공격자 것으로
  // 돌릴 수 있는 영구 exfil 채널이 열린다. 그래서 비밀이 아닌 ai_endpoint/ai_enabled 까지 막는다.
  "ai_provider",
  "ai_endpoint",
  "ai_api_key",
  // 비활성 프로바이더 키 보관함(lib/aiProviderSwitch.ts) — 전환 한 번이면 ai_api_key/ai_endpoint 로 올라온다.
  "ai_provider_creds",
  "ai_enabled",
  // 이 기기 loopback ingest 리스너의 lifecycle — 제어 커맨드가 전부 http:false 인 것과 한 쌍.
  // (capture_screenshot_enabled 는 여기 없다 — 순수 UI 게이트라 서버 lifecycle 이 아니다.)
  "capture_clip_enabled",
  "capture_ingest_port",
  "capture_ingest_token",
  // 이 기기 파일시스템 쓰기 위치(화면 저장 폴더) — 원격이 임의 경로로 돌리면 안 된다.
  "capture_screenshot_dir",
  // 이 기기에서 실행되는 프로그램 경로(LibreOffice) — 슬라이드 미리보기가 그대로 spawn 한다.
  "soffice_path",
]);

/**
 * 이 키를 `settings_set` 으로 보내면 서버가 400 을 준다(docs/CLIENT-RULES.md §2-5).
 * 원격 표면은 이런 키를 쓰는 컨트롤을 **아예 렌더하지 않는다** — 비활성으로 남겨두면
 * "왜 안 되는지" 알 수 없는 죽은 스위치가 된다.
 */
export function isRemoteBlockedSettingKey(key: string): boolean {
  return key.startsWith("sync_") || BLOCKED_EXACT.has(key);
}

/**
 * 브라우저(태블릿)에서 데스크톱 `SettingsPanel` 이 레일에 띄워도 되는 페이지 id.
 * 나머지는 렌더조차 하지 않는다 — 페이지 자체가 원격에서 성립하지 않기 때문이다:
 *
 *   ai         프로바이더/키가 원격 차단 + `settings_get_all` 응답에서 스트립됨
 *   ai_features 마스터 `ai_enabled` 이 차단이라 카탈로그가 반쪽이 된다
 *   ai_permissions PLAN-2026-09-12 §1(D8) 로 기능 페이지에서 떨어져 나온 신설 페이지 —
 *              ai_features 와 같은 이유로 제외한다. 권한 6종은 전부 `ai_*` 설정 키이고,
 *              그 마스터인 `ai_enabled` 이 원격 차단이라 "켤 수 없는 권한 목록"이 된다.
 *              페이지를 떼어냈다고 원격 성립 여부가 달라지지는 않는다.
 *   ai_chat    채팅 코어 pet_* 는 2026-10-06 부터 http:true 지만 이 페이지는 프로바이더·권한·기억 설정이라 원격 제외 유지
 *   connect    `sync_*`·`capture_ingest_*` 서버 lifecycle 차단
 *   collect    `collect_*` 커맨드가 전부 http:false (서버 로컬 네트워크/FS)
 *   data       로컬 FS 경로 인자 · 파괴적 관리 동작
 *   pet       데스크톱 로컬 창 — 원격에 대응물이 없다
 *
 * 페이지를 남긴다고 그 안의 모든 행이 동작하는 것은 아니다 — OS 의존 행(자동 실행, 트레이,
 * 네이티브 아크릴 재질)은 각 섹션이 `isBrowser()` 로 따로 가린다(선례:
 * `components/settings/GeneralSection.tsx` 의 autostart).
 */
export const BROWSER_SETTINGS_PAGES: readonly string[] = [
  "general",
  // 에디터(2026-09-20 신설): date_nudge_auto·region_nudge_strict·source_original_policy·
  // editor_full_width·spellcheck_enabled 다섯 키 모두 위 BLOCKED_EXACT/sync_* 어느 쪽에도
  // 안 걸린다 — 전부 원격 허용. 옮기기 전엔 이 다섯 행이 "general" 페이지에서 이미 브라우저
  // 모드에 보였다(GeneralSection 이 `isBrowser()` 로 가리지 않던 행들이었다) — 페이지만
  // 갈랐다고 원격에서 사라지면 회귀이므로 여기도 같이 넣는다. 에디터 자체가 브라우저(태블릿)
  // 에서도 동작하는 화면이라 성립 여부가 바뀌지 않는다.
  "editor",
  // 알림 및 일정(2026-09-15 R5): 알림·달력 키는 전부 원격 허용(PHONE_SETTINGS_KEYS 와 겹친다).
  // 시간축 루틴 표만 http:false 라 NotificationsSection 이 `isBrowser()` 로 따로 가린다.
  "notifications",
  "appearance",
  "view",
  "dashboard",
  "license",
];

/**
 * 폰 요약 화면(`MobileSettings`)이 `settings_set` 으로 쓰는 **DB 설정 키** 전부.
 * 여기 없는 것은 "나머지 설정은 데스크톱에서" 안내로 넘긴다 — 폰은 데스크톱 설정의 축소판이
 * 아니라 요약이다(WORKORDER-2026-09-02-mobile-rework.md D9).
 *
 * 대상이 **아닌** 것: 기기 로컬 값(테마·글자 크기 — `mobile/mobilePrefs.ts` 의 localStorage),
 * AI 액션 프리셋(`stores/aiPresets.ts` 경유), 연결 정보(`/api/v1/ping`, 읽기 전용).
 * 전부 `settings_set` 을 타지 않는다.
 */
export const PHONE_SETTINGS_KEYS: readonly string[] = [
  "ui_lang",
  "filter_roster",
  "notifications_enabled",
  "reminder_all_day_at",
  // S2 입력(PLAN-2026-10-06-s2-input.md §1.3): PC 공유 3단 자동 정책 — 서버 훅이 읽는 전역 키.
  "photo_meta_mode",
  "voice_transcribe_mode",
  "voice_cleanup_mode",
];
