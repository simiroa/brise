import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatBubble } from "./ChatBubble";
import type { PetChatItem } from "./PetChat";

function assistantItem(overrides: Partial<PetChatItem> = {}): PetChatItem {
  return {
    role: "assistant",
    text: "여기 요약이 있어요",
    ...overrides,
  };
}

describe("ChatBubble — create_section chip states (U3, AUDIT-2026-09-26)", () => {
  it("shows the clickable 'insert' chip when a section is pending and nothing has been auto-sent", () => {
    const onOpenPlan = vi.fn();
    render(
      <ChatBubble
        item={assistantItem({ sectionBody: "본문", sectionTitle: "제목" })}
        onOpenNote={vi.fn()}
        onOpenPlan={onOpenPlan}
      />,
    );
    expect(screen.getByTestId("chat-insert-section")).toBeDefined();
    expect(screen.queryByTestId("chat-section-sent")).toBeNull();
  });

  // U3: PetBubbleApp's automatic onCreateSection can no longer claim `sectionInserted` — it marks
  // `sectionAutoSent` instead. The bubble must render this as inert "sent" status copy, never as
  // a clickable chip (clicking it again would fire a second, duplicate create-section request).
  it("shows inert 'sent' status copy (not a button) once the request was auto-sent but not confirmed", () => {
    const onOpenPlan = vi.fn();
    render(
      <ChatBubble
        item={assistantItem({ sectionBody: "본문", sectionTitle: "제목", sectionAutoSent: true })}
        onOpenNote={vi.fn()}
        onOpenPlan={onOpenPlan}
      />,
    );
    const sent = screen.getByTestId("chat-section-sent");
    expect(sent.tagName).toBe("SPAN");
    expect(screen.queryByTestId("chat-insert-section")).toBeNull();
  });

  it("hides both chip states once sectionInserted is actually confirmed true", () => {
    render(
      <ChatBubble
        item={assistantItem({ sectionBody: "본문", sectionTitle: "제목", sectionInserted: true, sectionAutoSent: true })}
        onOpenNote={vi.fn()}
        onOpenPlan={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("chat-insert-section")).toBeNull();
    expect(screen.queryByTestId("chat-section-sent")).toBeNull();
  });

  it("hides both chip states when there is no pending section at all", () => {
    render(<ChatBubble item={assistantItem()} onOpenNote={vi.fn()} onOpenPlan={vi.fn()} />);
    expect(screen.queryByTestId("chat-insert-section")).toBeNull();
    expect(screen.queryByTestId("chat-section-sent")).toBeNull();
  });
});
