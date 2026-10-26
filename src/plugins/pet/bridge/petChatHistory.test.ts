import { describe, it, expect, beforeEach } from "vitest";
import {
  applyHistory,
  rememberChatExtras,
  resetChatExtrasCache,
  visibleChatText,
  type ChatHistoryItem,
} from "./petChatHistory";
import type { PetMessage } from "../../../lib/commands.gen";

const hits = [{ note_id: "n1", title: "Alpha", snippet: "snippet" }];

function msg(role: "user" | "assistant", text: string, created_at: string): PetMessage {
  return { role, text, created_at };
}

function extra(
  role: "user" | "assistant",
  text: string,
  createdAt: string,
  rest: Partial<ChatHistoryItem> = {},
): ChatHistoryItem {
  return { role, text, createdAt, ...rest };
}

describe("applyHistory", () => {
  beforeEach(() => {
    resetChatExtrasCache();
  });

  it("keeps search hits and plan chips when history timestamps differ", () => {
    const extras: ChatHistoryItem[] = [
      extra("user", "찾아줘", "client-u"),
      extra("assistant", "찾았어요", "client-a", {
        hits,
        planKind: "prune_plan",
        planId: "p1",
        visionStatus: "fallback_text",
        imagePreview: "blob:preview",
        attaches: [{ name: "shot.png", kind: "image", previewUrl: "blob:preview" }],
      }),
    ];
    const messages = [
      msg("user", "찾아줘", "server-u"),
      msg("assistant", "찾았어요", "server-a"),
    ];
    const out = applyHistory(messages, extras);
    expect(out).toHaveLength(2);
    expect(out[0].createdAt).toBe("server-u");
    expect(out[0].persisted).toBe(true);
    expect(out[1].hits).toEqual(hits);
    expect(out[1].planKind).toBe("prune_plan");
    expect(out[1].planId).toBe("p1");
    expect(out[1].visionStatus).toBe("fallback_text");
    expect(out[1].imagePreview).toBe("blob:preview");
    expect(out[1].attaches?.[0]?.name).toBe("shot.png");
    expect(out[1].createdAt).toBe("server-a");
  });

  it("prefers createdAt over end-alignment", () => {
    const extras: ChatHistoryItem[] = [
      extra("assistant", "old", "t-old", { hits: [{ note_id: "old", title: "Old", snippet: "o" }] }),
      extra("assistant", "new", "t-new", { hits }),
    ];
    const messages = [
      msg("assistant", "old", "t-old"),
      msg("assistant", "new", "t-new"),
    ];
    const out = applyHistory(messages, extras);
    expect(out[0].hits?.[0]?.note_id).toBe("old");
    expect(out[1].hits).toEqual(hits);
  });

  it("does not steal older extras when history grows with new text", () => {
    const extras: ChatHistoryItem[] = [
      extra("user", "first", "client-u"),
      extra("assistant", "ok", "client-a", { hits }),
    ];
    const messages = [
      msg("user", "first", "server-u"),
      msg("assistant", "ok", "server-a"),
      msg("user", "from pet", "server-u2"),
      msg("assistant", "later", "server-a2"),
    ];
    const out = applyHistory(messages, extras);
    expect(out[1].hits).toEqual(hits);
    expect(out[3].hits).toBeUndefined();
  });

  it("restores extras from the session cache after remount (no extras arg)", () => {
    rememberChatExtras(
      extra("assistant", "찾았어요", "server-a", { hits, planKind: "fill_note", planId: "p2" }),
    );
    const out = applyHistory([
      msg("user", "찾아줘", "server-u"),
      msg("assistant", "찾았어요", "server-a"),
    ]);
    expect(out[1].hits).toEqual(hits);
    expect(out[1].planKind).toBe("fill_note");
    expect(out[1].planId).toBe("p2");
  });

  it("parses server meta into chips and lets it win over the session cache", () => {
    rememberChatExtras(
      extra("assistant", "정리할까요?", "server-a", {
        planKind: "fill_note",
        planId: "cached",
        hits: [{ note_id: "old", title: "Old", snippet: "o" }],
      }),
    );
    const messages: PetMessage[] = [
      msg("user", "이 노트 설명", "server-u"),
      {
        role: "assistant",
        text: "정리할까요?",
        created_at: "server-a",
        meta: JSON.stringify({
          plan_kind: "prune_plan",
          plan_id: "plan-9",
          note_id: "n9",
          note_title: "대상",
          hits: [{ note_id: "n1", title: "Alpha", snippet: "snippet" }],
          vision_status: "fallback_text",
          failed: true,
        }),
      },
      {
        role: "user",
        text: "LONG PROMPT",
        created_at: "server-u2",
        meta: JSON.stringify({ display_text: "이 노트 설명" }),
      },
    ];
    const out = applyHistory(messages);
    expect(out[1].planKind).toBe("prune_plan");
    expect(out[1].planId).toBe("plan-9");
    expect(out[1].noteId).toBe("n9");
    expect(out[1].noteTitle).toBe("대상");
    expect(out[1].hits).toEqual(hits);
    expect(out[1].visionStatus).toBe("fallback_text");
    expect(out[1].failed).toBe(true);
    expect(out[2].displayText).toBe("이 노트 설명");
  });

  it("restores section_title from server meta", () => {
    const messages: PetMessage[] = [
      {
        role: "assistant",
        text: "요청을 구체화했습니다.",
        created_at: "server-s",
        meta: JSON.stringify({ section_title: "업무일지 템플릿" }),
      },
    ];
    const out = applyHistory(messages);
    expect(out[0].sectionTitle).toBe("업무일지 템플릿");
  });

  it("restores action from server meta", () => {
    const messages: PetMessage[] = [
      {
        role: "assistant",
        text: "검색 결과입니다.",
        created_at: "server-s",
        meta: JSON.stringify({ action: "search", hits }),
      },
    ];
    const out = applyHistory(messages);
    expect(out[0].action).toBe("search");
    expect(out[0].hits).toEqual(hits);
  });
});

describe("visibleChatText", () => {
  it("prefers displayText, then a known preset name", () => {
    const presets = [{ name: "이 노트 설명", prompt: "LONG PROMPT" }];
    expect(visibleChatText({ role: "user", text: "LONG PROMPT", displayText: "표시" }, presets)).toBe(
      "표시",
    );
    expect(visibleChatText({ role: "user", text: "LONG PROMPT" }, presets)).toBe("이 노트 설명");
    expect(visibleChatText({ role: "user", text: "그냥 질문" }, presets)).toBe("그냥 질문");
    expect(visibleChatText({ role: "assistant", text: "LONG PROMPT" }, presets)).toBe("LONG PROMPT");
  });
});
