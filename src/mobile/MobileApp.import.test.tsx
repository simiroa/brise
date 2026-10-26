/**
 * 다른 앱에서 "가져오기"로 온 내용 × MobileApp 의 입력 화면 출구.
 * 규칙(D1, 오너 2026-10-10 — 저장하기 버튼이 없어지며 바뀌었다. 예전 Q-S3 (b) 는 "저장하기를 눌러야 노트, 손대지 않고 뒤로 = 버림"):
 *  - 도착 → 초안이 채워지고 노트·업로드는 0 (ensureMaterialized 가 노트 생성의 유일한 입구다)
 *  - 입력 화면을 떠나면(뒤로·탭·하드웨어 뒤로) → 노트를 만들고 이미지를 올린 뒤 나간다, 실패하면 머문다
 *  - 가져오기 띠의 [버리기] → 아무것도 만들지 않고 버린다(입력 화면은 새 초안으로 남는다)
 *  - 이미 노트가 된 뒤 나가기 → 이미지를 올린다
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { forwardRef, useImperativeHandle } from "react";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

const hoisted = vi.hoisted(() => ({ emitNoticeMock: vi.fn() }));

const callMock = vi.fn(async (cmd: string) => {
  if (cmd === "settings_get_all") return { settings: { ui_lang: "en" } };
  if (cmd === "note_year_histogram") return { counts: [] };
  if (cmd === "workspace_list") return { workspaces: [], active_id: null };
  if (cmd === "search_notes") return { results: [], total: 0 };
  return {};
});
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(args[0] as string),
  callSilent: (...args: unknown[]) => callMock(args[0] as string),
  emitNotice: hoisted.emitNoticeMock,
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(() => () => {}),
}));

const reportFallbackMock = vi.fn();
vi.mock("../lib/diag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/diag")>()),
  reportFallback: (...a: unknown[]) => reportFallbackMock(...a),
}));
vi.mock("./MobileOfflineBanner", () => ({ MobileOfflineBanner: () => null }));
vi.mock("../lib/remoteNoteWrite", () => ({ listenRemoteNoteWrite: () => () => {} }));

const uploadAttachmentMock = vi.fn();
vi.mock("./mobileApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mobileApi")>()),
  uploadAttachment: (...a: unknown[]) => uploadAttachmentMock(...a),
}));

const flushAndMeasureMock = vi.fn(async () => 0);
const hasUnsavedFailureMock = vi.fn(() => false);
const showLeaveBlockedMock = vi.fn();
const markDraftUnsentMock = vi.fn();
const noteProps: Record<string, unknown>[] = [];
vi.mock("./MobileNote", () => ({
  MobileNote: forwardRef(function MobileNoteStub(
    props: { onBack: () => void },
    ref: React.Ref<{
      flushAndMeasure: () => Promise<number>;
      notifyRemoteChange: (noteId: string) => void;
      hasUnsavedFailure: () => boolean;
      showLeaveBlocked: (proceed: () => void) => void;
      markDraftUnsent: () => void;
    }>,
  ) {
    useImperativeHandle(ref, () => ({
      flushAndMeasure: flushAndMeasureMock,
      notifyRemoteChange: vi.fn(),
      hasUnsavedFailure: hasUnsavedFailureMock,
      showLeaveBlocked: showLeaveBlockedMock,
      markDraftUnsent: markDraftUnsentMock,
    }));
    noteProps.push(props as unknown as Record<string, unknown>);
    return (
      <div data-testid="mobile-note-stub">
        <button onClick={props.onBack}>back</button>
      </div>
    );
  }),
}));

import { useNotesStore } from "../stores/notes";
import { useWorkspacesStore } from "../stores/workspaces";
import { MobileApp } from "./MobileApp";
import { AttachmentTooLargeError } from "./mobileApi";
import { getLedgerEntry, resetLedgerForTest } from "./mobileImportLedger";

// ---- 가짜 셸 ------------------------------------------------------------------------------------------------
type Bridge = { postMessage: ReturnType<typeof vi.fn>; onmessage: ((e: { data: string }) => void) | null };
const w = window as unknown as { BriseNative?: Bridge };
let pendingImport: object | null = null;
const acked: string[] = [];

function installShell(): Bridge {
  const b: Bridge = {
    onmessage: null,
    postMessage: vi.fn((raw: string) => {
      const req = JSON.parse(raw) as { id: number; type: string; importId?: string };
      let body: object = { ok: false, error: "unknown_type" };
      if (req.type === "getPendingImport") body = { ok: true, import: pendingImport };
      if (req.type === "ackImport") {
        acked.push(String(req.importId));
        if ((pendingImport as { importId?: string } | null)?.importId === req.importId) pendingImport = null;
        body = { ok: true };
      }
      queueMicrotask(() => b.onmessage?.({ data: JSON.stringify({ id: req.id, ...body }) }));
    }),
  };
  w.BriseNative = b;
  return b;
}

// importId 는 테스트마다 새로 — 페이지 수명 동안의 중복 방지(useMobileImport 의 seen)가 파일 안에서 이어지기 때문이다.
let importSeq = 0;
let currentId = "";
const IMPORT = (over: object = {}) => ({
  importId: (currentId = `imp${++importSeq}`),
  text: "https://example.com/post/42",
  subject: "재미있는 기사",
  textError: false,
  omitted: 0,
  items: [{ idx: 0, name: "photo.jpg", mime: "image/jpeg", size: 1000 }],
  ...over,
});

// ---- 스토어 -------------------------------------------------------------------------------------------------
function draftDetail() {
  return {
    note: { id: "__draft__", title: "Untitled Note", year: 2026, folder_id: "", tag_names: [] },
    sections: [{ id: "draft_sec", name: "Overview", body_md: "", position: 0, kind: "text" }],
    sources: [],
    attachments: [],
  };
}
const newNoteMock = vi.fn();
const ensureMock = vi.fn();
function resetStore() {
  newNoteMock.mockReset().mockImplementation(async () => {
    useNotesStore.setState({ activeNote: draftDetail(), activeDraft: true, activeBodyEmpty: true } as never);
  });
  // ensureMaterialized 가 노트 생성의 유일한 입구다 — 불리지 않았다 = note_create 가 나가지 않았다.
  ensureMock.mockReset().mockImplementation(async () => {
    const n = useNotesStore.getState().activeNote as any;
    useNotesStore.setState({
      activeNote: { ...n, note: { ...n.note, id: "real1" }, sections: n.sections.map((s: any) => ({ ...s, id: "sec1" })) },
      activeDraft: false,
    } as never);
    return "real1";
  });
  useNotesStore.setState({ newNote: newNoteMock, ensureMaterialized: ensureMock, activeNote: null, activeDraft: false } as never);
}

const okUpload = async (_id: string, file: File) => ({ id: `att-${file.name}`, name: file.name, kind: "image" });

beforeEach(() => {
  callMock.mockClear();
  hoisted.emitNoticeMock.mockClear();
  reportFallbackMock.mockClear();
  uploadAttachmentMock.mockReset().mockImplementation(okUpload);
  flushAndMeasureMock.mockReset().mockResolvedValue(0);
  hasUnsavedFailureMock.mockReset().mockReturnValue(false);
  showLeaveBlockedMock.mockReset();
  markDraftUnsentMock.mockReset();
  noteProps.length = 0;
  acked.length = 0;
  resetLedgerForTest();
  pendingImport = IMPORT();
  useWorkspacesStore.setState({ workspaces: [], activeId: null, loaded: false } as never);
  resetStore();
  installShell();
  // 셸의 이미지 경로는 200 + blob, 그 밖(설정 화면의 ping 등)은 404.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).startsWith("/__shell/import/")
        ? { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }) }
        : { ok: false, status: 404, json: async () => ({}) },
    ),
  );
});
afterEach(() => {
  delete w.BriseNative;
  vi.unstubAllGlobals();
});

// 첫 테스트는 가져오기 본문 변환 모듈(Tiptap)을 처음 불러오느라 1초를 넘길 수 있다.
const SLOW = { timeout: 8000 };
// 입력 화면이 실제로 닫혔는지(홈으로 나갔는지) — 홈의 "나가는 중 유령"(220ms)이 남아 있어도 홈 요소는 이미 DOM 에 있으므로
// 스텁이 사라질 때까지 기다린다.
async function leftCapture() {
  await waitFor(() => expect(screen.queryByTestId("mobile-note-stub")).toBeNull(), SLOW);
  await screen.findByLabelText("Search notes, tags, sources…");
}

async function openImportedCapture() {
  render(<MobileApp />);
  await screen.findByTestId("mobile-note-stub", undefined, SLOW);
  await waitFor(() => expect(useNotesStore.getState().activeNote?.sections[0].body_md).not.toBe(""), SLOW);
}

describe("MobileApp — 가져오기 도착", () => {
  it("입력 화면이 열리고 초안에 제목·본문이 채워진다. 노트 생성·업로드·ack 는 아직 0", async () => {
    await openImportedCapture();
    const s = useNotesStore.getState();
    expect(s.activeDraft).toBe(true);
    expect(s.activeNote?.note.title).toBe("재미있는 기사");
    expect(s.activeNote?.sections[0].body_md).toContain("https://example.com/post/42");
    expect(ensureMock).not.toHaveBeenCalled();
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
    expect(acked).toEqual([]);
    expect(hoisted.emitNoticeMock).toHaveBeenCalledWith(expect.stringContaining("Imported content is now in Write"));
    // 아직 어디에도 안 붙은 사진을 화면이 알려 준다.
    expect(screen.getByText(/1 imported photo/)).toBeTruthy();
  });

  it("셸이 없으면(일반 브라우저) 아무 일도 없다", async () => {
    delete w.BriseNative;
    render(<MobileApp />);
    await screen.findByLabelText("Search notes, tags, sources…");
    expect(newNoteMock).not.toHaveBeenCalled();
  });

  it("같은 importId 는 한 번만 채운다(앞으로 돌아옴·알림이 겹쳐도 초안이 둘 생기지 않는다)", async () => {
    await openImportedCapture();
    await act(async () => {
      window.dispatchEvent(new Event("brise-import-ready"));
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(newNoteMock).toHaveBeenCalledTimes(1);
  });

  it("텍스트가 없고 상한을 넘은 이미지뿐이면 입력 화면을 열지 않고 알린 뒤 ack 한다", async () => {
    pendingImport = IMPORT({ text: "", subject: "", items: [{ idx: 0, name: "big.jpg", mime: "image/jpeg", size: 1, error: "too_large" }] });
    render(<MobileApp />);
    await waitFor(() => expect(acked).toEqual([currentId]));
    expect(newNoteMock).not.toHaveBeenCalled();
    expect(hoisted.emitNoticeMock).toHaveBeenCalledWith(expect.stringContaining("Nothing could be imported"));
  });

  it("일부만 가져오지 못했으면 몇 개인지 같은 알림에 담는다", async () => {
    pendingImport = IMPORT({ items: [{ idx: 0, name: "a.jpg", mime: "image/jpeg", size: 1 }, { idx: 1, name: "b.mp4", mime: "video/mp4", size: 1 }] });
    await openImportedCapture();
    expect(hoisted.emitNoticeMock).toHaveBeenCalledWith(expect.stringMatching(/1 could not be imported/));
  });
});

describe("MobileApp — 입력 화면 출구 (D1: 떠나면 노트)", () => {
  it("뒤로(손대지 않은 초안): 노트를 만들고(ensureMaterialized) 이미지를 올리고 ack 한 뒤 나간다", async () => {
    await openImportedCapture();
    fireEvent.click(screen.getByText("back"));

    await leftCapture();
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(uploadAttachmentMock).toHaveBeenCalledTimes(1);
    expect(uploadAttachmentMock.mock.calls[0][0]).toBe("real1");
    expect((uploadAttachmentMock.mock.calls[0][1] as File).name).toBe("photo.jpg");
    expect(acked).toEqual([currentId]);
    // 올라간 첨부가 활성 노트 화면 상태에 반영된다(useMobileAttachUpload 와 같은 낙관 반영)
    expect(useNotesStore.getState().activeNote?.attachments.map((a: any) => a.name)).toEqual(["photo.jpg"]);
  });

  it("탭으로 나가도 같다 — 노트를 만들고 나간다", async () => {
    await openImportedCapture();
    fireEvent.click(screen.getByLabelText("Settings"));
    await waitFor(() => expect(screen.queryByTestId("mobile-note-stub")).toBeNull(), SLOW);
    expect(ensureMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(acked).toEqual([currentId]));
  });

  it("하드웨어 뒤로도 같다 — 노트를 만들고 나간다", async () => {
    await openImportedCapture();
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 50));
    });
    await leftCapture();
    expect(ensureMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(acked).toEqual([currentId]));
  });

  it("긴 글(200자 이상)이면 노트가 된 뒤 '저장되었습니다' 안내가 뜬다(평소 입력과 같은 규칙)", async () => {
    flushAndMeasureMock.mockResolvedValue(500);
    await openImportedCapture();
    fireEvent.click(screen.getByText("back"));
    await screen.findByText("Your note has been saved.", undefined, SLOW);
    expect(ensureMock).toHaveBeenCalledTimes(1);
  });

  it("[버리기]: 노트도 업로드도 만들지 않고 버린다. 입력 화면은 새 초안으로 남는다", async () => {
    await openImportedCapture();
    fireEvent.click(screen.getByTestId("mobile-import-discard"));
    await waitFor(() => expect(acked).toEqual([currentId]));
    expect(ensureMock).not.toHaveBeenCalled();
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/imported photo/)).toBeNull();
    expect(screen.queryByTestId("mobile-import-discard")).toBeNull();
    // 비게 된 입력 화면은 새 빈 초안으로 다시 열린다(MobileApp 의 "열려 있던 노트가 사라짐" 효과)
    await waitFor(() => expect(newNoteMock).toHaveBeenCalledTimes(2), SLOW);
    expect(useNotesStore.getState().activeNote?.sections[0].body_md).toBe("");
    expect(screen.getByTestId("mobile-note-stub")).toBeTruthy();

    // 그 뒤 나가도 버린 내용은 노트가 되지 않는다
    fireEvent.click(screen.getByText("back"));
    await leftCapture();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("사진 없이 글만 가져와도 띠가 떠서 [버리기]가 닿는다", async () => {
    pendingImport = IMPORT({ items: [] });
    await openImportedCapture();
    expect(screen.getByText("Imported content · becomes a note when you leave")).toBeTruthy();
    expect(screen.getByTestId("mobile-import-discard")).toBeTruthy();
  });

  it("자동 저장이 이미 노트를 만들었으면 [버리기]는 사라진다(그때 버리기는 노트 삭제라 띠의 일이 아니다)", async () => {
    await openImportedCapture();
    expect(screen.getByTestId("mobile-import-discard")).toBeTruthy();
    await act(async () => {
      await useNotesStore.getState().ensureMaterialized();
    });
    expect(screen.queryByTestId("mobile-import-discard")).toBeNull();
    expect(screen.getByText(/1 imported photo/)).toBeTruthy(); // 사진 줄은 남는다
  });

  it("나가며 노트 만들기가 실패하면 화면에 머물고 내용·이미지는 그대로다", async () => {
    ensureMock.mockRejectedValueOnce(new Error("offline"));
    await openImportedCapture();
    fireEvent.click(screen.getByText("back"));
    await waitFor(() => expect(hoisted.emitNoticeMock).toHaveBeenCalledWith(expect.stringContaining("Could not save")));
    expect(screen.getByTestId("mobile-note-stub")).toBeTruthy();
    expect(useNotesStore.getState().activeNote?.sections[0].body_md).toContain("https://example.com");
    expect(screen.getByText(/1 imported photo/)).toBeTruthy();
    expect(acked).toEqual([]);
    // 에디터가 이 실패를 알게 한다 — 안 그러면 flush 가 "이미 같음" 으로 건너뛰어 다음 나가기가 V5 관문 밖이 된다
    expect(markDraftUnsentMock).toHaveBeenCalledTimes(1);

    // 다시 나가면 이번엔 만들어지고 이미지가 올라간다
    fireEvent.click(screen.getByText("back"));
    await leftCapture();
    expect(ensureMock).toHaveBeenCalledTimes(2);
    expect(uploadAttachmentMock).toHaveBeenCalledTimes(1);
  });

  it("하드웨어 뒤로 중 노트 만들기가 실패하면 이미 pop 된 항목을 다시 쌓고 화면에 머문다", async () => {
    ensureMock.mockRejectedValueOnce(new Error("offline"));
    await openImportedCapture();
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(markDraftUnsentMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("mobile-note-stub")).toBeTruthy();
    expect((history.state as { screen?: string } | null)?.screen).toBe("capture");
    expect(acked).toEqual([]);
  });

  it("하드웨어 뒤로가 오프라인에서 막힌 뒤 [그래도 나가기]: 다시 노트를 만들려 들지 않고 버리고 나간다(영영 못 나가는 고리 없음)", async () => {
    ensureMock.mockReset().mockRejectedValue(new Error("offline")); // 계속 오프라인
    markDraftUnsentMock.mockImplementation(() => hasUnsavedFailureMock.mockReturnValue(true));
    await openImportedCapture();
    await act(async () => {
      window.history.back(); // 첫 하드웨어 뒤로 — 노트 만들기 실패 → 머문다, 초안을 "못 보낸 글"로 표시
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(markDraftUnsentMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.history.back(); // 두 번째 — 이제 V5 관문이 막는다
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(showLeaveBlockedMock).toHaveBeenCalledTimes(1));
    const attempts = ensureMock.mock.calls.length;

    hasUnsavedFailureMock.mockReturnValue(false); // [그래도 나가기]가 보관을 마치고 표시를 푼 뒤
    await act(async () => {
      showLeaveBlockedMock.mock.calls[0][0]();
      await new Promise((r) => setTimeout(r, 50));
    });
    await leftCapture();
    expect(ensureMock).toHaveBeenCalledTimes(attempts); // 다시 시도하지 않았다
    expect(useNotesStore.getState().activeNote).toBeNull();
    await waitFor(() => expect(acked).toEqual([currentId]));
  });

  it("나가기 실패 → 다시 뒤로: 표시된 실패가 나가기 관문(V5)에 걸려 초안·이미지가 경고 없이 버려지지 않는다. [그래도 나가기] 뒤에야 버린다", async () => {
    // 진짜 MobileNote 는 markDraftUnsent 뒤 다음 flush 가 노트 만들기를 다시 시도하다 실패해 hasUnsavedFailure 가 true 가 된다
    // (MobileNote.draftLeave.realEditor.test.tsx 가 그 절반을 확인한다) — 이 스텁은 그 결과를 흉내 내고, 여기선 MobileApp 쪽 순서를 못 박는다.
    markDraftUnsentMock.mockImplementation(() => hasUnsavedFailureMock.mockReturnValue(true));
    ensureMock.mockRejectedValueOnce(new Error("offline"));
    await openImportedCapture();
    fireEvent.click(screen.getByText("back"));
    await waitFor(() => expect(markDraftUnsentMock).toHaveBeenCalledTimes(1));
    expect(showLeaveBlockedMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("back"));
    await waitFor(() => expect(showLeaveBlockedMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("mobile-note-stub")).toBeTruthy(); // 막혔다 — 화면에 머문다
    expect(useNotesStore.getState().activeDraft).toBe(true);
    expect(useNotesStore.getState().activeNote?.sections[0].body_md).toContain("https://example.com");
    expect(acked).toEqual([]); // 셸의 임시 파일도 그대로
    expect(uploadAttachmentMock).not.toHaveBeenCalled();

    hasUnsavedFailureMock.mockReturnValue(false); // [그래도 나가기]가 보관을 마치고 표시를 푼 뒤
    await act(async () => {
      showLeaveBlockedMock.mock.calls[0][0]();
    });
    await leftCapture();
    expect(ensureMock).toHaveBeenCalledTimes(1); // [그래도 나가기]는 저장하겠다는 뜻이 아니다
    expect(useNotesStore.getState().activeNote).toBeNull();
    await waitFor(() => expect(acked).toEqual([currentId]));
  });

  it("O-2: 나가며 사진 업로드가 실패해도 바로 나간다. ack 는 미루고, 다시 온 같은 배치는 새 노트가 아니라 그 노트에 이어 올린다", async () => {
    pendingImport = IMPORT({ items: [0, 1].map((i) => ({ idx: i, name: `p${i}.jpg`, mime: "image/jpeg", size: 1 })) });
    let failP1 = true;
    uploadAttachmentMock.mockImplementation(async (id: string, file: File) => {
      if (file.name === "p1.jpg" && failP1) throw new Error("HTTP 500");
      return okUpload(id, file);
    });
    await openImportedCapture();
    fireEvent.click(screen.getByText("back"));
    await leftCapture(); // 업로드를 기다리지 않고 나갔다
    await waitFor(() => expect(hoisted.emitNoticeMock).toHaveBeenCalledWith(expect.stringContaining("haven't uploaded")));
    expect(acked).toEqual([]); // 못 올린 사진이 있으니 ack 안 한다
    expect(getLedgerEntry(currentId)).toMatchObject({ noteId: "real1", files: [expect.objectContaining({ idx: 1 })] });
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(newNoteMock).toHaveBeenCalledTimes(1);

    // 앞으로 돌아옴 — 셸은 ack 전이라 같은 배치를 다시 준다. 새 입력 화면(=중복 노트)이 아니라 실패분만 이어 올린다.
    failP1 = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(acked).toEqual([currentId]));
    expect(newNoteMock).toHaveBeenCalledTimes(1);
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("mobile-note-stub")).toBeNull();
    expect(uploadAttachmentMock.mock.calls.map((c) => [c[0], (c[1] as File).name])).toEqual([["real1", "p0.jpg"], ["real1", "p1.jpg"], ["real1", "p1.jpg"]]);
    expect(getLedgerEntry(currentId)).toBeUndefined();
  });

  it("사용자가 글을 쳐서 이미 노트가 된 뒤 뒤로 나가면 이미지를 그 노트에 올린다", async () => {
    await openImportedCapture();
    await act(async () => {
      await useNotesStore.getState().ensureMaterialized(); // 자동 저장이 노트를 만든 것과 같다
    });
    ensureMock.mockClear();
    fireEvent.click(screen.getByText("back"));
    await leftCapture();
    await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledTimes(1));
    expect(uploadAttachmentMock.mock.calls[0][0]).toBe("real1");
    expect(ensureMock).not.toHaveBeenCalled(); // 다시 만들지 않는다
    await waitFor(() => expect(acked).toEqual([currentId]));
  });

  it("사진 빼기(×)를 누르면 이미지는 올리지 않고 텍스트 초안은 나갈 때 노트가 된다", async () => {
    await openImportedCapture();
    fireEvent.click(screen.getByLabelText("Remove imported photos"));
    expect(screen.queryByText(/imported photo/)).toBeNull();
    fireEvent.click(screen.getByText("back"));
    await leftCapture();
    expect(ensureMock).toHaveBeenCalledTimes(1); // 텍스트는 저장된다
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
  });

  it("[그래도 나가기] 뒤에는 저장하겠다는 뜻이 아니므로 노트를 만들지 않고 버린다", async () => {
    await openImportedCapture();
    hasUnsavedFailureMock.mockReturnValue(true); // 에디터 쪽 저장 실패가 남아 있다
    fireEvent.click(screen.getByText("back"));
    await waitFor(() => expect(showLeaveBlockedMock).toHaveBeenCalledTimes(1));
    expect(ensureMock).not.toHaveBeenCalled();
    hasUnsavedFailureMock.mockReturnValue(false);
    await act(async () => {
      showLeaveBlockedMock.mock.calls[0][0](); // 사용자가 그래도 나가기를 골랐다
    });
    await leftCapture();
    expect(ensureMock).not.toHaveBeenCalled();
  });
});

describe("MobileApp — 저장 실패 관문에 막힌 가져오기", () => {
  it("입력 화면에 저장 못 한 글이 있으면 가져오기를 채우지 않고 ack 도 안 한다. [그래도 나가기] 뒤에 채운다", async () => {
    // 이미 입력 화면에 있고, 에디터에 저장 실패한 글이 있다
    pendingImport = null;
    render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText("Write"));
    await screen.findByTestId("mobile-note-stub");
    hasUnsavedFailureMock.mockReturnValue(true);

    pendingImport = IMPORT();
    await act(async () => {
      window.dispatchEvent(new Event("brise-import-ready"));
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(showLeaveBlockedMock).toHaveBeenCalledTimes(1));
    expect(acked).toEqual([]);
    expect(useNotesStore.getState().activeNote?.sections[0].body_md).toBe(""); // 기존 초안을 건드리지 않았다
    expect(hoisted.emitNoticeMock).not.toHaveBeenCalledWith(expect.stringContaining("Imported content"));

    hasUnsavedFailureMock.mockReturnValue(false);
    await act(async () => {
      showLeaveBlockedMock.mock.calls[0][0]();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(useNotesStore.getState().activeNote?.sections[0].body_md).toContain("https://example.com"));
  });
});

describe("MobileApp — 이미 열려 있는 입력 화면 위로 가져오기", () => {
  it("입력 화면에 있던 중이면 새 초안으로 다시 마운트한다(채워진 초안이 화면에 칠해진다)", async () => {
    pendingImport = null;
    render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText("Write"));
    await screen.findByTestId("mobile-note-stub");

    pendingImport = IMPORT();
    await act(async () => {
      window.dispatchEvent(new Event("brise-import-ready"));
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(useNotesStore.getState().activeNote?.sections[0].body_md).toContain("https://example.com"));
    expect(newNoteMock).toHaveBeenCalledTimes(2); // 처음 입력 진입 + 가져오기
    expect(screen.getByTestId("mobile-note-stub")).toBeTruthy();
  });
});

describe("MobileApp — 자동 포커스 없음·백그라운드 업로드 중 재당김", () => {
  it("입력 화면은 어느 진입에서도 자동 포커스를 요청하지 않는다(D2 — 본문 탭이 포커스한다)", async () => {
    await openImportedCapture();
    fireEvent.click(screen.getByText("back"));
    await leftCapture();
    pendingImport = null;
    fireEvent.click(screen.getByLabelText("Write")); // 평소의 입력 진입
    await screen.findByTestId("mobile-note-stub");
    expect(noteProps.length).toBeGreaterThan(0);
    expect(noteProps.every((p) => !("autoFocus" in p) && !("onSave" in p))).toBe(true);
  });

  it("백그라운드로 이미지를 올리는 동안 같은 배치를 다시 당겨 와도 셸 파일을 지우지(ack) 않는다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    uploadAttachmentMock.mockImplementation(async (id: string, file: File) => {
      await gate;
      return okUpload(id, file);
    });
    await openImportedCapture();
    await act(async () => {
      await useNotesStore.getState().ensureMaterialized(); // 이미 노트가 된 뒤
    });
    fireEvent.click(screen.getByText("back")); // 백그라운드 업로드 시작(게이트에서 대기)
    await leftCapture();
    await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange")); // 앞으로 돌아옴 — 셸은 아직 ack 전이라 같은 배치를 준다
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(acked).toEqual([]);

    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(acked).toEqual([currentId]));
  });
});

describe("AttachmentTooLargeError", () => {
  it("25MB 초과는 다시 시도하지 않고 건너뛴다고 알린다(저장은 막지 않는다)", async () => {
    uploadAttachmentMock.mockImplementation(async () => {
      throw new AttachmentTooLargeError("file too large");
    });
    await openImportedCapture();
    fireEvent.click(screen.getByText("back"));
    await leftCapture();
    expect(hoisted.emitNoticeMock).toHaveBeenCalledWith(expect.stringContaining("were skipped"));
    expect(acked).toEqual([currentId]);
  });
});
