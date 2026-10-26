import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatMemorySection } from "./ChatMemorySection";
import { useSettingsStore } from "../../stores/settings";

const callMock = vi.fn().mockResolvedValue({});
const emitNoticeMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

describe("ChatMemorySection", () => {
  beforeEach(() => {
    callMock.mockClear();
    emitNoticeMock.mockClear();
    useSettingsStore.setState({ chatMemory: [], uiLang: "ko" } as never);
  });

  it("기본 렌더링 시 data-testid 접두사 규칙(settings-chat-memory-*)을 만족한다", () => {
    render(<ChatMemorySection />);
    expect(screen.getByTestId("settings-chat-memory-section")).toBeTruthy();
    expect(screen.getByTestId("settings-chat-memory-input")).toBeTruthy();
    expect(screen.getByTestId("settings-chat-memory-add-btn")).toBeTruthy();
  });

  it("기억 목록이 비어있으면 안내 문구를 표시한다", () => {
    render(<ChatMemorySection />);
    expect(screen.getByText("아직 기억된 내용이 없습니다.")).toBeTruthy();
    expect(screen.queryByTestId("settings-chat-memory-list")).toBeNull();
  });

  it("기억이 있을 때 목록을 렌더링하고 삭제 버튼 testid를 제공한다", () => {
    useSettingsStore.setState({
      chatMemory: [
        { id: "mem-1", text: "고양이를 키움", created_at: "2026-09-01T00:00:00Z" },
        { id: "mem-2", text: "커피를 좋아함", created_at: "2026-09-01T01:00:00Z" },
      ],
    } as never);

    render(<ChatMemorySection />);
    expect(screen.getByTestId("settings-chat-memory-list")).toBeTruthy();
    expect(screen.getByText("고양이를 키움")).toBeTruthy();
    expect(screen.getByText("커피를 좋아함")).toBeTruthy();
    expect(screen.getByTestId("settings-chat-memory-delete-mem-1")).toBeTruthy();
    expect(screen.getByTestId("settings-chat-memory-delete-mem-2")).toBeTruthy();
  });

  it("입력창에 텍스트를 넣고 추가 버튼을 누르면 기억이 추가되고 입력창이 초기화된다", async () => {
    render(<ChatMemorySection />);
    const input = screen.getByTestId("settings-chat-memory-input") as HTMLInputElement;
    const addBtn = screen.getByTestId("settings-chat-memory-add-btn") as HTMLButtonElement;

    await userEvent.type(input, "새로운 기억");
    expect(addBtn.disabled).toBe(false);
    await userEvent.click(addBtn);

    expect(callMock).toHaveBeenCalledWith(
      "settings_set",
      expect.objectContaining({
        entries: expect.objectContaining({
          chat_memory: expect.arrayContaining([expect.objectContaining({ text: "새로운 기억" })]),
        }),
      }),
    );
    expect(input.value).toBe("");
  });

  it("Enter 키를 누르면 기억이 추가된다", async () => {
    render(<ChatMemorySection />);
    const input = screen.getByTestId("settings-chat-memory-input") as HTMLInputElement;

    await userEvent.type(input, "엔터로 추가{enter}");

    expect(callMock).toHaveBeenCalledWith(
      "settings_set",
      expect.objectContaining({
        entries: expect.objectContaining({
          chat_memory: expect.arrayContaining([expect.objectContaining({ text: "엔터로 추가" })]),
        }),
      }),
    );
    expect(input.value).toBe("");
  });

  it("공백만 있는 경우 추가 버튼이 비활성화된다", async () => {
    render(<ChatMemorySection />);
    const input = screen.getByTestId("settings-chat-memory-input") as HTMLInputElement;
    const addBtn = screen.getByTestId("settings-chat-memory-add-btn") as HTMLButtonElement;

    await userEvent.type(input, "   ");
    expect(addBtn.disabled).toBe(true);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(callMock).not.toHaveBeenCalled();
  });

  it("삭제 버튼을 누르면 기억이 삭제된다", async () => {
    useSettingsStore.setState({
      chatMemory: [{ id: "mem-1", text: "삭제할 기억", created_at: "2026-09-01T00:00:00Z" }],
    } as never);

    render(<ChatMemorySection />);
    const deleteBtn = screen.getByTestId("settings-chat-memory-delete-mem-1");
    await userEvent.click(deleteBtn);

    expect(callMock).toHaveBeenCalledWith(
      "settings_set",
      expect.objectContaining({
        entries: expect.objectContaining({
          chat_memory: [],
        }),
      }),
    );
  });

  it("기억이 50개(최대치)에 도달하면 입력창과 추가 버튼이 비활성화된다", () => {
    const fullList = Array.from({ length: 50 }, (_, i) => ({
      id: `mem-${i}`,
      text: `기억 ${i}`,
      created_at: "2026-09-01T00:00:00Z",
    }));
    useSettingsStore.setState({ chatMemory: fullList } as never);

    render(<ChatMemorySection />);
    const input = screen.getByTestId("settings-chat-memory-input") as HTMLInputElement;
    const addBtn = screen.getByTestId("settings-chat-memory-add-btn") as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    expect(addBtn.disabled).toBe(true);
  });

  it("중복된 기억을 추가하려고 하거나 저장이 실패하면 입력창 내용을 유지한다", async () => {
    useSettingsStore.setState({
      chatMemory: [{ id: "mem-1", text: "기존 기억", created_at: "2026-09-01T00:00:00Z" }],
    } as never);

    render(<ChatMemorySection />);
    const input = screen.getByTestId("settings-chat-memory-input") as HTMLInputElement;
    const addBtn = screen.getByTestId("settings-chat-memory-add-btn") as HTMLButtonElement;

    await userEvent.type(input, "기존 기억");
    await userEvent.click(addBtn);

    // 중복이므로 추가되지 않고 입력창에 내용이 그대로 남아있음
    expect(input.value).toBe("기존 기억");
    // F8(PLAN-2026-09-15): 무음 실패는 버튼이 고장난 것처럼 보인다 — 이유를 한 줄 띄운다.
    await waitFor(() =>
      expect(emitNoticeMock).toHaveBeenCalledWith("이미 같은 내용을 기억하고 있습니다."),
    );
  });

  it("PLAN-2026-09-15 W3: 용량 게이지 — n / 50 비율과 마지막 추가 캡션", () => {
    useSettingsStore.setState({
      chatMemory: [
        { id: "mem-1", text: "a", created_at: "2026-09-01T00:00:00Z" },
        { id: "mem-2", text: "b", created_at: "2026-09-02T00:00:00Z" },
      ],
    } as never);
    render(<ChatMemorySection />);
    expect(screen.getByTestId("settings-chat-memory-gauge-ratio").textContent).toBe("2 / 50");
    expect(screen.getByTestId("settings-chat-memory-gauge-breakdown").textContent).toContain("마지막 추가");
    expect(screen.getByTestId("settings-chat-memory-gauge-bar").getAttribute("aria-valuenow")).toBe("4");
  });

  it("PLAN-2026-09-15 W3: 비어 있으면 0 / 50 이고 캡션은 없다", () => {
    render(<ChatMemorySection />);
    expect(screen.getByTestId("settings-chat-memory-gauge-ratio").textContent).toBe("0 / 50");
    expect(screen.getByTestId("settings-chat-memory-gauge-breakdown").textContent).toBe("");
  });

  it("한글 조합 중의 Enter 는 기억을 추가하지 않는다", () => {
    render(<ChatMemorySection />);
    const input = screen.getByTestId("settings-chat-memory-input");
    fireEvent.change(input, { target: { value: "고양이" } });
    callMock.mockClear();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(callMock).not.toHaveBeenCalledWith("settings_set", expect.anything());
    expect(useSettingsStore.getState().chatMemory).toHaveLength(0);
  });

  it("가득 차면 입력이 잠기고 그 이유를 한 줄로 말한다", () => {
    useSettingsStore.setState({
      chatMemory: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, text: `t${i}`, created_at: "2026-09-01T00:00:00Z" })),
    } as never);
    render(<ChatMemorySection />);
    const input = screen.getByTestId("settings-chat-memory-input") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    const reason = screen.getByTestId("settings-chat-memory-full");
    expect(reason.textContent).toContain("50");
    expect(input.getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("삭제 버튼의 접근 이름에 어느 기억인지가 들어간다", () => {
    useSettingsStore.setState({
      chatMemory: [{ id: "mem-1", text: "고양이를 키움", created_at: "2026-09-01T00:00:00Z" }],
    } as never);
    render(<ChatMemorySection />);
    expect(screen.getByTestId("settings-chat-memory-delete-mem-1").getAttribute("aria-label")).toContain("고양이를 키움");
  });
});
