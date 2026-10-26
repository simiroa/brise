/**
 * 설정 창(#/settings)과 본 창은 **서로 다른 웹뷰**라 zustand 스토어도 각각이다 — 설정 창에서 테마나
 * 강조색을 바꿔도 본 창은 자기 스토어를 그대로 들고 있어서 화면이 안 변한다. 백엔드의 단일
 * 초크포인트(commands/settings.rs::settings_set)가 쓰기마다 "settings-changed" 를 `{ keys }` 와 함께
 * 내고, 각 창이 여기서 받아 자기 스토어를 DB 기준으로 다시 읽는다.
 *
 * 거르기: 백엔드는 어떤 키가 어느 창에 필요한지 모르니 전부 알리고, 이쪽이 키를 본다.
 * `WINDOW_LOCAL_KEYS` 는 본 창만 쓰고 본 창만 읽는 UI 상태라(쓴 창은 이미 그 값을 들고 있다)
 * 그 키들만 바뀐 쓰기는 재조회하지 않는다 — 노트를 열 때마다 나가는 탭 저장의 메아리가 모든 창에서
 * settings_get_all 전체 재조회를 돌리던 것(2026-10-22 실측)을 끊는다. 키 목록이 없으면(옛 발신자,
 * 설정 창의 `emit("settings-changed", {})`) 예전처럼 전부 다시 읽는다.
 *
 * 디바운스: 슬라이더 드래그는 settings_set 을 연달아 부르고, 그때마다 load() 를 돌리면 DB 왕복이
 * 프레임마다 생긴다. 판정은 창(200ms) 안에 모인 키의 **합집합**으로 한다 — 탭 메아리가 진짜 변경과
 * 같은 창에 떨어져도 재조회를 지우거나 미루지 않는다. 드래그 중인 슬라이더가 되감기는 것도 이
 * 지연이 막는다: 손을 뗀 뒤에야 마지막 한 번이 돈다.
 */
import { listenMany } from "./tauriListen";
import { isBrowser } from "./env";
import { useSettingsStore } from "../stores/settings";
import { useAiPresetsStore } from "../stores/aiPresets";
import { useAiInstructionsStore } from "../stores/aiInstructions";

/** 디바운스 지연(ms). 슬라이더 한 번 드래그 = load() 한 번이 되도록. */
const DEBOUNCE_MS = 200;

/** 본 창만 쓰고 읽는 UI 상태 — 다른 창이 재조회할 이유가 없다. 늘릴 때는 쓰는 곳·읽는 곳이 모두
 *  본 창(또는 부팅 1회)뿐인지 grep 으로 확인한다. */
export const WINDOW_LOCAL_KEYS: ReadonlySet<string> = new Set([
  "open_tabs", // stores/tabs.ts · App.tsx
  "active_tab_id",
  "recent_closed_tabs",
  "window_geometry", // App.tsx · invoke.ts(본 창 닫기) — 읽기는 Rust 부팅·트레이 복원
  "left_width", // leftpanel 드래그
  "source_pct", // App.tsx 분할 드래그
  "sidebar_collapsed", // stores/ui.ts — load() 대상도 아니다
  "favorites_open", // notetree 즐겨찾기 접기
  "search_recent", // stores/search.ts — load() 대상도 아니다
]);

const PRESETS_KEY = "ai_action_presets";
const INSTRUCTIONS_KEY = "ai_internal_instructions";

/** 페이로드의 키 목록. 없거나 모양이 다르면 null = "무엇이 바뀌었는지 모른다". */
function changedKeys(payload: unknown): string[] | null {
  const keys = (payload as { keys?: unknown } | null | undefined)?.keys;
  if (!Array.isArray(keys)) return null;
  const out = keys.filter((k): k is string => typeof k === "string");
  return out.length > 0 ? out : null;
}

export function listenSettingsChanged(): () => void {
  // 브라우저(동기화 탭)에는 Tauri 이벤트 버스가 없다. 설정 창도 없으므로 들을 것이 없다.
  if (isBrowser()) return () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;
  // 디바운스 창 안에 모인 것 — full 이면 키와 무관하게 전부 다시 읽는다.
  let pendingFull = false;
  const pendingKeys = new Set<string>();

  const flush = () => {
    timer = undefined;
    const full = pendingFull;
    const keys = new Set(pendingKeys);
    pendingFull = false;
    pendingKeys.clear();

    void useSettingsStore.getState().load();
    // AI 프리셋(`ai_action_presets`)·엔진 지침(`ai_internal_instructions`)은 설정 스토어가 아니라 자기
    // 스토어가 들고 있다 — 설정 창에서 고친 것이 본 창 AI 모달·관계도·시트 경로에 재시작 없이 닿게
    // 같이 다시 읽되, 그 키가 바뀌었을 때만. 아직 한 번도 안 읽은 창은 건너뛴다(처음 쓰일 때 스스로
    // 읽는다). load() 는 읽기만 해서 자기 쓰기의 메아리가 다시 쓰기를 부르지 않는다.
    const presets = useAiPresetsStore.getState();
    if (presets.loaded && (full || keys.has(PRESETS_KEY))) void presets.load();
    const instructions = useAiInstructionsStore.getState();
    if (instructions.loaded && (full || keys.has(INSTRUCTIONS_KEY))) void instructions.load();
  };

  const schedule = (event?: { payload?: unknown }) => {
    const keys = changedKeys(event?.payload);
    if (keys === null) {
      pendingFull = true;
    } else {
      const relevant = keys.filter((k) => !WINDOW_LOCAL_KEYS.has(k));
      // 창 로컬 키뿐인 메아리 — 걸려 있는 진짜 재조회를 지우지도 미루지도 않는다.
      if (relevant.length === 0) return;
      // 노트북 전환은 노트북별 키가 통째로 바뀐다 — 전부 다시 읽는다.
      if (relevant.includes("active_workspace_id")) pendingFull = true;
      for (const k of relevant) pendingKeys.add(k);
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  };

  // listenMany 가 listen() reject 를 삼킨다(.catch) — 테스트 환경(jsdom, Tauri IPC 없음)에서는
  // listen() 이 reject 한다. PetSprite.tsx 와 같은 패턴, 안 삼키면 미처리 rejection 이 샌다.
  const unlisten = listenMany([["settings-changed", schedule]]);

  return () => {
    if (timer) clearTimeout(timer);
    unlisten();
  };
}
