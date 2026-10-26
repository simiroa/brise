import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { listenMany } from "../../lib/tauriListen";
import { call, callSilent } from "../../lib/invoke";
import type { PetNotificationsOutput, PetBubbleToggleOutput } from "../../lib/commands.gen";
import { PetSprite } from "./PetSprite";
import { createPetBehavior, type PetSignalKind, type PetSnapshot } from "./petBehavior";
import { usePetTheme } from "./usePetTheme";
import { applySavedAppearanceSeed } from "../../lib/appearance";
import { DRAG_THRESHOLD_PX } from "../../lib/pointerContract";
// W8-h: 펫은 풀 앱 부팅을 건너뛰어(main.tsx) 이 토큰 시트를 아무도 로드하지 않았었다 — 그래서
// pet.css 가 색을 전부 하드코딩해 테마/accent 를 무시했다. mobile/MobileApp.tsx 도 같은 이유로
// 같은 방식(엔트리 컴포넌트에서 직접 import)으로 tokens.css 를 불러온다 — 그 판례를 그대로 따른다.
import "../../styles/tokens.css";
import "./petwindow.css";
import "./pet.css";

// WAVE K — React 렌더 이전에 동기로 외형 시드 적용 (첫 페인트 스타일 지연 깜빡임 방지)
applySavedAppearanceSeed();

/**
 * 캐릭터 창(#/pet). **크기가 절대 바뀌지 않는다** — 말풍선·채팅은 별도 창(#/pet-bubble)이고,
 * 그 창의 생성·크기·배치는 전부 Rust 가 한다(src-tauri/src/pet_window.rs).
 *
 * 그렇게 나눈 이유(오너 신고 "펫 위치가 계속 틀어짐"): 예전엔 이 창 하나를 160×180 ↔ 320×420
 * 으로 키우며 좌상단을 늘어난 만큼 당겼다. 모니터 경계를 못 봐서 화면 왼쪽/위에서는 창이 화면
 * 밖으로 나갔고, 분수 DPI 에서는 반올림이 토글마다 누적됐다. 창이 리사이즈를 안 하면 두 문제가
 * 존재할 수 없다. 그래서 이 파일에는 더 이상 지오메트리 계산이 없다(구 ./geometry.ts 는 삭제).
 *
 * 이 창은 풀 앱 부팅을 생략한다(src/main.tsx) — 스토어/i18n/동기화 클라이언트를 가져오지 않는다.
 * 그래서 백엔드 호출은 전부 직접 `call()` 이고, 사용자에게 보이는 문구는 아래 한국어 상수다.
 * 부를 수 있는 커맨드는 Rust 쪽 allowlist 로 제한된다(pet_window::PET_ALLOWED_COMMANDS).
 */

/** 알림 폴링 주기 — 푸시 채널을 새로 만들지 않고 가벼운 쿼리 하나를 주기 호출한다. */
const NOTIFY_POLL_MS = 5 * 60 * 1000;
// 포인터가 이만큼 움직이면 클릭이 아니라 드래그로 본다 — 앱 전역 한 값(lib/pointerContract.ts,
// W7-2 통합)을 쓰고 자체 상수를 만들지 않는다.
/** 드래그가 멈춘 뒤 위치를 저장하기까지 기다리는 시간. */
const PERSIST_DEBOUNCE_MS = 500;
/** 화면 저장 결과가 이 시간 안에 안 오면 실패로 안내한다 — 메인 창이 안 듣고 있으면(브리지
 *  미마운트) "화면을 살펴보는 중…" 말풍선이 영원히 남았다. 비전 왕복 상한 75초
 *  (src-tauri/src/repo/ai/transport.rs VISION_OPERATION_DEADLINE) + 캡처·검색 여유 10초. */
const SHOT_TIMEOUT_MS = 85_000;

/** "pet-signal" 이벤트 payload 검증용 — 브리지가 오래된 kind 문자열을 보내도 무시하고 지나간다. */
const KNOWN_SIGNAL_KINDS = new Set<PetSignalKind>([
  "greet",
  "drag-start",
  "drag-end",
  "listen-start",
  "listen-stop",
  "think-start",
  "work-start",
  "task-done",
  "success",
  "failure",
  "attention",
  "attention-clear",
]);

const T = {
  clipEmpty: "클립보드가 비어 있어요.",
  clipBusy: "어디에 둘지 살펴보는 중…",
  shotBusy: "화면을 살펴보는 중…",
  shotStuck: "화면 저장이 응답하지 않아요. 메인 창을 열어 둔 채로 다시 시도해 주세요.",
  failed: "잘 안 됐어요. 잠시 뒤 다시 시도해 주세요.",
};

/** 트레이/펫 공용 메뉴(Rust tray::build_tray_menu)에서 펫 쪽 UI 가 필요한 두 항목이 돌아오는 채널.
 *  Rust 가 클립보드를 대신 읽어 text 로 싣는다(트레이에서 누르면 이 웹뷰에 포커스가 없다). */
type PetMenuRun = { action: "clipboard"; text: string } | { action: "capture" };

export function PetApp() {
  const { aiEnabled, petDblclickAction } = usePetTheme();
  // 의미 상태(activity/animation)는 전부 petBehavior.ts 가 계산한다 — 이 컴포넌트는 신호만 보낸다.
  const behavior = useRef(createPetBehavior());
  const [snap, setSnap] = useState<PetSnapshot>(() => behavior.current.snapshot());
  const [suggestionCount, setSuggestionCount] = useState(0);

  const seenNotices = useRef(new Set<string>());
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  /** 화면 저장 감시 타이머(SHOT_TIMEOUT_MS). 브리지가 결과 신호를 주면 해제된다. */
  const shotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearShotTimer = useCallback(() => {
    if (shotTimer.current === null) return;
    clearTimeout(shotTimer.current);
    shotTimer.current = null;
  }, []);

  /** 의미 신호 하나를 behavior 머신에 넣고 새 스냅샷을 반영한다. */
  const send = useCallback((kind: PetSignalKind) => {
    setSnap(behavior.current.dispatch({ kind }));
  }, []);

  // TTL 재평가용 타이머 1개 — 애니메이션 자체의 프레임 타이머는 CodexPetAtlas 안에 따로 있다.
  // expiresAt 시각에 snapshot()을 다시 불러 만료를 반영한다(신호 없이 시간만 흘러도).
  useEffect(() => {
    if (!snap.expiresAt) return;
    const id = setTimeout(() => setSnap(behavior.current.snapshot()), Math.max(0, snap.expiresAt - Date.now()));
    return () => clearTimeout(id);
  }, [snap]);

  // ── 위치 저장 ─────────────────────────────────────────────────────────────
  // 이제 조건이 없다(예전엔 "접혀 있을 때만" — 펼치면 창이 스스로 움직였으므로). 창은 사용자가
  // 끌 때만 움직이니 저장한 좌표가 곧 사용자가 둔 자리다.
  useEffect(() => {
    const win = getCurrentWindow();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void win
      .onMoved(() => {
        clearTimeout(timeout);
        // 이 디바운스 콜백이 "드래그 끝"의 실질 신호다 — startDragging() 뒤엔 OS가 포인터를
        // 가져가 pointerup 이 안 올 수 있어 거기서 drag-end 를 잡을 수 없다.
        timeout = setTimeout(() => {
          void persistPosition(win);
          send("drag-end");
        }, PERSIST_DEBOUNCE_MS);
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      unlisten?.();
    };
  }, [send]);

  // ── 활동 연동: 로컬에서 새 노트가 생기면 succeeded 를 쏜다 ──────────────────
  // origin==="local" && created===true 로만 좁힌다 — 자동저장 업데이트 폭풍·원격 동기화까지
  // 쏘면 진짜 "저장했다" 신호가 묻힌다(그릴링 확정).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ note_id: string; created: boolean; origin: string }>("remote-note-write", (e) => {
      if (e.payload.origin === "local" && e.payload.created === true) send("success");
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [send]);

  // 말풍선이 (어떤 경로로든) 닫히면 attention 을 푼다 — 창이 둘이라 닫히는 경로가 여럿이다.
  useEffect(() => {
    return listenMany([["pet-bubble-closed", () => send("attention-clear")]]);
  }, [send]);

  // ── 겹침 제안 배지 (P2 2단계) ────────────────────────────────────────────
  // 이 창은 suggestions_list 를 직접 못 부른다(PET_ALLOWED_COMMANDS 좁은 표면) — 메인 창
  // (plugins/pet/bridge/petSuggestionsBridge.ts)이 60초마다 대신 조회해 브로드캐스트하는 걸 듣기만 한다.
  // 배지 카운트(suggestionCount)는 activity 와 별개로 유지한다 — 뱃지는 항상 보이고, activity는
  // needs-attention 슬롯 하나로 다른 신호와 우선순위를 다툰다.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ suggestions: unknown[] }>("pet-suggestions-pending", (e) => {
      if (cancelled) return;
      const count = e.payload.suggestions?.length ?? 0;
      setSuggestionCount(count);
      send(count > 0 ? "attention" : "attention-clear");
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [send]);

  // ── 알림 폴링 (AI 호출 0, 오프라인 동작) ─────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await call<PetNotificationsOutput>("pet_notifications", {});
        if (cancelled) return;
        // 같은 알림으로 5분마다 조르지 않는다. ponytail: 세션 메모리 — 창을 다시 켜면 한 번 더
        // 말한다. 영구 dismiss 가 필요해지면 settings 키가 업그레이드 경로.
        const fresh = res.items.find((n) => !seenNotices.current.has(n.kind + (n.note_id ?? "")));
        if (!fresh) return;
        seenNotices.current.add(fresh.kind + (fresh.note_id ?? ""));
        const shown = await call<{ shown: boolean }>("pet_bubble_notice", {
          text: fresh.text,
          note_id: fresh.note_id ?? null,
        });
        if (shown.shown) send("attention");
      } catch {
        /* call() 이 처리 — 알림은 실패해도 조용히 넘어간다 */
      }
    };
    void poll();
    const id = setInterval(() => void poll(), NOTIFY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [send]);

  // 신규 다리 채널: 클립보드/스크린샷 브리지(petClipboardBridge.ts, petScreenshotBridge.ts)가
  // 결과 신호를 여기로 쏜다 — 알 수 없는 kind는 무시(브리지 쪽 오타/버전 스큐 방어).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ kind: PetSignalKind }>("pet-signal", (e) => {
      const kind = e.payload.kind;
      if (!KNOWN_SIGNAL_KINDS.has(kind)) return;
      // 다리가 결과를 냈다는 뜻 — 화면 저장 감시 타이머를 여기서 푼다(카드/실패 어느 쪽이든).
      if (kind === "task-done" || kind === "failure") clearShotTimer();
      send(kind);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
      clearShotTimer();
    };
  }, [send, clearShotTimer]);

  /** 채팅 창 토글. 열림 여부는 Rust 가 안다(창 존재 여부) — 여기에 플래그를 두지 않는다. */
  const toggleChat = useCallback(() => {
    send("greet");
    send("attention-clear");
    void callSilent<PetBubbleToggleOutput>("pet_bubble_toggle", {}).catch(() => {});
  }, [send]);

  const notice = useCallback((text: string) => {
    void callSilent("pet_bubble_notice", { text, note_id: null }).catch(() => {});
  }, []);

  // ── 클립보드 저장 (docs/PLAN-2026-08-08-presets-schedule.md Q9) ───────────
  // 상시 감시는 비채택 — **메뉴를 누른 순간의** 클립보드 1회. 읽기는 Rust 가 한다(tray.rs
  // run_clipboard — 트레이에서 누르면 이 웹뷰에 포커스가 없어 navigator.clipboard 가 거부된다).
  //
  // 라우팅·저장은 여기서 안 한다 — 이 창은 link_preview/search_notes/섹션 추가 커맨드를 부를
  // 수 없다(PET_ALLOWED_COMMANDS). 메인 창의 다리(src/plugins/pet/bridge/petClipboardBridge.ts)가 대행하고
  // 확인 카드를 pet_bubble_clip 으로 되돌려 준다.
  const saveClipboard = useCallback((raw: string) => {
    const text = raw.trim();
    if (!text) {
      notice(T.clipEmpty);
      return;
    }
    // 링크면 fetch+요약에 몇 초가 걸린다 — 그동안 아무 반응이 없으면 눌린 줄 모른다.
    notice(T.clipBusy);
    send("think-start");
    void emit("pet-clipboard-save", { text }).catch(() => notice(T.failed));
  }, [notice, send]);

  // ── 화면 저장 (docs/PLAN-2026-08-09-pet-capture.md Phase 1) ────────────────
  // 클립보드 저장과 완전히 같은 구조다: 이 창은 캡처·검색·저장 커맨드를 하나도 못 부르므로
  // (PET_ALLOWED_COMMANDS) 이벤트 하나만 쏘고 메인 창의 다리(src/plugins/pet/bridge/petScreenshotBridge.ts)가
  // 전부 대행한다. 캡처 대상은 **이 창이 아니라** z-order 최상위 일반 창이다 — 자기 프로세스
  // 창 제외는 Rust 가 한다(repo::screenshot). 캡처+비전 요약에 몇 초가 걸리므로 먼저 말풍선을
  // 띄운다(누른 줄 모르는 침묵 방지). 그 말풍선도 우리 프로세스라 캡처에 안 잡힌다.
  //
  // emit() 성공은 "누가 들었다"를 뜻하지 않는다 — 메인 창이 닫혀 있거나 브리지가 아직 마운트되지
  // 않았으면 이벤트는 조용히 버려지고 "살펴보는 중…" 말풍선만 영원히 남는다. 그래서 결과 신호
  // (pet-signal task-done/failure, 위 리스너에서 해제)를 기다리는 감시 타이머를 하나 건다.
  const saveScreenshot = useCallback(() => {
    notice(T.shotBusy);
    send("think-start");
    clearShotTimer();
    shotTimer.current = setTimeout(() => {
      shotTimer.current = null;
      send("task-done");
      send("failure");
      notice(T.shotStuck);
    }, SHOT_TIMEOUT_MS);
    void emit("pet-screenshot-capture", {}).catch(() => {
      clearShotTimer();
      send("failure");
      notice(T.failed);
    });
  }, [notice, send, clearShotTimer]);

  // 우클릭 메뉴 = 트레이 메뉴(오너 2026-10-16 "정확히 같은 내용을 상속"). 목록은 Rust
  // tray::build_tray_menu 하나뿐이다 — 여기엔 두 번째 목록을 두지 않는다. 펫 UI 가 필요한 두 항목만
  // "pet-menu-run" 으로 돌아온다(트레이에서 눌러도 같은 채널).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<PetMenuRun>("pet-menu-run", (e) => {
      if (e.payload.action === "clipboard") saveClipboard(e.payload.text);
      else if (e.payload.action === "capture") saveScreenshot();
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [saveClipboard, saveScreenshot]);

  /** 메인 창 열기 — 트리플클릭·더블클릭(AI 꺼짐 폴백)이 트레이 "열기"와 같은 커맨드를 탄다. */
  const openMain = useCallback(() => {
    void callSilent("pet_open_main", {}).catch(() => {});
  }, []);

  // ── 스프라이트: 드래그와 클릭 구분 ───────────────────────────────────────
  const runPetAction = useCallback((act: "chat" | "new_note" | "off") => {
    if (act === "off") return;
    if (act === "chat") {
      // W18: AI 꺼짐 폴백 — 메인 창 열기
      if (!aiEnabled) {
        openMain();
        return;
      }
      toggleChat();
    } else if (act === "new_note") {
      openMain();
      // B2: 메인 창 열기 + 새 노트 생성 + 커서 진입
      setTimeout(() => void emit("pet-action-new-note"), 200);
    }
  }, [toggleChat, openMain, aiEnabled]);

  // startDragging() 을 pointerdown 에서 바로 부르면 OS 가 포인터를 가져가 클릭이 영영 안 온다.
  // 문턱을 넘게 움직였을 때만 드래그로 승격하고, 안 움직였으면 pointerup 에서 동작을 실행한다.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragging.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const start = dragStart.current;
    if (!start || dragging.current) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD_PX) return;
    dragging.current = true;
    send("drag-start");
    void getCurrentWindow().startDragging();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const owned = dragStart.current !== null;
    const wasDrag = dragging.current;
    dragStart.current = null;
    dragging.current = false;
    if (e.button === 0 && owned && !wasDrag) {
      runPetAction("chat");
    }
  };
  // 더블클릭 / 트리플클릭 처리.
  const onClick = (e: React.MouseEvent) => {
    if (e.detail === 2) {
      runPetAction(petDblclickAction);
    } else if (e.detail >= 3) {
      openMain();
    }
  };

  return (
    <div className="pet-app">
      <div
        className="pet-app__sprite"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          void callSilent("pet_menu_popup", {}).catch(() => {});
        }}
      >
        <PetSprite snapshot={snap} />
        {suggestionCount > 0 ? (
          <span className="pet-app__badge" role="status" aria-label="검토할 제안 있음" />
        ) : null}
      </div>

    </div>
  );
}

/**
 * 드래그로 옮긴 위치를 영속. 범용 `settings_set` 이 아니라 전용 `pet_set_position` 을 쓴다 —
 * 펫 창의 커맨드 allowlist 에서 settings_set 을 빼기 위한 좁은 표면이다(pet_window.rs 참고).
 */
async function persistPosition(win: ReturnType<typeof getCurrentWindow>): Promise<void> {
  try {
    const [pos, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
    const logical = pos.toLogical(scale);
    await call("pet_set_position", {
      x: Math.round(logical.x),
      y: Math.round(logical.y),
    });
  } catch {
    // ponytail: best-effort — a missed save just falls back to the computed default next boot
    // (pet_window.rs::resolve_position), no retry queue needed for a cosmetic position.
  }
}
