import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DatesPanel } from "./DatesPanel";

const callMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
}));

const row = (over: Record<string, unknown> = {}) => ({
  id: "p0",
  note_id: "n1",
  position: 0,
  year: 2026,
  month: 9,
  day: 12,
  end_year: null,
  end_month: null,
  end_day: null,
  remind: false,
  created_at: "",
  start_time: null,
  end_time: null,
  remind_offset_min: null,
  rrule: null,
  label: null,
  ...over,
});

// PLAN-2026-09-10 D1 — 이 패널의 계약은 "노트 id 하나". 세 표면(노트 탭 칩 · 달력 생성 팝오버 ·
// 펼친 카드)이 같은 것을 쓰려면 대표 행을 props 로 받는 우회로가 없어야 한다.
describe("DatesPanel — 노트 id 하나로 자족한다", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [row()] } : {},
    );
  });

  describe("오늘 날짜를 고정한다", () => {
    // 2026-10-06 — 이 테스트는 9월에만 우연히 통과하고 있었다. 첫 프레임의 달력은 오늘의 달로
    // 시작하는데(seed 없음), 아래 단언이 "note-date-primary" 가 뜬 직후 바로 라벨을 읽었기
    // 때문이다: NoteDatesList 는 dates 를 그린 **뒤** 별도 `useEffect([dates])` 에서
    // onDatesChange 를 불러 seedFromRow 가 viewMonth 를 옮긴다(파일 아래 플레이크 주석과 같은
    // 갭). 9월에는 "오늘의 달" = "대표 행의 달" 이라 그 갭이 보이지 않았다. 오늘을 대표 행과
    // 다른 달로 못박아, 시딩을 실제로 기다리지 않으면 반드시 빨개지게 한다.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 2, 15)); // 2026-03-15 — 대표 행(9월)과 다른 달
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("노트 id 만 주면 그 노트의 행 목록과 대표 행의 달을 그린다", async () => {
      render(<DatesPanel noteId="n1" />);
      // 목록이 도착하기 전 첫 프레임은 오늘의 달 — 아래 단언이 폴백과 우연히 겹칠 수 없다는 증거.
      expect(screen.getByTestId("range-cal-month-label").textContent).toBe("2026.03");
      // onDatesChange → seedFromRow 가 끝났다는 신호(selectedId 가 목록으로 왕복해 그려짐).
      await waitFor(() =>
        expect(screen.getByTestId("note-date-primary").getAttribute("data-selected")).toBe("true"),
      );
      expect(callMock).toHaveBeenCalledWith("note_dates_list", { note_id: "n1" });
      // 달력은 대표 행의 달로 간다 — 호출자가 날짜를 알려주지 않아도.
      expect(screen.getByTestId("range-cal-month-label").textContent).toBe("2026.09");
    });
  });

  it("달력 편집이 선택된 행의 note_date_update 로 간다 — 대표 행도 예외가 아니다", async () => {
    render(<DatesPanel noteId="n1" />);
    await waitFor(() =>
      expect(screen.getByTestId("note-date-primary").getAttribute("data-selected")).toBe("true"),
    );
    fireEvent.keyDown(screen.getByTestId("range-day-2026-9-20"), { key: "Enter" });

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "p0", year: 2026, month: 9, day: 20 }),
      ),
    );
  });

  it("관련 행을 고르면 그 행이 편집 대상이 된다", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list"
        ? { dates: [row(), row({ id: "d1", position: 1, month: 10, day: 3 })] }
        : {},
    );
    render(<DatesPanel noteId="n1" />);
    // 행이 화면에 나타나는 **그 순간** 누른다. 예전에는 onSelect 가 id 만 받고 이 패널의 사본
    // (onDatesChange 로 나중에 채워지는)에서 행을 다시 찾았기 때문에, 그 틈에 누른 클릭이 조용히
    // 무시되고 달력이 안 움직였다 — 전량 실행에서 1/3 확률로 빨개지던 진짜 결함이다.
    fireEvent.click(await screen.findByTestId("note-date-row-d1"));
    const day = await screen.findByTestId("range-day-2026-10-5");
    expect(screen.getByTestId("range-cal-month-label").textContent).toBe("2026.10");
    fireEvent.keyDown(day, { key: "Enter" });

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "d1", month: 10, day: 5 }),
      ),
    );
  });

  // PLAN-2026-09-19-date-region-ui.md §P1 — clicking a row now also expands it (accordion single-
  // open, NoteDatesList.tsx). A calendar-selection click on a related row must still work exactly
  // as before; it just also opens that row's body now.
  it("관련 행 클릭은 선택이면서 동시에 그 행을 펼친다(§P1 아코디언)", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list"
        ? { dates: [row(), row({ id: "d1", position: 1, month: 10, day: 3 })] }
        : {},
    );
    render(<DatesPanel noteId="n1" />);
    fireEvent.click(await screen.findByTestId("note-date-row-d1"));
    expect(await screen.findByTestId("note-date-body-d1")).toBeTruthy();
  });

  // PLAN-2026-09-19-date-region-ui.md §P1 — the visible top-of-list time/label input fields are
  // gone, but the state they fed (seeded from initialLabel/initialStartTime/initialEndTime) still
  // rides along on the "+" button's note_date_add payload untouched.
  it("initialLabel 은 입력 칸 없이도 '+' 의 note_date_add 페이로드에 그대로 실린다", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [row()] } : cmd === "note_date_add" ? { id: "new1" } : {},
    );
    render(<DatesPanel noteId="n1" initialLabel="체크인" />);
    await screen.findByTestId("note-date-primary");
    // 더 이상 보이는 라벨 입력이 없다 — 옛 상단 폼의 testid 는 완전히 사라졌다.
    expect(screen.queryByTestId("date-add-row-label")).toBeNull();
    fireEvent.click(screen.getByTestId("date-add-row"));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_add",
        expect.objectContaining({ note_id: "n1", label: "체크인" }),
      ),
    );
  });

  // 비워 두면(initialLabel 없음) note_date_add 페이로드에 label 키 자체가 없다 — 기존 "+" 동작
  // (라벨 없음)을 그대로 고정한다.
  it("initialLabel 없이 '+'를 누르면 note_date_add 페이로드에 label 키가 없다", async () => {
    render(<DatesPanel noteId="n1" />);
    await screen.findByTestId("note-date-primary");
    fireEvent.click(screen.getByTestId("date-add-row"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_date_add", expect.anything()));
    const addCall = callMock.mock.calls.find((c) => c[0] === "note_date_add")![1] as Record<string, unknown>;
    expect("label" in addCall).toBe(false);
  });

  it("'+' 로 행을 만들면 onRowAdded 가 방금 쓴 날짜·라벨을 그대로 돌려준다", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [row()] } : cmd === "note_date_add" ? { id: "new1" } : {},
    );
    const onRowAdded = vi.fn();
    render(<DatesPanel noteId="n1" initialLabel="체크인" onRowAdded={onRowAdded} />);
    await screen.findByTestId("note-date-primary");
    // 2026-09-19 후속(검증 중 발견한 플레이크) — NoteDatesList 는 dates 를 그린 뒤 별도
    // `useEffect([dates])`에서 onDatesChange 를 부른다(NoteDatesList.tsx). 즉
    // "note-date-primary" 가 DOM 에 뜨는 것과, 그 콜백이 이 패널의 draftStart 를
    // seedFromRow 로 채우는 것 사이에 진짜 타이밍 갭이 있다 — 후자가 이 패널의 `selectedId`
    // 도 같이 세팅하므로, 그게 NoteDatesList 로 왕복해 data-selected 로 그려지길 기다리는
    // 편이 "그리고 나서 클릭"을 실제로 보장한다(단순 findByTestId 뒤 바로 클릭은 레이스).
    await waitFor(() =>
      expect(screen.getByTestId("note-date-primary").getAttribute("data-selected")).toBe("true"),
    );
    fireEvent.click(screen.getByTestId("date-add-row"));

    await waitFor(() => expect(onRowAdded).toHaveBeenCalledTimes(1));
    // draftStart 는 대표 행(row())의 값에서 시작한다 — 그리드를 안 건드렸으면 그대로.
    expect(onRowAdded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "new1", year: 2026, month: 9, day: 12, label: "체크인" }),
    );
  });

  // PLAN-2026-09-19-date-region-ui.md §P1 — "+" 성공 직후 새 행을 펼친 채로 시작한다
  // (justAddedId prop, NoteDatesList.tsx). 옛 상단 폼이 하던 "만들자마자 눈으로 확인" 역할을
  // 이제 아코디언이 대신한다는 것의 end-to-end 증거.
  it("'+' 로 행을 만들면 그 행이 자동으로 펼쳐진다(justAddedId)", async () => {
    let added = false;
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") {
        return { dates: added ? [row(), row({ id: "new1", position: 1, label: null })] : [row()] };
      }
      if (cmd === "note_date_add") {
        added = true;
        return { id: "new1" };
      }
      return {};
    });
    render(<DatesPanel noteId="n1" />);
    await waitFor(() =>
      expect(screen.getByTestId("note-date-primary").getAttribute("data-selected")).toBe("true"),
    );
    fireEvent.click(screen.getByTestId("date-add-row"));

    expect(await screen.findByTestId("note-date-row-new1")).toBeTruthy();
    expect(await screen.findByTestId("note-date-body-new1")).toBeTruthy();
  });

  // 2026-09-19 후속 — 처음 §W2 구현이 "+" 폼에 시각을 안 실었던 공백(오너 원 예시 "내일 2시부터
  // 10시까지 경복궁방문"의 시각이 사라지던 문제)을 메운다. §P1: 이제 보이는 입력 없이
  // initialStartTime/initialEndTime props 로만 값이 온다(nlDate 프리필 경로, DateEntryPopover).
  it("initialStartTime/initialEndTime 은 입력 칸 없이도 note_date_add 에 실린다", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [row()] } : cmd === "note_date_add" ? { id: "new-t" } : {},
    );
    render(<DatesPanel noteId="n1" initialStartTime="14:00" initialEndTime="22:00" />);
    // 알려진 플레이크(파일 상단 다른 테스트의 주석 참고) — NoteDatesList 의 onDatesChange 는
    // dates 를 그린 뒤 별도 effect 패스에서 불려 이 패널의 draftStart(month/day)를 seedFromRow
    // 로 채운다. timePayload() 는 draftStart.month/day 가 채워져야 시각을 싣는다(I1 접기) — 그
    // 시딩을 기다리지 않고 바로 누르면 month/day 가 아직 null 이라 시각이 통째로 빠진다.
    await waitFor(() =>
      expect(screen.getByTestId("note-date-primary").getAttribute("data-selected")).toBe("true"),
    );
    expect(screen.queryByTestId("date-add-row-start-time")).toBeNull();
    expect(screen.queryByTestId("date-add-row-end-time")).toBeNull();
    fireEvent.click(screen.getByTestId("date-add-row"));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "note_date_add",
        expect.objectContaining({ start_time: "14:00", end_time: "22:00" }),
      ),
    );
  });

  it("initialStartTime 없이 initialEndTime 만 있으면 note_date_add 페이로드에 시각 키 자체가 없다 (I2)", async () => {
    render(<DatesPanel noteId="n1" initialEndTime="22:00" />);
    await screen.findByTestId("note-date-primary");
    fireEvent.click(screen.getByTestId("date-add-row"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_date_add", expect.anything()));
    const addCall = callMock.mock.calls.find((c) => c[0] === "note_date_add")![1] as Record<string, unknown>;
    expect("start_time" in addCall).toBe(false);
    expect("end_time" in addCall).toBe(false);
  });

  it("라벨 없이 '+'를 누르면 onRowAdded 는 label: null 을 돌려준다", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_dates_list" ? { dates: [row()] } : cmd === "note_date_add" ? { id: "new2" } : {},
    );
    const onRowAdded = vi.fn();
    render(<DatesPanel noteId="n1" onRowAdded={onRowAdded} />);
    await screen.findByTestId("note-date-primary");
    fireEvent.click(screen.getByTestId("date-add-row"));

    await waitFor(() => expect(onRowAdded).toHaveBeenCalledWith(expect.objectContaining({ label: null })));
  });

  it("초안 페이지(noteId 없음)는 목록도 '+' 도 없고 스토어 세터로만 쓴다", () => {
    const setEventPrecision = vi.fn();
    render(
      <DatesPanel
        noteId={null}
        seed={{ year: 2026, month: 9, day: 1, end_year: null, end_month: null, end_day: null }}
        draft={{ setYear: vi.fn(), setEventPrecision, setEventEnd: vi.fn() }}
      />,
    );
    expect(screen.queryByTestId("date-related-dates-section")).toBeNull();
    expect(screen.queryByTestId("date-add-row")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("range-day-2026-9-20"), { key: "Enter" });
    expect(setEventPrecision).toHaveBeenCalledWith(9, 20);
    expect(callMock).not.toHaveBeenCalledWith("note_dates_list", expect.anything());
    expect(callMock).not.toHaveBeenCalledWith("note_date_update", expect.anything());
  });
});
