/**
 * 실시간 변경 반영 — 백엔드의 단일 초크포인트(src-tauri/src/events.rs)가 내는 "remote-note-write"
 * 를 받아 트리/캐시/열린 노트를 새로고침한다. 데스크톱 웹뷰는 Tauri 이벤트로, 브라우저(폰,
 * /app)는 SSE(GET /api/v1/events → lib/httpBridge.ts::browserListen)로 같은 payload 를 받는다.
 * App.tsx 는 마운트 시 listenRemoteNoteWrite() 를 한 번 등록만 한다 — 실제 반영 로직은 여기
 * (handleRemoteNoteWrite)에 있어 App.tsx 를 렌더링하지 않고도 테스트할 수 있다.
 *
 * W1(모바일 재편, 2026-09): MobileApp 도 같은 함수를 등록한다. 트리/피드 무효화는 항상
 * `store.loadTree()` 하나로 처리한다 — `loadTree()` 자신이 `isBrowser()&&isMobileViewport()` 를
 * 판정해 모바일에서는 folder_list 전수 조회를 건너뛰고 bumpNoteQueryVersion() 만 돈다
 * (stores/notesTree.ts, W2b 통합 웨이브). 이 파일은 그 분기를 몰라도 된다. `RemoteNoteWriteMobileOpts`
 * 는 이제 `onFocusSkipped` 하나만 나른다 — 포커스 보호로 reloadActive() 를 건너뛴 경우 MobileNote
 * 의 "원격 변경" 배너를 띄우는 콜백. 데스크톱은 opts 없이 호출해 기존 동작이 그대로다.
 *
 * payload(추가 필드는 모두 optional — 구버전 호환, docs/CLIENT-RULES.md §2-3):
 *   note_id: 영향받은 노트. **null 이면 "뭔가 바뀌었다"**(폴더/워크스페이스/일괄 임포트처럼 노트
 *            하나로 좁힐 수 없는 변경) — 무시하지 말고 가벼운 재조회(트리+목록)를 한다.
 *   created: 새로 만들어진 노트인지.
 *   origin:  "local"(데스크톱 IPC 쓰기) | "remote"(폰이 HTTP 로 한 쓰기). 없으면 "remote"로 본다
 *            (구버전 서버 호환 — 예전엔 원격 쓰기만 이 이벤트를 냈다).
 *   window:  쓰기를 낸 데스크톱 창의 라벨(동기 커맨드 + `publish_as` 로 라벨을 싣는 async 쓰기 커맨드 — attachment_add_file/bytes ·
 *            doc_import_html · export_note · workspace_delete). 백그라운드 작업·라벨을 아직 안 싣는 async 커맨드·HTTP 경로는 null.
 *
 * 루프 방지 규칙(백엔드 규칙과 한 쌍, SSOT: src-tauri/src/events.rs 헤더) — 판정은 전부 `classifyWrite` 한 곳이다:
 *   **데스크톱 웹뷰는 window===자기 라벨 인 이벤트를 무시한다** — 자기가 방금 낸 쓰기의 메아리이고,
 *   스토어는 이미 갱신돼 있다. 그대로 재로드하면 방금 친 글자를 되돌린다. 다른 창(설정·브리핑·섹션)의
 *   쓰기는 반영한다. window===null 인 local 쓰기는 누가 냈는지 모르므로 **coarse 로만**(트리+목록) 반영하고
 *   열린 노트는 건드리지 않는다 — 자기 async 저장을 "다른 곳의 변경" 배너로 오인하지 않게. 브라우저 클라이언트는
 *   반대로 둘 다 반영해야 한다(데스크톱 쓰기를 받는 게 이 기능의 나머지 절반). 브라우저가 받는
 *   "자기 쓰기의 메아리"는 재조회 한 번으로 끝나고 새 쓰기를 만들지 않으므로 루프가 아니다.
 *
 * 편집 중 버퍼 보호: 열려 있는 노트의 본문 재로드는 (1) 저장 진행 중이거나(savedState==="saving")
 * (2) 포커스가 편집 영역(본문 contenteditable / 제목 input / textarea) 안에 있으면 건너뛴다.
 * 그래도 트리/목록 새로고침은 항상 한다 — "포커스된 편집 영역만 빼고 전부 새로고침"이 가장 안전하다(디바운스 저장이 아직 나가지 않은 구간엔
 * savedState 가 "saved" 라 그것만으로는 타이핑 중인 버퍼를 지킬 수 없다).
 *
 * 섹션 분리 창의 자동저장(window "section-*")은 `light` 다 — 질의 캐시 무효화만 하고 트리 전수 재조회는 조용해진 뒤(LIGHT_TREE_DEBOUNCE_MS,
 * 최대 LIGHT_TREE_MAX_WAIT_MS)로 미룬다. 예전엔 타이핑 300ms 마다 loadTree 가 돌았다(565d8098 이후 데스크톱이 다른 창의 쓰기를 받으면서).
 *
 * 합치기(listenRemoteNoteWrite): 새로고침의 핵심인 loadTree() 는 데스크톱에서 LIMIT 없는 folder_list 전수
 * 조회 + settings_get_all 이다. 예전엔 알림 1건마다 그대로 불렀다 — 에이전트(brise mcp)가 20번 연달아 쓰면
 * 20번 전수 조회가 나갔다(2026-09-27 실앱 계측, 10만 노트면 ≈21초로 외삽 — PLAN-2026-09-27-agent-tools-mcp §12.1).
 * 이제 REMOTE_WRITE_COALESCE_MS 창 안의 알림을 한 번으로 합치고, 새로고침이 도는 동안 온 알림은 끝난 뒤 한 번 더
 * 돌린다(동시에 두 번 돌지 않는다). 창은 고정(첫 알림 기준) — 계속 들어와도 최대 지연이 창 하나로 묶인다.
 * 열린 노트의 본문 재로드 여부는 합친 시점(flush)의 포커스·저장 상태로 판정한다.
 */
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useNotesStore } from "../stores/notes";
import { bumpNoteQueryVersion } from "./noteQuery";
import { isBrowser, CLIENT_ID } from "./env";
import { browserListen } from "./httpBridge";
import { listenMany } from "./tauriListen";

/** 원격 쓰기 알림을 한 번의 새로고침으로 합치는 창(ms). 고정 창이라 연속 쓰기 중에도 이 이상 늦지 않는다. */
export const REMOTE_WRITE_COALESCE_MS = 300;

/** light 쓰기(섹션 분리 창 자동저장)가 미루는 트리 전수 재조회 — 마지막 쓰기 뒤 이만큼 조용하면 한 번(디바운스)... */
export const LIGHT_TREE_DEBOUNCE_MS = 3000;
/** ...단 첫 light 쓰기 기준 이 시간을 넘기지는 않는다(계속 쳐도 트리가 영영 안 갱신되지 않게). */
export const LIGHT_TREE_MAX_WAIT_MS = 30_000;

export interface RemoteNoteWriteMobileOpts {
  /** 열린 노트에 원격 쓰기가 도착했는데 포커스 보호로 reloadActive() 를 건너뛴 경우 호출된다 —
   *  MobileApp 이 이걸로 noteRef 를 통해 MobileNote 의 "원격 변경" 배너를 띄운다. 데스크톱(opts
   *  없음)에서는 전달되지 않으므로 배너 관련 동작이 전혀 없다. */
  onFocusSkipped?: (noteId: string) => void;
}

export interface RemoteNoteWritePayload {
  /** null = 노트 하나로 좁힐 수 없는 변경(coarse) — 가벼운 재조회로 처리한다. */
  note_id: string | null;
  created: boolean;
  /** additive: 구버전 서버는 안 보낸다(그 시절엔 원격 쓰기만 이벤트를 냈으므로 "remote"로 간주). */
  origin?: "local" | "remote";
  /** additive: 쓴 클라이언트의 id(X-Brise-Client). 내 id 와 같으면 내 저장의 메아리다. */
  client?: string;
  /** additive: 쓴 데스크톱 창의 라벨(events.rs::scope_window). null/없음 = 모름(async 커맨드·백그라운드·HTTP). */
  window?: string | null;
}

/**
 * 캐럿이 편집 영역에 있으면 본문을 갈아끼우지 않는다(타이핑 중인 버퍼 보호).
 * 본문(tiptap `.ProseMirror` = contenteditable)뿐 아니라 input/textarea 도 포함한다 — 제목은
 * TitleBar 의 `<input>` 이고 디바운스 저장이라, 키 입력 직후엔 savedState 가 아직 "saved" 다.
 * 창 자체가 포커스를 잃었으면(사용자가 다른 창에서 친다) 편집 중이 아니다 — 웹뷰는 OS 창이 포커스를 잃어도
 * activeElement 를 그대로 들고 있어서, 이걸 안 보면 다른 창의 쓰기마다 거짓 "다른 기기에서 변경" 배너가 뜬다.
 * 그때의 재로드는 안전하다(reloadActive 가 flushAll 먼저).
 */
function isEditingFocused(): boolean {
  if (typeof document === "undefined") return false;
  if (!document.hasFocus()) return false;
  const el = document.activeElement as Element | null;
  return !!el?.closest?.(
    'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
  );
}

/** 이 창의 웹뷰 라벨 — events.rs 가 싣는 `window` 와 같은 값(lib.rs 가 webview_ref().label() 을 읽는다).
 *  Tauri 밖(vitest/jsdom)에서는 getCurrentWindow() 가 던진다 — 그럼 null(어느 창과도 같지 않다). */
let ownLabel: string | null | undefined;
function ownWindowLabel(): string | null {
  if (ownLabel === undefined) {
    try {
      ownLabel = getCurrentWindow().label; // 창 라벨 = lib.rs 가 읽는 웹뷰 라벨(WebviewWindow 는 둘이 같다)
    } catch {
      ownLabel = null; // silent-ok: Tauri 밖에는 창이 없다 — 메아리 판정이 "남의 쓰기"로 기울 뿐이다
    }
  }
  return ownLabel;
}

/** classifyWrite 가 읽는 이 클라이언트의 사정 — 순수 함수로 두려고 환경(브라우저인가·내 창 라벨·내 클라이언트 id)을 인자로 받는다. */
export interface WriteContext {
  browser: boolean;
  ownLabel: string | null;
  clientId: string | null;
}

/** 알림 한 건이 이 클라이언트에 요구하는 일.
 *  - ignore: 내가 방금 낸 쓰기의 메아리(데스크톱 웹뷰) — 스토어가 이미 갱신돼 있다. 아무것도 하지 않는다.
 *  - light:  트리가 바뀔 게 거의 없는 쓰기(섹션 분리 창의 자동저장) — 질의 캐시 무효화만 즉시, 트리 전수 재조회는 길게 미룬다.
 *  - tree:   트리+목록만 다시 읽는다(열린 노트는 건드리지 않는다) — 노트 하나로 좁힐 수 없는 변경, 내 client 의 메아리, 출처 모를 local.
 *  - body:   트리+목록에 더해 열린 노트 본문까지(그 노트가 바뀌었고 출처가 확실할 때). */
export type WriteEffect = "ignore" | "light" | "tree" | "body";

/**
 * 루프 방지·재조회 규칙의 **단일 판정 지점** — 스케줄러(listenRemoteNoteWrite)와 즉시 반영(handleRemoteNoteWrite)은 이 결과만 소비한다.
 * 백엔드 규칙(src-tauri/src/events.rs 헤더)과 한 쌍이다. 순서가 뜻이 있다:
 *   1. 데스크톱 웹뷰가 받은 window===내 라벨 → ignore.
 *   2. 노트 하나로 좁힐 수 없다(note_id 없음) · 내 client 의 메아리 · 데스크톱의 local 쓰기인데 낸 창을 모른다(백그라운드 워커·라벨을 아직
 *      안 싣는 async 커맨드) → tree. 누가 어느 노트를 썼는지 모르니 열린 노트 본문은 건드리지 않는다(자기 저장을 "다른 곳의 변경" 배너로 오인 금지).
 *   3. 섹션 분리 창(src-tauri/src/section_window.rs::SECTION_LABEL_PREFIX)의 쓰기(데스크톱 한정) → light. 그 섹션은 본 창에서 플레이스홀더라
 *      본문 재로드가 필요 없고(타이핑 300ms 마다 열린 노트를 통째로 다시 그리게 된다), 트리가 이 쓰기로 바뀌는 건 updated_at(날짜 범위
 *      필터가 읽는다) 정도다 — folder_list 는 has_image·tag_names 를 채우지 않고(repo/folders.rs) 제목·폴더·정렬 키는 본문 저장이 안 건드린다.
 *      그래서 트리 전수 재조회(LIMIT 없는 folder_list — 10만 노트 약 594ms, docs/SCALABILITY.md)를 자동저장마다 돌릴 이유가 없다.
 *      브라우저(태블릿·폰)는 이 규칙을 안 탄다 — 거기선 이 쓰기도 남의 쓰기라 그대로 tree/body 로 반영한다.
 *   4. 나머지(노트 id 가 있는 다른 창·원격의 쓰기) → body.
 */
export function classifyWrite(payload: RemoteNoteWritePayload, ctx: WriteContext): WriteEffect {
  if (!ctx.browser && payload.window && payload.window === ctx.ownLabel) return "ignore";
  const ownClient = !!payload.client && payload.client === ctx.clientId;
  const unattributedLocal = !ctx.browser && (payload.origin ?? "remote") === "local" && !payload.window;
  if (!payload.note_id || ownClient || unattributedLocal) return "tree";
  if (!ctx.browser && !!payload.window?.startsWith("section-")) return "light";
  return "body";
}

/** 지금 이 클라이언트의 WriteContext. */
function writeContext(): WriteContext {
  return { browser: isBrowser(), ownLabel: ownWindowLabel(), clientId: CLIENT_ID };
}

/**
 * 데이터 전체가 갈아끼워졌다(초기화·백업 복원·대체 가져오기, commands/transfer.rs::publish_data_replaced) —
 * 노트북·폴더·설정·열린 탭까지 전부 무효라 창을 통째로 다시 불러온다. 본 창·브리핑·활동 창이 등록한다.
 * 설정 창은 등록하지 않는다 — 스냅샷 안내를 보여 준 뒤 스스로 다시 불러온다(DataManagementSection).
 * 브라우저(폰)에는 이 이벤트가 오지 않는다(httpBridge SSE_EVENTS 밖) — 같이 나가는 coarse 알림으로 따라온다.
 */
export function listenDataReplaced(): () => void {
  if (isBrowser()) return () => {};
  return listenMany([["data-replaced", () => window.location.reload()]]);
}

/** 알림 한 건을 즉시 반영한다. 반환값은 트리 새로고침(loadTree)의 완료 — 합치기가 "도는 중"을 알려고 쓴다.
 *  loadTree 는 callSilent 실패를 다시 던지므로 호출자가 붙잡아야 한다(실패 기록은 callSilent 가 이미 남긴다). */
export function handleRemoteNoteWrite(payload: RemoteNoteWritePayload, opts?: RemoteNoteWriteMobileOpts): Promise<void> {
  const effect = classifyWrite(payload, writeContext());
  if (effect === "ignore") return Promise.resolve();

  // light — 트리 전수 재조회 없이 질의 캐시만 올린다(미룬 트리 재조회는 listenRemoteNoteWrite 의 몫).
  if (effect === "light") {
    bumpNoteQueryVersion();
    return Promise.resolve();
  }

  const store = useNotesStore.getState();
  // loadTree() 는 이제 스스로 isBrowser()&&isMobileViewport() 를 판정한다(stores/notesTree.ts) —
  // 모바일에서는 folder_list 를 건너뛰고 bumpNoteQueryVersion() 만 돈다, 데스크톱은 기존 그대로.
  // 그래서 이 함수는 더 이상 그 분기를 몰라도 된다. loadTree() 는 내부에서 이미
  // bumpNoteQueryVersion() 을 부르지만(stores/notesTree.ts), 여기서 한 번 더 부르는 건 무해하고
  // (멱등), "버전을 올린다"는 요구사항 자체를 이 함수만 읽어도 알 수 있게 명시적으로 남겨 둔다.
  // coarse(note_id=null) 이벤트도 여기까지는 똑같이 처리된다.
  const treeLoaded = store.loadTree();
  bumpNoteQueryVersion();

  // 내가 방금 낸 쓰기의 메아리 — 트리는 갱신하되(위) 열린 노트는 건드리지 않는다. 안 그러면 편집 중 폰이
  // 자기 저장을 "다른 기기에서 변경됨" 배너로 오인한다(2026-10-06 실기기). 출처 모를 local 쓰기와
  // note_id 없는 coarse 도 같다 — 어느 노트인지(또는 누가 냈는지) 모르니 본문 버퍼는 건드리지 않는다.
  const noteId = payload.note_id;
  if (effect !== "body" || !noteId) return treeLoaded;
  const active = store.activeNote;
  if (active && active.note.id === noteId && store.savedState !== "saving") {
    // 저장 실패·충돌 중이면 포커스와 무관하게 재로드하지 않는다(감사 M-9) — 재로드가 에디터를 상대본으로 덮으면
    // 이어 치는 글이 게이트에 붙잡힌 내 원본을 대체해 [복사]도 [덮어쓰기]도 원본을 잃는다. 배너로만 알린다.
    const holdingUnsaved = store.savedState === "failed" || store.saveConflict?.noteId === noteId;
    if (holdingUnsaved || isEditingFocused()) {
      // 모바일 전용: 포커스 보호로 조용히 건너뛰는 대신 배너를 띄울 신호를 준다. opts 가 없으면
      // (데스크톱) 아무 일도 없다 — 기존 규칙 그대로.
      opts?.onFocusSkipped?.(noteId);
    } else {
      void store.reloadActive();
    }
  }
  return treeLoaded;
}

/** App.tsx/MobileApp 마운트 시 1회 호출 — 반환값은 useEffect cleanup용 해제 함수. `opts` 는
 *  모바일 전용(RemoteNoteWriteMobileOpts 헤더 참고) — 데스크톱은 인자 없이 그대로 호출한다. */
export function listenRemoteNoteWrite(opts?: RemoteNoteWriteMobileOpts): () => void {
  let unlisten: (() => void) | undefined;
  let cancelled = false;

  // 합치기 상태(이 등록 하나의 것) — 모인 노트 id, 트리가 필요한가 / 질의 캐시만 필요한가, 예약된 flush, 새로고침이 도는 중인가.
  const pendingIds = new Set<string>();
  let needTree = false;
  let needQuery = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  // light(섹션 분리 창 자동저장)가 미루는 트리 재조회 — 디바운스(마지막 쓰기 뒤 LIGHT_TREE_DEBOUNCE_MS)이되 첫 쓰기 기준 최대
  // LIGHT_TREE_MAX_WAIT_MS 를 넘기지 않는다(계속 치고 있어도 트리가 영영 안 갱신되지는 않게).
  let lightTimer: ReturnType<typeof setTimeout> | null = null;
  let lightSince = 0;

  const schedule = () => {
    if (timer === null && !inFlight && !cancelled) timer = setTimeout(flush, REMOTE_WRITE_COALESCE_MS);
  };
  const flush = () => {
    timer = null;
    if ((!needTree && !needQuery) || cancelled) return;
    const treeNeeded = needTree;
    needTree = false;
    needQuery = false;
    // light 만 모였으면 질의 캐시만 올린다 — 트리 전수 재조회 없음.
    if (!treeNeeded) {
      bumpNoteQueryVersion();
      return;
    }
    // 모인 쓰기 중 열린 노트가 있으면 그 노트로, 없으면 coarse(트리+목록만)로 한 번 반영한다.
    const activeId = useNotesStore.getState().activeNote?.note.id ?? null;
    const touchedActive = activeId !== null && pendingIds.has(activeId);
    pendingIds.clear();
    inFlight = true;
    handleRemoteNoteWrite({ note_id: touchedActive ? activeId : null, created: false, origin: "remote" }, opts)
      .catch(() => {}) // silent-ok: loadTree 는 callSilent 라 실패가 이미 진단 로그(logError)에 남는다
      .finally(() => {
        inFlight = false;
        if (needTree || needQuery) schedule();
      });
  };
  const scheduleLightTree = () => {
    const now = Date.now();
    if (lightTimer === null) lightSince = now;
    else clearTimeout(lightTimer);
    const wait = Math.min(LIGHT_TREE_DEBOUNCE_MS, Math.max(0, lightSince + LIGHT_TREE_MAX_WAIT_MS - now));
    lightTimer = setTimeout(() => {
      lightTimer = null;
      if (cancelled) return;
      needTree = true;
      schedule();
    }, wait);
  };

  const listener = isBrowser() ? browserListen : listen;
  void listener<RemoteNoteWritePayload>("remote-note-write", (event) => {
    const effect = classifyWrite(event.payload, writeContext());
    if (effect === "ignore") return;
    if (effect === "light") {
      needQuery = true;
      scheduleLightTree();
      schedule();
      return;
    }
    needTree = true;
    // tree(내 메아리·출처 모를 local·coarse)는 노트 id 를 모으지 않는다 — 그러면 flush 가 coarse(트리만)로 처리해 열린 노트를
    // 건드리지 않는다(편집 중 자기 저장을 "다른 기기의 변경" 배너로 오인하던 것, 2026-10-06 실기기). body 만 모은다.
    if (effect === "body") pendingIds.add(event.payload.note_id!);
    schedule();
  }).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
    if (lightTimer !== null) clearTimeout(lightTimer);
    unlisten?.();
  };
}
