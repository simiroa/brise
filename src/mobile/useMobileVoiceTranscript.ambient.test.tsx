import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../lib/commands.gen";
import { useNotesStore } from "../stores/notes";
import { useMobileAmbientStore } from "../stores/mobileAmbient";
import { useMobileVoiceTranscript } from "./useMobileVoiceTranscript";

/**
 * 음성 받아쓰기의 `audio_transcribe` 는 runAiAction 밖이라 AI 글로우 키도 결과 게이트 세션도 없다.
 * 녹음이 끝나 글로우가 사라진 직후 빛줄기가 켜지기 전 화면이 깜깜해지는 틈이 바로 이 호출 — 그래서
 * 호출 구간을 배경 신호 스토어(aiWork)로 센다. 성공이든 실패든 반드시 내려가야 한다.
 */
let transcribe: { resolve: (v: { text: string }) => void; reject: (e: unknown) => void };
const callSilentMock = vi.fn((cmd: string) => {
  if (cmd === "audio_transcribe") {
    return new Promise<{ text: string }>((resolve, reject) => { transcribe = { resolve, reject }; });
  }
  return Promise.resolve({});
});
vi.mock("../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/invoke")>()),
  callSilent: (...a: unknown[]) => callSilentMock(a[0] as string),
}));

const att = { id: "a1", name: "voice.weba", mime: "audio/webm" } as unknown as Attachment;
const aiWork = () => useMobileAmbientStore.getState().aiWork;

function mountHook() {
  const ed = {
    editor: null,
    sectionRef: { current: null },
    readOnlyRef: { current: false },
    flushRef: { current: async () => {} },
  };
  return renderHook(() =>
    useMobileVoiceTranscript({
      ed: ed as never,
      bodyUnsavedRef: { current: false },
      insertSection: vi.fn().mockResolvedValue(undefined) as never,
      addChip: vi.fn(),
    }),
  );
}

beforeEach(() => {
  callSilentMock.mockClear();
  useMobileAmbientStore.setState({ rec: "off", aiWork: 0 });
  useNotesStore.setState({
    activeNote: { note: { id: "n1" }, sections: [], attachments: [att] } as never,
  });
});
afterEach(() => {
  useNotesStore.setState({ activeNote: null } as never);
});

describe("useMobileVoiceTranscript → ambient aiWork", () => {
  it("counts the transcription while it runs and releases when it succeeds", async () => {
    const { result } = mountHook();
    act(() => result.current.voiceRow.onTranscribe(att));
    expect(aiWork()).toBe(1);
    await act(async () => { transcribe.resolve({ text: "hello" }); });
    expect(aiWork()).toBe(0);
  });

  it("releases when the transcription fails (never stuck on)", async () => {
    const { result } = mountHook();
    act(() => result.current.voiceRow.onTranscribe(att));
    expect(aiWork()).toBe(1);
    await act(async () => { transcribe.reject(new Error("transcribe_failed")); });
    expect(aiWork()).toBe(0);
  });

  it("a second tap while one runs does not double-count (the in-flight guard returns before counting)", async () => {
    const { result } = mountHook();
    act(() => result.current.voiceRow.onTranscribe(att));
    act(() => result.current.voiceRow.onTranscribe(att));
    expect(aiWork()).toBe(1);
    await act(async () => { transcribe.resolve({ text: "x" }); });
    expect(aiWork()).toBe(0);
  });
});
