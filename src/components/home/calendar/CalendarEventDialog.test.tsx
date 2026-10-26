import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useNotesStore } from "../../../stores/notes";
import {
  CalendarEventDialog,
  parseCalendarScheduleProposal,
  addDaysIso,
  buildCalendarSchedulePrompt,
} from "./CalendarEventDialog";

describe("CalendarEventDialog", () => {
  // PLAN-2026-09-10 D3 — 노트는 드래그를 놓을 때 이미 만들어졌다(createdNoteId). 이 팝오버는
  // 그 노트에 제목과 폴더를 얹는 자리이고, 확정은 그 둘만 넘긴다.
  it("renders drag-create popover and submits title + folder on confirm", async () => {
    const onConfirmCreate = vi.fn();
    const onClosePopover = vi.fn();
    useNotesStore.setState({
      folders: [{ id: "inbox1", name: "Inbox", position: 0 }],
      inboxId: "inbox1",
    } as never);

    render(
      <CalendarEventDialog
        popover={{ startDay: "2026-08-10", endDay: "2026-08-12", x: 100, y: 100 }}
        createdNoteId="n1"
        onConfirmCreate={onConfirmCreate}
        onClosePopover={onClosePopover}
        aiPrompt={null}
        onSubmitAiPrompt={vi.fn()}
        onCloseAiPrompt={vi.fn()}
        aiProposal={null}
        onConfirmAiProposal={vi.fn()}
        onCloseAiProposal={vi.fn()}
      />,
    );

    const pop = screen.getByTestId("cal-create-pop");
    expect(pop).toBeTruthy();
    // 노트 탭 날짜 칩과 같은 컴포넌트가 팝오버 **안에** 인라인으로 들어온다(포털 중첩 금지).
    expect(screen.getByTestId("cal-create-dates")).toBeTruthy();

    const titleInput = screen.getByTestId("cal-create-title");
    fireEvent.change(titleInput, { target: { value: "My Event" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("cal-create-confirm"));
    });

    expect(onConfirmCreate).toHaveBeenCalledWith("My Event", "inbox1");

    fireEvent.click(screen.getByTestId("cal-create-cancel"));
    expect(onClosePopover).toHaveBeenCalled();
  });

  // 생성이 아직 끝나지 않았으면(노트 id 없음) 확정할 대상이 없다 — 날짜 칩도 아직 없다.
  it("waits for the created note before enabling 만들기", () => {
    const onConfirmCreate = vi.fn();
    render(
      <CalendarEventDialog
        popover={{ startDay: "2026-08-10", endDay: "2026-08-10", x: 100, y: 100 }}
        createdNoteId={null}
        onConfirmCreate={onConfirmCreate}
        onClosePopover={vi.fn()}
        aiPrompt={null}
        onSubmitAiPrompt={vi.fn()}
        onCloseAiPrompt={vi.fn()}
        aiProposal={null}
        onConfirmAiProposal={vi.fn()}
        onCloseAiProposal={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("cal-create-dates")).toBeNull();
    expect((screen.getByTestId("cal-create-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders AI prompt popover and submits user request", async () => {
    const onSubmitAiPrompt = vi.fn();
    const onCloseAiPrompt = vi.fn();

    render(
      <CalendarEventDialog
        popover={null}
        onConfirmCreate={vi.fn()}
        onClosePopover={vi.fn()}
        aiPrompt={{ day: "2026-08-10", x: 150, y: 200 }}
        onSubmitAiPrompt={onSubmitAiPrompt}
        onCloseAiPrompt={onCloseAiPrompt}
        aiProposal={null}
        onConfirmAiProposal={vi.fn()}
        onCloseAiProposal={vi.fn()}
      />,
    );

    const input = screen.getByTestId("cal-ai-prompt-input");
    fireEvent.change(input, { target: { value: "동해 여행" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("cal-ai-prompt-submit"));
    });

    expect(onSubmitAiPrompt).toHaveBeenCalledWith(
      { day: "2026-08-10", x: 150, y: 200 },
      "동해 여행",
    );

    fireEvent.click(screen.getByTestId("cal-ai-prompt-cancel"));
    expect(onCloseAiPrompt).toHaveBeenCalled();
  });

  it("renders AI proposal popover and confirms proposal", async () => {
    const onConfirmAiProposal = vi.fn();
    const onCloseAiProposal = vi.fn();

    render(
      <CalendarEventDialog
        popover={null}
        onConfirmCreate={vi.fn()}
        onClosePopover={vi.fn()}
        aiPrompt={null}
        onSubmitAiPrompt={vi.fn()}
        onCloseAiPrompt={vi.fn()}
        aiProposal={{
          title: "제주도 여행",
          start: "2026-08-10",
          end: "2026-08-14",
          x: 100,
          y: 100,
        }}
        onConfirmAiProposal={onConfirmAiProposal}
        onCloseAiProposal={onCloseAiProposal}
      />,
    );

    expect(screen.getByText("제주도 여행")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("cal-ai-proposal-confirm"));
    });

    expect(onConfirmAiProposal).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("cal-ai-proposal-cancel"));
    expect(onCloseAiProposal).toHaveBeenCalled();
  });
});

describe("CalendarEventDialog pure helpers", () => {
  it("addDaysIso handles UTC day arithmetic properly", () => {
    expect(addDaysIso("2026-08-10", 3)).toBe("2026-08-13");
    expect(addDaysIso("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysIso("invalid", 1)).toBeNull();
  });

  it("parseCalendarScheduleProposal handles json fences and keys", () => {
    const raw = "```json\n{\"title\": \"Conference\", \"start\": \"2026-08-15\", \"duration_days\": 3}\n```";
    expect(parseCalendarScheduleProposal(raw, "2026-08-15")).toEqual({
      title: "Conference",
      start: "2026-08-15",
      end: "2026-08-17",
    });
  });

  it("buildCalendarSchedulePrompt formats prompt correctly", () => {
    const prompt = buildCalendarSchedulePrompt("2026-08-15", "워크샵");
    expect(prompt).toContain("2026-08-15");
    expect(prompt).toContain("워크샵");
  });
});
