/**
 * 음성 녹음의 위치 읽기 정책 — "녹음 중인 화면 위에 위치 권한 시스템 대화상자를 띄우지 않는다."
 *
 * 문제(2026-10-07 실기 QA): 녹음 시작 직후 `getCurrentPosition()` 이 셸 브리지로 나가고, 셸은 권한이 없으면
 * 안드로이드 권한 대화상자를 띄운다. 녹음은 이미 시작된 뒤라 대화상자가 녹음기 위에 얹힌다. 페이지는 네이티브
 * 권한 상태를 알 수 없다(브리지가 `getLocation` 만 받고, 그 안이 항상 `perms.ensure` 라 "조회만" 이 불가능).
 * 그래서 "이미 허용된 적이 있다" 를 직접 기억한다(아래 granted).
 *
 * 규칙 — 위치 모드(기기별, brise_mobile_loc_mode)를 따른다:
 *
 *   모드      허용 기억        시작(녹음 중)        정지 뒤(저장 직전)
 *   off       -               읽지 않음            읽지 않음
 *   ask       없음(기본)       읽지 않음            읽지 않음   ← 사용자가 켠 적 없다: 이 경로에서 대화상자를 만들지 않는다
 *   ask       있음            읽음                 (불리지 않음)
 *   auto      없음            "later" (미룸)       읽음  ← 켜 둔 사용자: 첫 대화상자는 녹음이 끝난 뒤에 뜬다
 *   auto      있음            읽음                 (불리지 않음)
 *   (거부됨: isLocationDenied() 이거나 이번 세션에 no_permission 을 받았다) → 모든 모드에서 읽지 않음
 *   "정지 뒤" 는 시작이 "later" 를 답했을 때만 녹음기가 부른다(useVoiceRecorder) — 시작 읽기가 실패(타임아웃 등)한
 *   녹음을 정지 때 다시 읽느라 저장을 늦추지 않는다.
 *
 * 허용 기억은 위치를 한 번이라도 읽는 데 성공하면 켜지고(이 모듈의 getVoicePosition·applyCurrentLocation),
 * no_permission 이면 꺼진다. 앱 재시작 뒤에도 남도록 localStorage 에 미러한다(프로세스가 자주 죽는 셸에서
 * 매번 처음부터 "모름" 이면 ask 모드 사용자가 녹음 좌표를 들쭉날쭉 잃는다). 시스템 설정에서 권한을 뺏었는데
 * 기억이 남아 있으면 최악이 "예전 동작(녹음기 위 대화상자) 한 번" 이고, 그 한 번에 거부되면 기억이 지워진다.
 *
 * ponytail: 한계 — 허용 기억을 켜는 곳은 이 모듈을 부르는 두 곳뿐이다(음성 위치·"현재 위치 대표 지역" 적용).
 * MobileRegionSheet 의 수동 "현재 위치" 탭 등은 `useCurrentLocationApply` 만 지나므로 기억을 못 켠다.
 * 업그레이드 경로: 단일 관문 `lib/currentPosition.ts` 가 성공/no_permission 을 직접 기록하거나, 셸 브리지에
 * 권한 상태 질의 메시지를 추가한다(그러면 이 기억이 필요 없다).
 */
import type { MobileLocMode } from "./mobilePrefs";
import type { VoicePositionPhase } from "./voiceHandOff";

const GRANTED_KEY = "brise_mobile_loc_granted";

type Perm = "unknown" | "granted" | "denied";
let perm: Perm | null = null; // null = 아직 저장소를 읽지 않았다

function current(): Perm {
  if (perm === null) {
    try {
      perm = localStorage.getItem(GRANTED_KEY) === "1" ? "granted" : "unknown";
    } catch {
      perm = "unknown"; // silent-ok: 저장소 접근 불가면 가장 보수적인 값("모름") — 대화상자를 만들지 않는 쪽
    }
  }
  return perm;
}

function persist(granted: boolean): void {
  try {
    if (granted) localStorage.setItem(GRANTED_KEY, "1");
    else localStorage.removeItem(GRANTED_KEY);
  } catch {
    // silent-ok: 사생활 모드 등 — 이번 세션 메모리 값만 쓴다(다음 로드엔 "모름")
  }
}

/** 위치 읽기에 성공했다 → 권한은 허용돼 있다. */
export function noteLocationGranted(): void {
  perm = "granted";
  persist(true);
}

/** no_permission 을 받았다 → 이번 세션엔 음성 경로가 더 묻지 않는다(매 녹음마다 대화상자가 뜨는 것을 막는다). */
export function noteLocationDenied(): void {
  perm = "denied";
  persist(false);
}

/** 테스트용: 메모리·저장소 모두 "모름" 으로. */
export function resetLocationPermissionMemory(): void {
  perm = "unknown";
  persist(false);
}

export type VoicePositionPlan = "read" | "later" | "skip";

/**
 * 이 시점에 위치를 읽어도 되는가.
 * @param appDenied `isLocationDenied()` — 다른 경로(현재 위치 적용)가 이미 거부를 겪었다.
 */
export function planVoicePosition(mode: MobileLocMode, phase: VoicePositionPhase, appDenied: boolean): VoicePositionPlan {
  if (mode === "off" || appDenied) return "skip";
  const p = current();
  if (p === "denied") return "skip";
  if (p === "granted") return "read";
  // 허용 여부를 모른다 — 읽으면 대화상자가 뜰 수 있다.
  if (mode !== "auto") return "skip"; // ask: 사용자가 이 경로를 켠 적이 없다
  return phase === "start" ? "later" : "read"; // auto: 녹음 중엔 미루고, 멈춘 뒤에 묻는다
}
