import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const callMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => ({}));
vi.mock("../lib/invoke", async (orig) => ({
  ...(await orig<typeof import("../lib/invoke")>()),
  call: (cmd: string, args?: unknown) => callMock(cmd, args),
  callSilent: (cmd: string, args?: unknown) => callMock(cmd, args),
}));

import { EditorPanel } from "./EditorPanel";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useSectionWindowsStore } from "../stores/sectionWindows";
import { t } from "../i18n/t";
import type { NoteDetail } from "../lib/commands.gen";

// 회귀(2026-10-18): 데스크톱 빈 본문 안내문이 하드코딩된 영어 "Write something..." 였다 —
// 한국어 UI 에서도 영어로 떴다. 이제 editor.body_placeholder 를 UI 언어로 그린다.
describe("EditorPanel — empty-body placeholder follows the UI language", () => {
  const prevLang = useSettingsStore.getState().uiLang;

  beforeEach(() => {
    callMock.mockClear();
    useSectionWindowsStore.setState({ ids: [] });
  });
  afterEach(() => {
    useSettingsStore.setState({ uiLang: prevLang });
  });

  it("shows the Korean i18n placeholder on an empty text section", async () => {
    useSettingsStore.setState({ uiLang: "ko" });
    const note = {
      note: { id: "n1", title: "T", content_locked: false },
      sections: [{ id: "s1", name: "S", body_md: "", kind: "text", position: 0 }],
      attachments: [],
    } as unknown as NoteDetail;
    useNotesStore.setState({ activeNote: note, activeDraft: false, isBooting: false });

    const { container } = render(<EditorPanel />);
    const expected = t("editor.body_placeholder");
    expect(expected).toBe("내용을 적어보세요…");
    await waitFor(() => {
      const p = container.querySelector(".ProseMirror [data-placeholder]");
      expect(p?.getAttribute("data-placeholder")).toBe(expected);
    });
    expect(container.innerHTML).not.toContain("Write something");
  });
});
