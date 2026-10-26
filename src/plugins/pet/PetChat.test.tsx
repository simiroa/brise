import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PetChat } from "./PetChat";

// jsdom doesn't implement Element.scrollTo — PetChat's list-autoscroll effect calls it on mount.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

const baseProps = {
  items: [],
  pending: false,
  onSend: vi.fn(),
  onSaveMemo: vi.fn(),
  onOpenNote: vi.fn(),
  onClose: vi.fn(),
};

describe("PetChat — compact last 3", () => {
  it("shows only the latest three bubbles", () => {
    render(
      <PetChat
        {...baseProps}
        items={[
          { role: "user", text: "one" },
          { role: "assistant", text: "two" },
          { role: "user", text: "three" },
          { role: "assistant", text: "four" },
        ]}
      />,
    );
    expect(screen.queryByText("one")).toBeNull();
    expect(screen.getByText("two")).toBeTruthy();
    expect(screen.getByText("four")).toBeTruthy();
    expect(document.querySelectorAll(".pet-bubble").length).toBe(3);
  });
});

describe("PetChat — failed bubble", () => {
  it("renders a muted failed assistant row", () => {
    render(
      <PetChat
        {...baseProps}
        items={[{ role: "assistant", text: "잘 안 됐어요. 잠시 뒤 다시 시도해 주세요.", failed: true }]}
      />,
    );
    const bubble = document.querySelector(".pet-bubble--failed");
    expect(bubble).toBeTruthy();
    expect(bubble?.getAttribute("data-failed")).toBe("true");
    expect(bubble?.textContent).toContain("실패");
  });
});

describe("PetChat — plan tool chip", () => {
  it("renders a compact chip and calls onOpenPlan", () => {
    const onOpenPlan = vi.fn();
    render(
      <PetChat
        {...baseProps}
        onOpenPlan={onOpenPlan}
        items={[
          {
            role: "assistant",
            text: "이름부터 볼까요?",
            planKind: "rename_plan",
            planId: "p1",
          },
        ]}
      />,
    );
    const chip = screen.getByTestId("chat-plan-chip");
    expect(chip.textContent).toContain("자세히 보기");
    fireEvent.click(chip);
    expect(onOpenPlan).toHaveBeenCalledTimes(1);
  });
});

describe("PetChat — suggestion card (P2 2단계 후행 제안)", () => {
  it("renders nothing suggestion-related when there is no pending suggestion", () => {
    render(<PetChat {...baseProps} suggestion={null} />);
    expect(screen.queryByTestId("pet-suggestion-card")).toBeNull();
  });

  it("renders both note titles in the card text", () => {
    render(
      <PetChat
        {...baseProps}
        suggestion={{ kind: "overlap", id: "s1", noteTitle: "여행 메모", relatedNoteTitle: "여행 계획" }}
      />,
    );
    const card = screen.getByTestId("pet-suggestion-card");
    expect(card.textContent).toContain("여행 메모");
    expect(card.textContent).toContain("여행 계획");
  });

  it("falls back to a placeholder for an untitled note", () => {
    render(<PetChat {...baseProps} suggestion={{ kind: "overlap", id: "s1", noteTitle: "", relatedNoteTitle: "B" }} />);
    expect(screen.getByTestId("pet-suggestion-card").textContent).toContain("(제목 없음)");
  });

  it("클릭 '무시' calls onDismissSuggestion, not onReviewSuggestion", async () => {
    const onDismissSuggestion = vi.fn();
    const onReviewSuggestion = vi.fn();
    render(
      <PetChat
        {...baseProps}
        suggestion={{ kind: "overlap", id: "s1", noteTitle: "A", relatedNoteTitle: "B" }}
        onDismissSuggestion={onDismissSuggestion}
        onReviewSuggestion={onReviewSuggestion}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "무시" }));
    expect(onDismissSuggestion).toHaveBeenCalledTimes(1);
    expect(onReviewSuggestion).not.toHaveBeenCalled();
  });

  it("클릭 '검토하기' calls onReviewSuggestion, not onDismissSuggestion", async () => {
    const onDismissSuggestion = vi.fn();
    const onReviewSuggestion = vi.fn();
    render(
      <PetChat
        {...baseProps}
        suggestion={{ kind: "overlap", id: "s1", noteTitle: "A", relatedNoteTitle: "B" }}
        onDismissSuggestion={onDismissSuggestion}
        onReviewSuggestion={onReviewSuggestion}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "검토하기" }));
    expect(onReviewSuggestion).toHaveBeenCalledTimes(1);
    expect(onDismissSuggestion).not.toHaveBeenCalled();
  });
});

describe("PetChat — link suggestion card (P2 3단계 후행 제안)", () => {
  const linkSuggestion = {
    kind: "link" as const,
    id: "s2",
    title: "세종대왕",
    summary: "세종대왕이 1443년 훈민정음을 창제했다는 내용이에요",
    url: "https://example.com/sejong",
    targetNoteTitle: "역사 공부",
  };

  it("renders the summary and target note title, with an '추가하기' action instead of '검토하기'", () => {
    render(<PetChat {...baseProps} suggestion={linkSuggestion} />);
    const card = screen.getByTestId("pet-suggestion-card");
    expect(card.textContent).toContain("훈민정음을 창제했다");
    expect(card.textContent).toContain("역사 공부");
    expect(screen.getByRole("button", { name: "추가하기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "검토하기" })).toBeNull();
  });

  it("falls back to '새 노트로 저장' phrasing when there is no target note", () => {
    render(<PetChat {...baseProps} suggestion={{ ...linkSuggestion, targetNoteTitle: null }} />);
    expect(screen.getByTestId("pet-suggestion-card").textContent).toContain("새 노트로 저장할까요?");
  });

  it("클릭 '추가하기' calls onAcceptLink, not onDismissSuggestion", async () => {
    const onDismissSuggestion = vi.fn();
    const onAcceptLink = vi.fn();
    render(
      <PetChat
        {...baseProps}
        suggestion={linkSuggestion}
        onDismissSuggestion={onDismissSuggestion}
        onAcceptLink={onAcceptLink}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "추가하기" }));
    expect(onAcceptLink).toHaveBeenCalledTimes(1);
    expect(onDismissSuggestion).not.toHaveBeenCalled();
  });

  it("클릭 '무시' still works for a link card", async () => {
    const onDismissSuggestion = vi.fn();
    render(<PetChat {...baseProps} suggestion={linkSuggestion} onDismissSuggestion={onDismissSuggestion} />);
    await userEvent.click(screen.getByRole("button", { name: "무시" }));
    expect(onDismissSuggestion).toHaveBeenCalledTimes(1);
  });
});

describe("PetChat — theme suggestion card (웨이브 ③ 테마 후행 제안)", () => {
  const themeSuggestion = {
    kind: "theme" as const,
    id: "s3",
    noteTitle: "우유 사기",
    othersCount: 4,
  };

  it("renders the anchor title and the others count with a '모으기' action", () => {
    render(<PetChat {...baseProps} suggestion={themeSuggestion} />);
    const card = screen.getByTestId("pet-suggestion-card");
    expect(card.textContent).toContain("우유 사기");
    expect(card.textContent).toContain("외 4개");
    expect(screen.getByRole("button", { name: "모으기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "검토하기" })).toBeNull();
    expect(screen.queryByRole("button", { name: "추가하기" })).toBeNull();
  });

  it("클릭 '모으기' calls onAcceptTheme, not onAcceptLink/onReviewSuggestion", async () => {
    const onAcceptTheme = vi.fn();
    const onAcceptLink = vi.fn();
    const onReviewSuggestion = vi.fn();
    render(
      <PetChat
        {...baseProps}
        suggestion={themeSuggestion}
        onAcceptTheme={onAcceptTheme}
        onAcceptLink={onAcceptLink}
        onReviewSuggestion={onReviewSuggestion}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "모으기" }));
    expect(onAcceptTheme).toHaveBeenCalledTimes(1);
    expect(onAcceptLink).not.toHaveBeenCalled();
    expect(onReviewSuggestion).not.toHaveBeenCalled();
  });

  it("falls back to '(제목 없음)' when the anchor note has no title", () => {
    render(<PetChat {...baseProps} suggestion={{ ...themeSuggestion, noteTitle: "" }} />);
    expect(screen.getByTestId("pet-suggestion-card").textContent).toContain("(제목 없음)");
  });
});

describe("PetChat — collect_post_process suggestion card (docs/SUGGESTIONS.md §3)", () => {
  const collectSuggestion = {
    kind: "collect" as const,
    id: "s4",
    noteTitle: "회의록 2026-08-29",
    sourceName: "업무 메일함",
  };

  it("renders the source and note title with a '정리하기' action", () => {
    render(<PetChat {...baseProps} suggestion={collectSuggestion} />);
    const card = screen.getByTestId("pet-suggestion-card");
    expect(card.textContent).toContain("업무 메일함");
    expect(card.textContent).toContain("회의록 2026-08-29");
    expect(screen.getByRole("button", { name: "정리하기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "검토하기" })).toBeNull();
    expect(screen.queryByRole("button", { name: "추가하기" })).toBeNull();
    expect(screen.queryByRole("button", { name: "모으기" })).toBeNull();
  });

  it("falls back to '(제목 없음)' when the collected note has no title", () => {
    render(<PetChat {...baseProps} suggestion={{ ...collectSuggestion, noteTitle: "" }} />);
    expect(screen.getByTestId("pet-suggestion-card").textContent).toContain("(제목 없음)");
  });

  it("클릭 '정리하기' calls onAcceptCollect, not onDismissSuggestion/onAcceptTheme/onAcceptLink", async () => {
    const onAcceptCollect = vi.fn();
    const onDismissSuggestion = vi.fn();
    const onAcceptTheme = vi.fn();
    const onAcceptLink = vi.fn();
    render(
      <PetChat
        {...baseProps}
        suggestion={collectSuggestion}
        onAcceptCollect={onAcceptCollect}
        onDismissSuggestion={onDismissSuggestion}
        onAcceptTheme={onAcceptTheme}
        onAcceptLink={onAcceptLink}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "정리하기" }));
    expect(onAcceptCollect).toHaveBeenCalledTimes(1);
    expect(onDismissSuggestion).not.toHaveBeenCalled();
    expect(onAcceptTheme).not.toHaveBeenCalled();
    expect(onAcceptLink).not.toHaveBeenCalled();
  });

  it("클릭 '무시' still works for a collect card", async () => {
    const onDismissSuggestion = vi.fn();
    render(<PetChat {...baseProps} suggestion={collectSuggestion} onDismissSuggestion={onDismissSuggestion} />);
    await userEvent.click(screen.getByRole("button", { name: "무시" }));
    expect(onDismissSuggestion).toHaveBeenCalledTimes(1);
  });
});

describe("PetChat — conversation close prompt", () => {
  it("asks whether to save a non-empty conversation before closing", async () => {
    const onClose = vi.fn();
    const onSaveConversation = vi.fn().mockResolvedValue(undefined);
    render(
      <PetChat
        {...baseProps}
        items={[{ role: "user", text: "이번 주 회의 내용을 기억해줘" }]}
        onClose={onClose}
        onSaveConversation={onSaveConversation}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));

    expect(screen.getByRole("dialog").textContent).toContain("이 대화를 노트에 정리할까요?");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("saves the conversation and closes after accepting", async () => {
    const onClose = vi.fn();
    const onSaveConversation = vi.fn().mockResolvedValue(undefined);
    const items = [
      { role: "user" as const, text: "회의 안건" },
      { role: "assistant" as const, text: "기록해둘게요" },
    ];
    render(<PetChat {...baseProps} items={items} onClose={onClose} onSaveConversation={onSaveConversation} />);

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    await userEvent.click(screen.getByRole("button", { name: "노트로 정리" }));

    expect(onSaveConversation).toHaveBeenCalledTimes(1);
    expect(onSaveConversation).toHaveBeenCalledWith(items);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the prompt open and reports an error when saving fails", async () => {
    const onClose = vi.fn();
    const onSaveConversation = vi.fn().mockRejectedValue(new Error("offline"));
    render(
      <PetChat
        {...baseProps}
        items={[{ role: "user", text: "오프라인에서도 남겨줘" }]}
        onClose={onClose}
        onSaveConversation={onSaveConversation}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    await userEvent.click(screen.getByRole("button", { name: "노트로 정리" }));

    expect(screen.getByRole("alert").textContent).toContain("노트로 정리하지 못했어요");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("can close without saving, or cancel the prompt", async () => {
    const onClose = vi.fn();
    const onSaveConversation = vi.fn().mockResolvedValue(undefined);
    render(
      <PetChat
        {...baseProps}
        items={[{ role: "assistant", text: "도움이 되었나요?" }]}
        onClose={onClose}
        onSaveConversation={onSaveConversation}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    await userEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    await userEvent.click(screen.getByRole("button", { name: "그냥 닫기" }));
    expect(onSaveConversation).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not offer to save restored history when the current session is empty", async () => {
    const onClose = vi.fn();
    const onSaveConversation = vi.fn().mockResolvedValue(undefined);
    render(
      <PetChat
        {...baseProps}
        items={[{ role: "user", text: "이전 대화" }]}
        conversationItems={[]}
        onClose={onClose}
        onSaveConversation={onSaveConversation}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSaveConversation).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the same save prompt for Escape and blocks save while a reply is pending", async () => {
    const onClose = vi.fn();
    const onSaveConversation = vi.fn().mockResolvedValue(undefined);
    render(
      <PetChat
        {...baseProps}
        pending
        items={[{ role: "user", text: "응답을 기다리는 질문" }]}
        onClose={onClose}
        onSaveConversation={onSaveConversation}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByRole("button", { name: "노트로 정리" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "그냥 닫기" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens the same prompt when the character window requests a close", async () => {
    const onClose = vi.fn();
    const onSaveConversation = vi.fn().mockResolvedValue(undefined);
    render(
      <PetChat
        {...baseProps}
        items={[{ role: "user", text: "캐릭터를 다시 눌렀어요" }]}
        closeRequest={1}
        onClose={onClose}
        onSaveConversation={onSaveConversation}
      />,
    );

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
