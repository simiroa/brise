import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { Attachment } from "../../lib/commands.gen";
import { DocPreview } from "./DocPreview";
import { ATTACHMENT_IMAGE_EXTS, RAW_IMAGE_EXTS } from "../../lib/fileKinds";

const callMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
}));

const convert = (p: string) => `asset://${p}`;

/** 노트 스토어의 사료 목록 — pptx 폴백이 여기서 본문을 찾는다. */
let sources: { id: string; name: string; ext: string; body: string; position: number }[] = [];
vi.mock("../../stores/notes", () => ({
  useNotesStore: (sel: (s: unknown) => unknown) => sel({ activeNote: { sources } }),
}));

function doc(name: string): Attachment {
  return {
    id: `a-${name}`,
    name,
    kind: "doc",
    rel_path: `n1/${name}`,
    url: null,
    size_bytes: 100,
    position: 0,
  };
}

function renderDoc(name: string) {
  return render(
    <DocPreview att={doc(name)} baseDir="/base" convert={convert} theme="dark" />
  );
}

/**
 * 오너 결정(GRILL-2026-09-07 D9): 로컬 html 첨부는 샌드박스 iframe 으로 본다 — 스타일 보고서를
 * 앱 안에서 보되 **스크립트는 막는다**.
 *
 * 이 파일이 고정하는 것은 "html 이 렌더된다"가 아니라 **sandbox 가 실제로 걸려 있고 스크립트를
 * 허용하지 않는다**는 계약이다. 나중에 누가 "차트가 안 보인다"는 이유로 sandbox 를 지우거나
 * allow-scripts 를 넣으면 여기서 걸린다 — 그건 되돌릴 수 없는 결정이 아니라 오너가 알고
 * 내려야 하는 결정이기 때문이다(완화하면 로컬 문서도 원격 리소스를 스스로 불러올 수 있다).
 */
describe("DocPreview — html 첨부", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({ text: "" });
  });

  it("html 은 iframe 으로 렌더되고 sandbox 가 걸려 있으며 스크립트를 허용하지 않는다", () => {
    const { container } = renderDoc("report.html");
    const frame = container.querySelector("iframe");
    expect(frame).toBeTruthy();
    expect(frame!.getAttribute("src")).toBe("asset:///base/n1/report.html");

    const sandbox = frame!.getAttribute("sandbox");
    expect(sandbox).not.toBeNull();
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("htm 확장자도 같은 갈래를 탄다", () => {
    const { container } = renderDoc("report.htm");
    const frame = container.querySelector("iframe");
    expect(frame).toBeTruthy();
    expect(frame!.getAttribute("sandbox")).not.toBeNull();
  });

  it("스크립트가 막히므로 탈출구(외부에서 열기)가 반드시 도달 가능하다", () => {
    const { container } = renderDoc("report.html");
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(0);
    buttons[0].click();
    expect(callMock).toHaveBeenCalledWith("attachment_open", { id: "a-report.html" });
  });

  it("pdf 는 기존대로 sandbox 없이 렌더된다 — 회귀 고정", () => {
    const { container } = renderDoc("paper.pdf");
    const frame = container.querySelector("iframe");
    expect(frame).toBeTruthy();
    expect(frame!.getAttribute("sandbox")).toBeNull();
  });

  it("알 수 없는 확장자는 iframe 을 만들지 않는다", () => {
    const { container } = renderDoc("archive.zip");
    expect(container.querySelector("iframe")).toBeNull();
  });
});

/**
 * pptx: 변환기가 있으면 **기존 pdf iframe 그대로** 보이고, 없으면 조용히 폴백한다.
 * 이 파일이 고정하는 계약은 "변환 실패가 정상 경로"라는 것 — 토스트를 부르는 call() 이 아니라
 * callSilent 로 나가고, 사유가 무엇이든 화면이 죽지 않는다.
 */
describe("DocPreview — pptx 슬라이드", () => {
  beforeEach(() => {
    callMock.mockReset();
    sources = [];
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("변환에 성공하면 pdf 분기를 그대로 탄다(두 번째 렌더 구현 없음)", async () => {
    callMock.mockResolvedValue({ pdf_path: "C:/data/slide_previews/a.pdf", reason: null });
    const { container } = renderDoc("deck.pptx");
    await flush();
    const frame = container.querySelector("iframe");
    expect(frame).toBeTruthy();
    expect(frame!.getAttribute("src")).toBe("asset://C:/data/slide_previews/a.pdf");
    expect(frame!.getAttribute("sandbox")).toBeNull();
    expect(callMock).toHaveBeenCalledWith("slide_preview_render", { attachment_id: "a-deck.pptx" });
  });

  it("변환기가 없으면 사료 본문으로 폴백하고 이유를 한 줄 남긴다", async () => {
    callMock.mockResolvedValue({ pdf_path: null, reason: "no_converter" });
    sources = [{ id: "s1", name: "deck.pptx", ext: "PPTX", body: "슬라이드 본문", position: 0 }];
    const { container } = renderDoc("deck.pptx");
    await flush();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("슬라이드 본문");
    expect(container.textContent).toContain("LibreOffice");
  });

  it("사료가 없으면 기존 '외부에서 열기' 카드로 떨어진다", async () => {
    callMock.mockResolvedValue({ pdf_path: null, reason: "failed" });
    const { container } = renderDoc("deck.pptx");
    await flush();
    expect(container.querySelector("iframe")).toBeNull();
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(0);
    buttons[0].click();
    expect(callMock).toHaveBeenCalledWith("attachment_open", { id: "a-deck.pptx" });
  });

  it("커맨드가 거부해도 화면이 죽지 않는다 — 폴백은 정상 경로다", async () => {
    callMock.mockRejectedValue(new Error("nope"));
    const { container } = renderDoc("deck.pptx");
    await flush();
    expect(container.textContent).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });
});

describe("RAW 원본", () => {
  it("사진 아이콘으로 물러난다 — 일반 파일 아이콘이 아니다", () => {
    const { container } = renderDoc("shot.cr2");
    expect(container.querySelector(".lucide-image")).toBeTruthy();
    expect(container.querySelector(".lucide-file")).toBeNull();
    // 그릴 수 있다고 거짓말하지 않는다 — <img> 는 없다(웹뷰가 RAW 를 디코드 못 한다).
    expect(container.querySelector("img")).toBeNull();
  });

  it("RAW 가 아닌 미지원 확장자는 일반 파일 아이콘 그대로", () => {
    const { container } = renderDoc("archive.zip");
    expect(container.querySelector(".lucide-file")).toBeTruthy();
    expect(container.querySelector(".lucide-image")).toBeNull();
  });

  it("RAW 는 이미지 kind 목록에 없다 — 있으면 앱이 그릴 수 있다고 거짓말한다", () => {
    for (const ext of ["cr2", "nef", "arw", "dng"]) {
      expect(ATTACHMENT_IMAGE_EXTS.has(ext)).toBe(false);
      expect(RAW_IMAGE_EXTS.has(ext)).toBe(true);
    }
  });
});
