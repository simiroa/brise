import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { createMobileSchemaExtensions } from "./mobileEditorExtensions";
import { useNotesStore } from "../stores/notes";
import { reportFallback } from "../lib/diag";
import { useMobileCapturePreset } from "./useMobileCapturePreset";
import type { MobileBodyEditor } from "./useMobileBodyEditor";

vi.mock("../lib/invoke", () => ({
  call: vi.fn(),
  callSilent: vi.fn(async () => ({})),
  emitNotice: vi.fn(),
  flushAll: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
}));
vi.mock("../lib/diag", () => ({ reportFallback: vi.fn() }));

/**
 * 프리셋을 칠하는 **유일한 길목**(applyCapturePreset) — 프리셋 줄·더보기 시트·사용자 프리셋·AI 시작이 전부 지난다.
 * 칠한 글 위에 프리셋을 덮으면 되돌릴 길이 없다(초안은 서버 사본이 없고 폰엔 실행 취소가 없다). 줄이 안 그려지게 하는 것
 * (MobileDockSlot)과 별개로, 늦게 도착하는 경로(AI 생성이 몇 초 걸린다 · 낡은 시트)를 여기서 막는다. 진짜 Tiptap 으로 본다.
 */
let editor: Editor;
let applyPreset: ReturnType<typeof vi.fn>;
let showPresetBody: ReturnType<typeof vi.fn>;

function mountHook() {
  const ed = {
    editor,
    sectionRef: { current: { id: "s1", body: "", kind: "text" } },
    showPresetBody,
  } as unknown as MobileBodyEditor;
  return renderHook(() => useMobileCapturePreset(ed));
}

beforeEach(() => {
  editor = new Editor({ extensions: createMobileSchemaExtensions(), content: "" });
  applyPreset = vi.fn(async () => "s1");
  showPresetBody = vi.fn();
  useNotesStore.setState({
    applyPreset,
    activeNote: { note: { id: "n1" }, sections: [{ id: "s1", name: "Overview", body_md: "", position: 0, kind: "text" }] },
  } as never);
  vi.mocked(reportFallback).mockClear();
});
afterEach(() => {
  editor.destroy();
});

describe("useMobileCapturePreset::applyCapturePreset — the one choke point", () => {
  it("an empty editor: the preset is applied and painted, and the latch flips", async () => {
    const { result } = mountHook();
    expect(result.current.presetApplied).toBe(false);
    await act(async () => {
      await result.current.applyCapturePreset({ title: null, bodyMd: "## Today" });
    });
    expect(applyPreset).toHaveBeenCalledWith("## Today", null);
    expect(showPresetBody).toHaveBeenCalledWith("s1", "## Today");
    expect(result.current.presetApplied).toBe(true);
    expect(reportFallback).not.toHaveBeenCalled();
  });

  it("text typed into the live editor: the preset is NOT applied — no store write, no repaint, latch untouched, the skip is recorded", async () => {
    const { result } = mountHook();
    act(() => {
      editor.commands.insertContentAt(1, "MY TYPED SENTENCE"); // 디바운스 전 — 스토어는 아직 이 글을 모른다
    });
    await act(async () => {
      await result.current.applyCapturePreset({ title: null, bodyMd: "## Today" });
    });
    expect(applyPreset).not.toHaveBeenCalled();
    expect(showPresetBody).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("MY TYPED SENTENCE");
    expect(result.current.presetApplied).toBe(false); // 줄이 다시 눌릴 수 있게 래치를 세우지 않는다
    expect(reportFallback).toHaveBeenCalledWith("mobile-capture-preset", "skipped_body_not_empty");
  });

  it("an image-only body counts as content too (an atom is not empty)", async () => {
    const { result } = mountHook();
    act(() => {
      editor.commands.insertContentAt(0, { type: "image", attrs: { src: "a.png" } });
    });
    expect(editor.isEmpty).toBe(false);
    await act(async () => {
      await result.current.applyCapturePreset({ title: null, bodyMd: "## Today" });
    });
    expect(applyPreset).not.toHaveBeenCalled();
  });

  it("deleting the typed text re-opens the choke point", async () => {
    const { result } = mountHook();
    act(() => {
      editor.commands.insertContentAt(1, "oops");
      editor.commands.clearContent(true);
    });
    await act(async () => {
      await result.current.applyCapturePreset({ title: null, bodyMd: "## Today" });
    });
    expect(applyPreset).toHaveBeenCalledTimes(1);
  });

  it("an editor that is already destroyed does not block the store action (nothing to overwrite on screen)", async () => {
    const { result } = mountHook();
    editor.destroy();
    await act(async () => {
      await result.current.applyCapturePreset({ title: null, bodyMd: "## Today" });
    });
    expect(applyPreset).toHaveBeenCalledTimes(1);
  });
});
