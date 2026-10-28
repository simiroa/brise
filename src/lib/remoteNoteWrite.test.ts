import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const loadTreeMock = vi.fn(async () => {});
const reloadActiveMock = vi.fn(async () => {});
const bumpNoteQueryVersionMock = vi.fn();

let activeNote: { note: { id: string } } | null = null;
let savedState: "saved" | "saving" | "failed" | "ai_organized" = "saved";
let saveConflict: { noteId: string; sectionId: string } | null = null;

vi.mock("../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      activeNote,
      savedState,
      saveConflict,
      loadTree: loadTreeMock,
      reloadActive: reloadActiveMock,
    }),
  },
}));

vi.mock("./noteQuery", () => ({
  bumpNoteQueryVersion: (...args: unknown[]) => bumpNoteQueryVersionMock(...args),
}));

// isBrowser() decides which loop-prevention branch runs: the desktop webview drops writes stamped with
// its own window label, a browser tab acts on everything. Default false = desktop.
let browserMode = false;
vi.mock("./env", () => ({ isBrowser: () => browserMode, CLIENT_ID: "me-1" }));
vi.mock("./httpBridge", () => ({ browserListen: (...args: unknown[]) => listenMock(...args) }));

// listen() mock — captures the registered handler so tests can fire it directly, and hands back
// a resolvable unlisten fn (matches the shape App.tsx/DictateControl.tsx already rely on).
const listenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));
// 이 창의 라벨 — events.rs 가 payload.window 에 싣는 값과 비교된다.
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

import {
  classifyWrite,
  handleRemoteNoteWrite,
  LIGHT_TREE_DEBOUNCE_MS,
  LIGHT_TREE_MAX_WAIT_MS,
  listenDataReplaced,
  listenRemoteNoteWrite,
  REMOTE_WRITE_COALESCE_MS,
  type RemoteNoteWritePayload,
  type WriteContext,
} from "./remoteNoteWrite";

// 루프 방지·재조회 규칙의 단일 판정 함수 — 규칙표를 그대로 검증한다(백엔드 규칙: src-tauri/src/events.rs 헤더).
describe("classifyWrite", () => {
  const desktop: WriteContext = { browser: false, ownLabel: "main", clientId: "me-1" };
  const browser: WriteContext = { browser: true, ownLabel: null, clientId: "me-1" };
  const w = (p: Partial<RemoteNoteWritePayload>): RemoteNoteWritePayload => ({ note_id: "n1", created: false, ...p });

  it("데스크톱: 내 창 라벨이 찍힌 쓰기는 메아리라 ignore — 동기든 라벨을 싣는 async 커맨드든 같다", () => {
    expect(classifyWrite(w({ origin: "local", window: "main" }), desktop)).toBe("ignore");
    expect(classifyWrite(w({ origin: "local", window: "main", note_id: null }), desktop)).toBe("ignore");
  });

  it("데스크톱: 다른 창(설정·브리핑)의 쓰기는 반영한다 — 노트 id 가 있으면 body, 없으면 tree", () => {
    expect(classifyWrite(w({ origin: "local", window: "settings" }), desktop)).toBe("body");
    expect(classifyWrite(w({ origin: "local", window: "briefing" }), desktop)).toBe("body");
    expect(classifyWrite(w({ origin: "local", window: "settings", note_id: null }), desktop)).toBe("tree");
  });

  it("데스크톱: 낸 창을 모르는 local 쓰기(백그라운드 워커·라벨 없는 async 커맨드)는 tree — 열린 노트는 건드리지 않는다", () => {
    expect(classifyWrite(w({ origin: "local", window: null }), desktop)).toBe("tree");
    expect(classifyWrite(w({ origin: "local" }), desktop)).toBe("tree");
  });

  it("섹션 분리 창의 쓰기는 light — 본문 재로드도 트리 전수 재조회도 안 한다(데스크톱 한정)", () => {
    expect(classifyWrite(w({ origin: "local", window: "section-abc" }), desktop)).toBe("light");
    // 노트를 못 좁히면 light 가 아니라 tree.
    expect(classifyWrite(w({ origin: "local", window: "section-abc", note_id: null }), desktop)).toBe("tree");
    // 브라우저(태블릿·폰)에선 이 규칙을 안 탄다 — 남의 쓰기라 그대로 반영.
    expect(classifyWrite(w({ origin: "local", window: "section-abc" }), browser)).toBe("body");
  });

  it("내 client id 의 메아리·note_id 없는 coarse 는 tree, 그 밖의 원격 쓰기는 body", () => {
    expect(classifyWrite(w({ origin: "remote", client: "me-1" }), browser)).toBe("tree");
    expect(classifyWrite(w({ origin: "remote", client: "me-1" }), desktop)).toBe("tree");
    expect(classifyWrite(w({ origin: "remote", note_id: null }), browser)).toBe("tree");
    expect(classifyWrite(w({ origin: "remote", client: "someone-else" }), browser)).toBe("body");
    expect(classifyWrite(w({}), desktop)).toBe("body"); // origin 없음 = remote(구버전 서버)
  });

  it("브라우저는 자기 라벨 개념이 없다 — window 가 무엇이든 데스크톱 쓰기를 반영한다", () => {
    expect(classifyWrite(w({ origin: "local", window: "main" }), { ...browser, ownLabel: "main" })).toBe("body");
    expect(classifyWrite(w({ origin: "local", window: null }), browser)).toBe("body");
  });
});

describe("handleRemoteNoteWrite", () => {
  beforeEach(() => {
    loadTreeMock.mockClear();
    reloadActiveMock.mockClear();
    bumpNoteQueryVersionMock.mockClear();
    activeNote = null;
    savedState = "saved";
    saveConflict = null;
    browserMode = false;
    document.body.innerHTML = "";
  });

  it("always reloads the tree and bumps the note query cache version", () => {
    handleRemoteNoteWrite({ note_id: "n1", created: true, origin: "remote" });
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(bumpNoteQueryVersionMock).toHaveBeenCalledTimes(1);
  });

  it("reloads the active note's content when it matches and nothing is mid-save", () => {
    activeNote = { note: { id: "n1" } };
    savedState = "saved";
    handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "remote" });
    expect(reloadActiveMock).toHaveBeenCalledTimes(1);
  });

  it("저장 실패·충돌 중에는 포커스가 없어도 재로드하지 않고 배너 신호만 준다(감사 M-9)", () => {
    activeNote = { note: { id: "n1" } };
    const onFocusSkipped = vi.fn();
    savedState = "failed";
    handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "remote" }, { onFocusSkipped });
    savedState = "saved";
    saveConflict = { noteId: "n1", sectionId: "s1" };
    handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "remote" }, { onFocusSkipped });
    expect(reloadActiveMock).not.toHaveBeenCalled();
    expect(onFocusSkipped).toHaveBeenCalledTimes(2);
  });

  it("내 client id 가 실린 메아리는 트리만 갱신하고 열린 노트를 건드리지 않는다(자기 저장을 다른 기기로 오인 금지)", () => {
    browserMode = true;
    activeNote = { note: { id: "n1" } };
    const onFocusSkipped = vi.fn();
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "remote", client: "me-1" }, { onFocusSkipped });
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(reloadActiveMock).not.toHaveBeenCalled();
    expect(onFocusSkipped).not.toHaveBeenCalled();
    // 다른 클라이언트의 쓰기는 그대로 배너 신호.
    handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "remote", client: "other" }, { onFocusSkipped });
    expect(onFocusSkipped).toHaveBeenCalledWith("n1");
  });

  it("skips the content reload when the open note has a pending local edit (dirty guard)", () => {
    activeNote = { note: { id: "n1" } };
    savedState = "saving";
    handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "remote" });
    expect(reloadActiveMock).not.toHaveBeenCalled();
  });

  it("skips the content reload when the write affected a different note than the open one", () => {
    activeNote = { note: { id: "n1" } };
    savedState = "saved";
    handleRemoteNoteWrite({ note_id: "n2", created: false, origin: "remote" });
    expect(reloadActiveMock).not.toHaveBeenCalled();
  });

  // 루프 방지 규칙(src-tauri/src/events.rs): 데스크톱은 자기 창 라벨이 찍힌 쓰기를 무시한다.
  it("ignores a write stamped with this window's label so the desktop never thrashes on its own edits", () => {
    activeNote = { note: { id: "n1" } };
    handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "local", window: "main" });
    expect(loadTreeMock).not.toHaveBeenCalled();
    expect(reloadActiveMock).not.toHaveBeenCalled();
  });

  // 설정·브리핑·섹션 창의 동기 커맨드 쓰기 — 예전엔 origin "local" 이라 본 창이 메아리로 버렸다.
  it("applies a write from another desktop window, including the open note body", () => {
    activeNote = { note: { id: "n1" } };
    handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "local", window: "briefing" });
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(reloadActiveMock).toHaveBeenCalledTimes(1);
  });

  // async 커맨드·백그라운드 작업은 낸 창을 모른다(window null) — 트리만, 열린 노트·배너는 건드리지 않는다.
  it("treats a local write without a window label as coarse: tree reload only, never the open note", () => {
    activeNote = { note: { id: "n1" } };
    const onFocusSkipped = vi.fn();
    document.body.innerHTML = '<div contenteditable="true" tabindex="0" id="ed"></div>';
    document.getElementById("ed")!.focus();
    handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "local", window: null }, { onFocusSkipped });
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(reloadActiveMock).not.toHaveBeenCalled();
    expect(onFocusSkipped).not.toHaveBeenCalled();
  });

  // 섹션 분리 창은 본 창이 플레이스홀더로 두는 섹션만 쓴다 — 타이핑마다 열린 노트를 다시 그리지 않고, 트리 전수 재조회도 안 한다(light).
  it("treats a write from a detached section window as light: query version only — no tree reload, no note reload, no banner", () => {
    activeNote = { note: { id: "n1" } };
    const onFocusSkipped = vi.fn();
    handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "local", window: "section-s1" }, { onFocusSkipped });
    expect(loadTreeMock).not.toHaveBeenCalled();
    expect(bumpNoteQueryVersionMock).toHaveBeenCalledTimes(1);
    expect(reloadActiveMock).not.toHaveBeenCalled();
    expect(onFocusSkipped).not.toHaveBeenCalled();
  });

  // 웹뷰는 OS 창이 포커스를 잃어도 activeElement 를 들고 있다 — 창이 포커스 밖이면 편집 중이 아니다(거짓 배너 금지).
  it("reloads instead of firing the banner when the caret sits in an editor but the window itself is unfocused", () => {
    activeNote = { note: { id: "n1" } };
    const onFocusSkipped = vi.fn();
    document.body.innerHTML = '<div contenteditable="true" tabindex="0" id="ed"></div>';
    document.getElementById("ed")!.focus();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "local", window: "briefing" }, { onFocusSkipped });
    } finally {
      hasFocus.mockRestore();
    }
    expect(onFocusSkipped).not.toHaveBeenCalled();
    expect(reloadActiveMock).toHaveBeenCalledTimes(1);
  });

  it("still applies a desktop-originated write when running as a browser tab (desktop→phone leg)", () => {
    browserMode = true;
    activeNote = { note: { id: "n1" } };
    handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "local", window: "main" });
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(reloadActiveMock).toHaveBeenCalledTimes(1);
  });

  // 구버전 서버 payload(origin 없음) — 예전엔 원격 쓰기만 이벤트를 냈으므로 "remote"로 본다.
  it("treats a payload without origin as remote (backward compatible)", () => {
    activeNote = { note: { id: "n1" } };
    handleRemoteNoteWrite({ note_id: "n1", created: false });
    expect(reloadActiveMock).toHaveBeenCalledTimes(1);
  });

  it("does a light refresh (tree + query version) on a coarse note_id:null event", () => {
    activeNote = { note: { id: "n1" } };
    handleRemoteNoteWrite({ note_id: null, created: false, origin: "remote" });
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(bumpNoteQueryVersionMock).toHaveBeenCalledTimes(1);
    expect(reloadActiveMock).not.toHaveBeenCalled();
  });

  // savedState 만으로는 "키 입력 ~ 디바운스 저장" 사이 구간을 못 막는다 — 캐럿이 편집 영역에
  // 있으면 본문 재로드를 건너뛴다(트리/목록 새로고침은 그대로).
  it("does not clobber a buffer being typed in: skips the content reload while the editor has focus", () => {
    activeNote = { note: { id: "n1" } };
    savedState = "saved";
    document.body.innerHTML = '<div contenteditable="true" tabindex="0" id="ed"></div>';
    document.getElementById("ed")!.focus();
    handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "remote" });
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(reloadActiveMock).not.toHaveBeenCalled();
  });

  // 제목은 TitleBar 의 <input> + 디바운스 저장이라 savedState 가 "saved" 인 채로 타이핑된다.
  it("does not clobber a title being typed: skips the content reload while an input has focus", () => {
    activeNote = { note: { id: "n1" } };
    savedState = "saved";
    document.body.innerHTML = '<input id="title" />';
    (document.getElementById("title") as HTMLInputElement).focus();
    handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "remote" });
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(reloadActiveMock).not.toHaveBeenCalled();
  });

  it("skips the content reload when no note is open", () => {
    activeNote = null;
    handleRemoteNoteWrite({ note_id: "n1", created: true, origin: "remote" });
    expect(reloadActiveMock).not.toHaveBeenCalled();
  });

  // W2b(모바일 재편 통합) — MobileApp 이 넘기는 onFocusSkipped opt. 모바일/데스크톱 분기는 이제
  // loadTree() 자신(stores/notesTree.ts, 여기서는 mock 이라 그 내부 판단은 안 보인다)이 지므로,
  // 이 레이어에서 볼 수 있는 건 "opts 가 있든 없든 loadTree()/bumpNoteQueryVersion() 은 항상
  // 돈다"는 것과 onFocusSkipped 자체의 스레딩뿐이다.
  describe("onFocusSkipped opt", () => {
    it("still always reloads the tree and bumps the query version when the opt is present", () => {
      activeNote = { note: { id: "n1" } };
      handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "remote" }, { onFocusSkipped: vi.fn() });
      expect(loadTreeMock).toHaveBeenCalledTimes(1);
      expect(bumpNoteQueryVersionMock).toHaveBeenCalledTimes(1);
    });

    it("reloads the active note's content when it matches and nothing is mid-save (same rule as desktop)", () => {
      activeNote = { note: { id: "n1" } };
      savedState = "saved";
      handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "remote" }, { onFocusSkipped: vi.fn() });
      expect(reloadActiveMock).toHaveBeenCalledTimes(1);
    });

    it("skips reloadActive() and fires onFocusSkipped instead when the buffer-protection guard trips", () => {
      activeNote = { note: { id: "n1" } };
      savedState = "saved";
      document.body.innerHTML = '<div contenteditable="true" tabindex="0" id="ed"></div>';
      document.getElementById("ed")!.focus();
      const onFocusSkipped = vi.fn();
      handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "remote" }, { onFocusSkipped });
      expect(reloadActiveMock).not.toHaveBeenCalled();
      expect(onFocusSkipped).toHaveBeenCalledWith("n1");
    });

    it("does not fire onFocusSkipped for the mid-save skip (only the focus guard gets a banner)", () => {
      activeNote = { note: { id: "n1" } };
      savedState = "saving";
      const onFocusSkipped = vi.fn();
      handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "remote" }, { onFocusSkipped });
      expect(reloadActiveMock).not.toHaveBeenCalled();
      expect(onFocusSkipped).not.toHaveBeenCalled();
    });

    // 루프 방지 규칙은 opts 와 별개 축이다 — onFocusSkipped 가 있다고 해서 origin:"local" 무시
    // 규칙이 새로 생기면 안 된다(그 규칙은 "브라우저인가"만 본다, isBrowser()).
    it("still applies a desktop-originated write on the browser path when the opt is present (origin:'local' is not newly ignored)", () => {
      browserMode = true;
      activeNote = { note: { id: "n1" } };
      handleRemoteNoteWrite({ note_id: "n1", created: false, origin: "local" }, { onFocusSkipped: vi.fn() });
      expect(loadTreeMock).toHaveBeenCalledTimes(1);
      expect(bumpNoteQueryVersionMock).toHaveBeenCalledTimes(1);
      expect(reloadActiveMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("listenRemoteNoteWrite", () => {
  type Handler = (event: { payload: unknown }) => void;
  let capturedHandler: Handler | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    loadTreeMock.mockReset();
    loadTreeMock.mockImplementation(async () => {});
    listenMock.mockReset();
    listenMock.mockImplementation((_name: string, handler: Handler) => {
      capturedHandler = handler;
      return Promise.resolve(vi.fn());
    });
    capturedHandler = undefined;
    bumpNoteQueryVersionMock.mockClear();
    reloadActiveMock.mockClear();
    activeNote = null;
    savedState = "saved";
    browserMode = false;
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const fire = (payload: unknown) => capturedHandler?.({ payload });
  const registered = async (opts?: Parameters<typeof listenRemoteNoteWrite>[0]) => {
    const cleanup = listenRemoteNoteWrite(opts);
    await Promise.resolve(); // listen() 의 promise 가 풀리게
    return cleanup;
  };

  it("registers a remote-note-write listener whose handler drives the tree reload after the coalesce window", async () => {
    await registered();
    expect(listenMock).toHaveBeenCalledWith("remote-note-write", expect.any(Function));
    fire({ note_id: "n1", created: true, origin: "remote" });
    expect(loadTreeMock).not.toHaveBeenCalled(); // 창이 닫히기 전엔 아직
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(bumpNoteQueryVersionMock).toHaveBeenCalledTimes(1);
  });

  it("returns a cleanup function that unregisters the listener once it resolves", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cleanup = listenRemoteNoteWrite();
    await Promise.resolve();
    await Promise.resolve();
    cleanup();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  // 2026-09-27 실앱 계측: 에이전트 쓰기 20연속 → 트리 전수 조회 20회. 창 안의 알림은 한 번으로 합친다.
  it("coalesces a burst of writes inside the window into a single tree reload", async () => {
    await registered();
    for (let i = 0; i < 20; i++) fire({ note_id: `n${i}`, created: false, origin: "remote" });
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(bumpNoteQueryVersionMock).toHaveBeenCalledTimes(1);
  });

  it("reloads the open note once when any write in the batch touched it", async () => {
    activeNote = { note: { id: "n7" } };
    await registered();
    fire({ note_id: "n1", created: false, origin: "remote" });
    fire({ note_id: "n7", created: false, origin: "remote" });
    fire({ note_id: "n7", created: false, origin: "remote" });
    fire({ note_id: null, created: false, origin: "remote" });
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(reloadActiveMock).toHaveBeenCalledTimes(1);
  });

  it("does not reload the open note when the batch never touched it", async () => {
    activeNote = { note: { id: "n7" } };
    await registered();
    fire({ note_id: "n1", created: false, origin: "remote" });
    fire({ note_id: null, created: false, origin: "remote" });
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(reloadActiveMock).not.toHaveBeenCalled();
  });

  // 실기기(2026-10-06): 합치기가 payload 를 합성해 handleRemoteNoteWrite 를 부르므로, client 판별은
  // 합치기 입구에서 해야 한다. 내 메아리는 트리만 갱신하고 열린 노트(배너·재로드)는 건드리지 않는다.
  it("내 client id 가 실린 알림은 열린 노트를 건드리지 않고 트리만 갱신한다", async () => {
    browserMode = true;
    activeNote = { note: { id: "n1" } };
    const onFocusSkipped = vi.fn();
    const ta = document.createElement("textarea");
    document.body.append(ta);
    ta.focus();
    await registered({ onFocusSkipped });
    fire({ note_id: "n1", created: false, origin: "remote", client: "me-1" });
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(reloadActiveMock).not.toHaveBeenCalled();
    expect(onFocusSkipped).not.toHaveBeenCalled();
    fire({ note_id: "n1", created: false, origin: "remote", client: "someone-else" });
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    expect(onFocusSkipped).toHaveBeenCalledWith("n1");
  });

  // 섹션 분리 창의 자동저장은 타이핑 내내 쏟아진다 — 예전엔 300ms 마다 LIMIT 없는 folder_list(10만 노트 ≈594ms)가 돌았다.
  describe("섹션 분리 창 자동저장(light)", () => {
    const typing = (n: number, everyMs: number) => async () => {
      for (let i = 0; i < n; i++) {
        fire({ note_id: "n1", created: false, origin: "local", window: "section-s1" });
        await vi.advanceTimersByTimeAsync(everyMs);
      }
    };

    it("타이핑 내내 트리를 다시 읽지 않고 질의 캐시만 올리다가, 조용해진 뒤 한 번만 트리를 읽는다", async () => {
      activeNote = { note: { id: "n1" } };
      await registered();
      await typing(10, 500)(); // 5초 동안 쓰는 중
      expect(loadTreeMock).not.toHaveBeenCalled();
      expect(bumpNoteQueryVersionMock).toHaveBeenCalled(); // 질의 캐시는 합쳐서 올라간다
      expect(bumpNoteQueryVersionMock.mock.calls.length).toBeLessThanOrEqual(17); // 5초/300ms 창 — 쓰기마다가 아니다
      expect(reloadActiveMock).not.toHaveBeenCalled(); // 열린 노트 본문도 안 건드린다

      await vi.advanceTimersByTimeAsync(LIGHT_TREE_DEBOUNCE_MS - 500 + REMOTE_WRITE_COALESCE_MS); // 마지막 쓰기 뒤 3초 + 합치기 창
      expect(loadTreeMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(LIGHT_TREE_DEBOUNCE_MS * 3);
      expect(loadTreeMock).toHaveBeenCalledTimes(1); // 더 쓰지 않았으니 다시 안 읽는다
    });

    it("계속 쳐도 트리는 첫 쓰기 기준 최대 대기 안에 한 번은 갱신된다", async () => {
      await registered();
      // 1초마다 쓰는데 LIGHT_TREE_DEBOUNCE_MS(3초)는 영영 안 지나간다 — 최대 대기가 끊어 준다.
      await typing(LIGHT_TREE_MAX_WAIT_MS / 1000 - 1, 1000)();
      expect(loadTreeMock).not.toHaveBeenCalled();
      await typing(3, 1000)();
      expect(loadTreeMock).toHaveBeenCalledTimes(1);
    });

    it("light 와 일반(tree) 쓰기가 섞이면 일반 쓰기가 낸 창에서 트리를 읽는다(기다리지 않는다)", async () => {
      await registered();
      fire({ note_id: "n1", created: false, origin: "local", window: "section-s1" });
      fire({ note_id: "n2", created: false, origin: "local", window: "settings" });
      await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
      expect(loadTreeMock).toHaveBeenCalledTimes(1);
    });

    it("정리하면 미룬 트리 재조회도 취소된다", async () => {
      const cleanup = await registered();
      fire({ note_id: "n1", created: false, origin: "local", window: "section-s1" });
      cleanup();
      await vi.advanceTimersByTimeAsync(LIGHT_TREE_DEBOUNCE_MS * 2);
      expect(loadTreeMock).not.toHaveBeenCalled();
    });

    it("브라우저에선 섹션 분리 창 쓰기도 보통 쓰기처럼 합친 창 뒤에 트리를 읽는다(규칙 불변)", async () => {
      browserMode = true;
      await registered();
      fire({ note_id: "n1", created: false, origin: "local", window: "section-s1" });
      await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
      expect(loadTreeMock).toHaveBeenCalledTimes(1);
    });
  });

  it("drops the desktop's own echoes before they open a window", async () => {
    await registered();
    fire({ note_id: "n1", created: false, origin: "local", window: "main" });
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS * 2);
    expect(loadTreeMock).not.toHaveBeenCalled();
  });

  it("another window's write to the open note reloads it; an unattributed local write never does", async () => {
    activeNote = { note: { id: "n1" } };
    await registered();
    fire({ note_id: "n1", created: false, origin: "local", window: null });
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(reloadActiveMock).not.toHaveBeenCalled(); // coarse — note_id 를 모으지 않았다

    fire({ note_id: "n1", created: false, origin: "local", window: "settings" });
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    expect(loadTreeMock).toHaveBeenCalledTimes(2);
    expect(reloadActiveMock).toHaveBeenCalledTimes(1);
  });

  it("keeps applying desktop-originated writes on the browser path", async () => {
    browserMode = true;
    await registered();
    fire({ note_id: "n1", created: false, origin: "local" });
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
  });

  // 새로고침이 창보다 오래 걸려도(10만 노트 ≈1초) 두 번이 겹쳐 돌지 않는다 — 끝난 뒤 모인 것을 한 번 더.
  it("never overlaps reloads: writes arriving mid-reload get exactly one follow-up reload after it finishes", async () => {
    let finishFirst: () => void = () => {};
    loadTreeMock.mockImplementationOnce(() => new Promise<void>((r) => { finishFirst = r; }));
    await registered();
    fire({ note_id: "n1", created: false, origin: "remote" });
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    expect(loadTreeMock).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) fire({ note_id: `m${i}`, created: false, origin: "remote" });
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS * 3);
    expect(loadTreeMock).toHaveBeenCalledTimes(1); // 아직 첫 번째가 도는 중

    finishFirst();
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    expect(loadTreeMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS * 3);
    expect(loadTreeMock).toHaveBeenCalledTimes(2);
  });

  it("swallows a failed reload (already logged by callSilent) and keeps coalescing afterwards", async () => {
    loadTreeMock.mockImplementationOnce(() => Promise.reject(new Error("folder_list failed")));
    await registered();
    fire({ note_id: "n1", created: false, origin: "remote" });
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    fire({ note_id: "n2", created: false, origin: "remote" });
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    expect(loadTreeMock).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending window on cleanup", async () => {
    const cleanup = await registered();
    fire({ note_id: "n1", created: false, origin: "remote" });
    cleanup();
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS * 2);
    expect(loadTreeMock).not.toHaveBeenCalled();
  });

  // MobileApp 은 listenRemoteNoteWrite({ onFocusSkipped }) 로 등록한다 — opts 가 합친 반영까지 그대로 간다.
  it("forwards opts through to the coalesced apply (focus guard → onFocusSkipped)", async () => {
    activeNote = { note: { id: "n1" } };
    const onFocusSkipped = vi.fn();
    await registered({ onFocusSkipped });
    fire({ note_id: "n1", created: false, origin: "remote" });
    document.body.innerHTML = '<div contenteditable="true" tabindex="0" id="ed"></div>';
    document.getElementById("ed")!.focus(); // 판정은 flush 시점의 포커스로
    await vi.advanceTimersByTimeAsync(REMOTE_WRITE_COALESCE_MS);
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(reloadActiveMock).not.toHaveBeenCalled();
    expect(onFocusSkipped).toHaveBeenCalledWith("n1");
  });
});

describe("listenDataReplaced", () => {
  const reloadMock = vi.fn();
  const realLocation = window.location;
  beforeEach(() => {
    listenMock.mockReset();
    reloadMock.mockClear();
    browserMode = false;
    Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, reload: reloadMock } });
  });
  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  });

  it("reloads the whole window when the backend says the data was replaced", async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined;
    listenMock.mockImplementation((name: string, h: typeof handler) => {
      if (name === "data-replaced") handler = h;
      return Promise.resolve(vi.fn());
    });
    const cleanup = listenDataReplaced();
    await Promise.resolve();
    handler!({ payload: {} });
    expect(reloadMock).toHaveBeenCalledTimes(1);
    cleanup();
    handler!({ payload: {} }); // 해제 뒤엔 다시 불러오지 않는다(listenMany 의 cancelled 가드)
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op in the browser (the phone never gets this event over SSE)", () => {
    browserMode = true;
    listenDataReplaced()();
    expect(listenMock).not.toHaveBeenCalled();
  });
});
