import { beforeEach, describe, expect, it, vi } from "vitest";

const emitMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({ emit: (...a: unknown[]) => emitMock(...a) }));
const reportFallbackMock = vi.fn();
vi.mock("../../lib/diag", () => ({ reportFallback: (...a: unknown[]) => reportFallbackMock(...a) }));

import {
  emitSuggestionAccept,
  emitSuggestionDismiss,
  emitSuggestionsRefresh,
  suggestionAcceptEvent,
} from "./petSuggestionActions";
import { PET_EVENT } from "./bridge/petEvents";
import type { PendingSuggestion } from "./bridge/petSuggestionCards";

const overlap: PendingSuggestion = { kind: "overlap", id: "s1", noteId: "n1", noteTitle: "A", relatedNoteId: "n2", relatedNoteTitle: "B" };
const link: PendingSuggestion = {
  kind: "link", id: "s2", title: "T", summary: "S", url: "https://x.test", targetNoteId: "n3", targetNoteTitle: "C",
};
const theme: PendingSuggestion = { kind: "theme", id: "s3", noteTitle: "A", othersCount: 2, noteIds: ["n1", "n2", "n3"] };
const collect: PendingSuggestion = { kind: "collect", id: "s4", noteId: "n4", noteTitle: "A", sourceName: "RSS", postProcessModel: "m" };

describe("petSuggestionActions — 제안 종류 → PET_EVENT + snake_case 페이로드", () => {
  beforeEach(() => {
    emitMock.mockReset().mockResolvedValue(undefined);
    reportFallbackMock.mockClear();
  });

  it("네 종류 모두 PET_EVENT 맵의 이름과 받는 브리지가 읽는 페이로드로 간다", () => {
    expect(suggestionAcceptEvent(overlap)).toEqual({
      name: PET_EVENT.reviewSuggestion,
      payload: { id: "s1", note_id: "n1", related_note_id: "n2" },
    });
    expect(suggestionAcceptEvent(link)).toEqual({
      name: PET_EVENT.acceptLinkSuggestion,
      payload: { id: "s2", target_note_id: "n3", title: "T", summary: "S", url: "https://x.test" },
    });
    expect(suggestionAcceptEvent(theme)).toEqual({
      name: PET_EVENT.acceptThemeSuggestion,
      payload: { id: "s3", note_ids: ["n1", "n2", "n3"] },
    });
    expect(suggestionAcceptEvent(collect)).toEqual({
      name: PET_EVENT.acceptCollectSuggestion,
      payload: { id: "s4", note_id: "n4", model: "m" },
    });
  });

  it("수락·무시·새로고침이 실제 emit 으로 나간다", async () => {
    expect(await emitSuggestionAccept(link)).toBe(true);
    expect(emitMock).toHaveBeenLastCalledWith("pet-accept-link-suggestion", expect.objectContaining({ id: "s2" }));
    expect(await emitSuggestionDismiss("s9")).toBe(true);
    expect(emitMock).toHaveBeenLastCalledWith("pet-suggestion-dismiss", { id: "s9" });
    expect(await emitSuggestionsRefresh()).toBe(true);
    expect(emitMock).toHaveBeenLastCalledWith("pet-suggestions-refresh", undefined);
  });

  it("emit 이 실패하면 삼키지 않고 진단에 남기고 false 를 돌려준다(호출자가 카드를 되돌릴 수 있게)", async () => {
    emitMock.mockRejectedValueOnce(new Error("ipc down"));
    expect(await emitSuggestionAccept(collect)).toBe(false);
    expect(reportFallbackMock).toHaveBeenCalledWith("pet", "suggestion_emit_failed", expect.stringContaining("pet-accept-collect-suggestion"));
  });
});
