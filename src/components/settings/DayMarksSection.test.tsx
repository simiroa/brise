import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useSettingsStore } from "../../stores/settings";
import { useDayMarksStore } from "../../stores/dayMarks";
import { DayMarksSection } from "./DayMarksSection";
import type { CalendarMark, CalendarMarkHide, CalendarSource } from "../../lib/commands.gen";

const callMock = vi.fn();
const noticeMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: (...args: unknown[]) => noticeMock(...args),
  // 목의 call() 거부는 실제 call() 처럼 "이미 알린" 실패로 본다.
  isErrorHandled: () => true,
  registerFlush: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
}));

const undoToastMock = vi.fn();
vi.mock("../../lib/undo", () => ({
  showUndoToast: (...args: unknown[]) => undoToastMock(...args),
}));

let mockBrowser = false;
vi.mock("../../lib/env", () => ({
  isBrowser: () => mockBrowser,
}));

const mark = (over: Partial<CalendarMark>): CalendarMark => ({
  id: "m1",
  workspace_id: "ws1",
  source_id: null,
  uid: null,
  title: "엄마 생일",
  year: null,
  month: 5,
  day: 12,
  repeat: "yearly",
  lunar: false,
  day_off: false,
  color_hue: null,
  created_at: "",
  updated_at: "",
  ...over,
});

const SRC: CalendarSource = {
  id: "s1",
  workspace_id: "ws1",
  name: "학교 달력",
  url: "https://example.com/school.ics",
  enabled: true,
  color_hue: null,
  fetched_at: "2026-09-01T00:00:00Z",
  position: 0,
  created_at: "",
  updated_at: "",
};

let list: { marks: CalendarMark[]; sources: CalendarSource[]; hides: CalendarMarkHide[] };

function mockBackend() {
  callMock.mockReset().mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "calendar_marks_list") return Promise.resolve(list);
    if (cmd === "calendar_mark_create") return Promise.resolve(mark({ id: "new", ...(args as object) }));
    if (cmd === "calendar_mark_update") return Promise.resolve(mark({ ...(args as object) }));
    if (cmd === "calendar_source_save") {
      return Promise.resolve({ source: { ...SRC, id: "s2", name: args?.name }, skipped: 0 });
    }
    return Promise.resolve({ ok: true });
  });
}

const calls = (cmd: string) => callMock.mock.calls.filter((c) => c[0] === cmd);

describe("DayMarksSection — 공휴일·기념일 표 (PLAN-2026-09-19-calendar-schedule §5.2)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 19));
    mockBrowser = false;
    noticeMock.mockReset();
    undoToastMock.mockReset();
    list = { marks: [], sources: [], hides: [] };
    mockBackend();
    useDayMarksStore.setState({ workspaceId: null, marks: [], sources: [], hides: [] });
    useSettingsStore.setState({ uiLang: "ko", holidayRegion: "kr", activeWorkspaceId: "ws1" } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("그해 기본 공휴일 · 불러온 캘린더 · 내 기념일을 날짜순 한 표로 — 종류·출처·음력·햇수까지", async () => {
    list = {
      marks: [
        mark({ id: "own", title: "결혼기념일", month: 3, day: 1, year: 2020 }),
        mark({ id: "lun", title: "할머니 생신", lunar: true, month: 1, day: 1 }),
        mark({ id: "imp", source_id: "s1", title: "개교기념일", month: 3, day: 1, repeat: "once", year: 2026, day_off: true }),
      ],
      sources: [SRC],
      hides: [],
    };
    render(<DayMarksSection />);
    await screen.findByTestId("day-mark-row-own|2026-03-01");
    expect(callMock).toHaveBeenCalledWith("calendar_marks_list", { workspace_id: "ws1" });
    expect(screen.getByTestId("day-marks-year").textContent).toBe("2026년");

    const keys = Array.from(screen.getByTestId("day-marks-list").querySelectorAll("[data-testid^='day-mark-row-']")).map(
      (el) => el.getAttribute("data-testid")!.replace("day-mark-row-", ""),
    );
    // 같은 날은 기본 → 불러온 → 내 것 순. 날짜는 오름차순.
    const i = (k: string) => keys.indexOf(k);
    expect(i("builtin|2026-01-01")).toBe(0);
    expect(i("lun|2026-02-17")).toBeGreaterThan(i("builtin|2026-02-17"));
    expect(i("builtin|2026-03-01")).toBeLessThan(i("imp|2026-03-01"));
    expect(i("imp|2026-03-01")).toBeLessThan(i("own|2026-03-01"));

    const own = screen.getByTestId("day-mark-row-own|2026-03-01");
    // 날짜 칸은 앱 언어 표기(Intl) — ko 는 "3월 1일 (일)".
    expect(own.textContent).toContain("3월 1일 (일)");
    expect(own.textContent).toContain("결혼기념일 · 6주년");
    expect(own.textContent).toContain("기념일");
    expect(own.textContent).toContain("내 기념일");
    const imp = screen.getByTestId("day-mark-row-imp|2026-03-01");
    expect(imp.textContent).toContain("빨간 날");
    expect(imp.textContent).toContain("학교 달력");
    expect(screen.getByTestId("day-mark-row-builtin|2026-03-01").textContent).toContain("기본");
    expect(screen.getByTestId("day-mark-row-lun|2026-02-17").textContent).toContain("음 1.1");
  });

  it("숨긴 기본 공휴일도 흐리게 '숨김' 으로 남고, 눈 버튼이 builtin 출처 숨김을 켜고 끈다", async () => {
    list = { marks: [], sources: [], hides: [{ source: "builtin", iso_day: "2026-03-01" }] };
    render(<DayMarksSection />);
    const row = await screen.findByTestId("day-mark-row-builtin|2026-03-01");
    await waitFor(() => expect(row.textContent).toContain("숨김"));
    fireEvent.click(within(row).getByRole("button", { name: "다시 보이기" }));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("calendar_mark_set_hidden", {
        workspace_id: "ws1",
        source: "builtin",
        iso_day: "2026-03-01",
        hidden: false,
      }),
    );

    const other = screen.getByTestId("day-mark-row-builtin|2026-05-05");
    fireEvent.click(within(other).getByRole("button", { name: "이 날 숨기기" }));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("calendar_mark_set_hidden", {
        workspace_id: "ws1",
        source: "builtin",
        iso_day: "2026-05-05",
        hidden: true,
      }),
    );
  });

  it("기본 공휴일 복사는 그해 한 번짜리 빨간 날, 불러온 매년은 매년으로", async () => {
    list = {
      marks: [mark({ id: "imp", source_id: "s1", title: "개교기념일", month: 4, day: 2, year: 2001, day_off: false })],
      sources: [SRC],
      hides: [],
    };
    render(<DayMarksSection />);
    const b = await screen.findByTestId("day-mark-copy-builtin|2026-03-01");
    fireEvent.click(b);
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("calendar_mark_create", {
        workspace_id: "ws1",
        title: "삼일절",
        year: 2026,
        month: 3,
        day: 1,
        repeat: "once",
        lunar: false,
        day_off: true,
      }),
    );
    fireEvent.click(await screen.findByTestId("day-mark-copy-imp|2026-04-02"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("calendar_mark_create", {
        workspace_id: "ws1",
        title: "개교기념일",
        year: 2001,
        month: 4,
        day: 2,
        repeat: "yearly",
        lunar: false,
        day_off: false,
      }),
    );
    expect(noticeMock).toHaveBeenCalled();
  });

  it("내 기념일 삭제는 묻지 않고 바로 지운 뒤 되돌리기 토스트 — 되돌리면 같은 값으로 다시 만든다", async () => {
    list = { marks: [mark({ id: "own", year: 2019, color_hue: 30 })], sources: [], hides: [] };
    render(<DayMarksSection />);
    fireEvent.click(await screen.findByTestId("day-mark-delete-own|2026-05-12"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("calendar_mark_delete", { id: "own" }));
    await waitFor(() => expect(calls("calendar_marks_list").length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(undoToastMock).toHaveBeenCalledTimes(1);
    expect(String(undoToastMock.mock.calls[0][0])).toContain("엄마 생일");

    const onUndo = undoToastMock.mock.calls[0][1] as () => void;
    onUndo();
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("calendar_mark_create", {
        workspace_id: "ws1",
        title: "엄마 생일",
        year: 2019,
        month: 5,
        day: 12,
        repeat: "yearly",
        lunar: false,
        day_off: false,
        color_hue: 30,
      }),
    );
  });

  it("삭제가 실패하면 되돌리기 토스트를 띄우지 않는다(call() 토스트만)", async () => {
    list = { marks: [mark({ id: "own" })], sources: [], hides: [] };
    const base = callMock.getMockImplementation()!;
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "calendar_mark_delete" ? Promise.reject(new Error("x")) : base(cmd, args),
    );
    render(<DayMarksSection />);
    fireEvent.click(await screen.findByTestId("day-mark-delete-own|2026-05-12"));
    await waitFor(() => expect(calls("calendar_mark_delete")).toHaveLength(1));
    expect(undoToastMock).not.toHaveBeenCalled();
  });

  it("폼 저장이 서버에서 실패하면 폼을 지키고, 오류는 call() 토스트 하나뿐(폼 아래 반복 없음)", async () => {
    const base = callMock.getMockImplementation()!;
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "calendar_mark_create" ? Promise.reject(new Error("VALIDATION: raw backend text")) : base(cmd, args),
    );
    render(<DayMarksSection />);
    fireEvent.click(screen.getByTestId("day-marks-add-btn"));
    fireEvent.change(screen.getByTestId("day-mark-form-title"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("day-mark-form-save"));
    await waitFor(() => expect(calls("calendar_mark_create")).toHaveLength(1));
    await waitFor(() => expect((screen.getByTestId("day-mark-form-save") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId("day-mark-form-title")).toBeTruthy();
    expect(screen.queryByTestId("day-mark-form-error")).toBeNull();
  });

  it("걸러보기: 내 기념일만 / 공휴일만", async () => {
    list = { marks: [mark({ id: "own" })], sources: [], hides: [] };
    render(<DayMarksSection />);
    await screen.findByTestId("day-mark-row-own|2026-05-12");
    fireEvent.click(screen.getByRole("radio", { name: "내 기념일" }));
    const rows = () => screen.getByTestId("day-marks-list").querySelectorAll("[data-testid^='day-mark-row-']");
    expect(rows()).toHaveLength(1);
    fireEvent.click(screen.getByRole("radio", { name: "공휴일" }));
    expect(Array.from(rows()).every((r) => r.getAttribute("data-testid")!.includes("builtin|"))).toBe(true);
  });

  it("표가 끝난 해(2031~)엔 '불러오기로 보충' 한 줄", async () => {
    render(<DayMarksSection />);
    expect(screen.queryByTestId("day-marks-table-ends")).toBeNull();
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByTestId("day-marks-year-next"));
    expect(screen.getByTestId("day-marks-year").textContent).toBe("2031년");
    expect(screen.getByTestId("day-marks-table-ends")).toBeTruthy();
  });

  it("동작 버튼은 아이콘만 — aria-label 과 title 이 같다", async () => {
    list = { marks: [mark({ id: "own" })], sources: [SRC], hides: [] };
    render(<DayMarksSection />);
    await screen.findByTestId("day-mark-row-own|2026-05-12");
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>("button.icon-btn"));
    expect(btns.length).toBeGreaterThan(5);
    for (const b of btns) {
      expect(b.getAttribute("aria-label")).toBeTruthy();
      expect(b.getAttribute("title")).toBe(b.getAttribute("aria-label"));
      expect(b.textContent).toBe("");
    }
  });

  it("브라우저 모드는 읽기 전용 — 추가·불러오기·행 동작·출처 동작이 없다", async () => {
    mockBrowser = true;
    list = { marks: [mark({ id: "own" })], sources: [SRC], hides: [] };
    render(<DayMarksSection />);
    await screen.findByTestId("day-mark-row-own|2026-05-12");
    expect(screen.queryByTestId("day-marks-add-btn")).toBeNull();
    expect(screen.queryByTestId("day-marks-import-btn")).toBeNull();
    expect(screen.queryByTestId("day-mark-delete-own|2026-05-12")).toBeNull();
    expect(screen.queryByTestId("day-mark-hide-builtin|2026-03-01")).toBeNull();
    expect(screen.queryByTestId("day-marks-source-delete-s1")).toBeNull();
  });

  it("추가 폼: 음력이면 반복이 매년으로 묶이고, 한 번 + 연도 없음은 막고, 저장은 calendar_mark_create", async () => {
    render(<DayMarksSection />);
    fireEvent.click(screen.getByTestId("day-marks-add-btn"));
    fireEvent.change(screen.getByTestId("day-mark-form-title"), { target: { value: "제사" } });
    fireEvent.click(screen.getByRole("radio", { name: "한 번" }));
    fireEvent.change(screen.getByTestId("day-mark-form-year"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("day-mark-form-save"));
    expect(screen.getByTestId("day-mark-form-error").textContent).toContain("연도");
    expect(calls("calendar_mark_create")).toHaveLength(0);

    fireEvent.click(screen.getByRole("radio", { name: "음력" }));
    expect(screen.getByRole("radio", { name: "매년" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(screen.getByTestId("day-mark-form-day"), { target: { value: "30" } });
    fireEvent.click(screen.getByTestId("day-mark-form-save"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("calendar_mark_create", {
        workspace_id: "ws1",
        title: "제사",
        month: 1,
        day: 30,
        repeat: "yearly",
        lunar: true,
        day_off: false,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("day-mark-form-title")).toBeNull());
  });

  it("양력 2월 30일은 서버에 가기 전에 막는다", async () => {
    render(<DayMarksSection />);
    fireEvent.click(screen.getByTestId("day-marks-add-btn"));
    fireEvent.change(screen.getByTestId("day-mark-form-title"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("day-mark-form-month"));
    fireEvent.click(screen.getByRole("option", { name: "2" }));
    fireEvent.change(screen.getByTestId("day-mark-form-day"), { target: { value: "30" } });
    fireEvent.click(screen.getByTestId("day-mark-form-save"));
    expect(screen.getByTestId("day-mark-form-error")).toBeTruthy();
    expect(calls("calendar_mark_create")).toHaveLength(0);
  });

  it("편집은 모든 필드를 보낸다 — 폼에 없는 color_hue·첫해도 그대로", async () => {
    list = { marks: [mark({ id: "own", year: 2019, color_hue: 120 })], sources: [], hides: [] };
    render(<DayMarksSection />);
    fireEvent.click(await screen.findByTestId("day-mark-edit-own|2026-05-12"));
    fireEvent.change(screen.getByTestId("day-mark-form-title"), { target: { value: "엄마 생신" } });
    fireEvent.click(screen.getByTestId("day-mark-form-save"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("calendar_mark_update", {
        id: "own",
        title: "엄마 생신",
        year: 2019,
        month: 5,
        day: 12,
        repeat: "yearly",
        lunar: false,
        day_off: false,
        color_hue: 120,
      }),
    );
  });

  it("URL 불러오기: 받아서 종일 일정만 출처로 저장하고, 건너뛴 시각 일정 수를 알린다", async () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:a",
      "DTSTART;VALUE=DATE:20260405",
      "SUMMARY:식목일",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:b",
      "DTSTART:20260405T090000",
      "SUMMARY:회의",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const base = callMock.getMockImplementation()!;
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "calendar_fetch_ics" ? Promise.resolve({ text: ics }) : base(cmd, args),
    );
    render(<DayMarksSection />);
    fireEvent.click(screen.getByTestId("day-marks-import-btn"));
    fireEvent.click(screen.getByRole("radio", { name: "URL" }));
    fireEvent.change(screen.getByTestId("day-marks-import-url"), {
      target: { value: "webcal://calendar.example.org/kr.ics" },
    });
    expect((screen.getByTestId("day-marks-import-name") as HTMLInputElement).value).toBe("calendar.example.org");
    expect(screen.getByTestId("day-marks-import-day-off").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("day-marks-import-submit"));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("calendar_source_save", {
        workspace_id: "ws1",
        name: "calendar.example.org",
        url: "webcal://calendar.example.org/kr.ics",
        marks: [{ uid: "a", title: "식목일", year: 2026, month: 4, day: 5, repeat: "once", day_off: true }],
      }),
    );
    expect(callMock).toHaveBeenCalledWith("calendar_fetch_ics", { url: "webcal://calendar.example.org/kr.ics" });
    await waitFor(() => expect(noticeMock).toHaveBeenCalled());
    const msg = String(noticeMock.mock.calls[noticeMock.mock.calls.length - 1][0]);
    expect(msg).toContain("1개를 불러왔습니다");
    expect(msg).toContain("시각이 있는 일정 1개는 건너뜀");
  });

  // 회귀: "not a url" 같은 못 읽는 주소는 hostOf() 가 ""를 돌려줘 이름 칸도 같이 비어 있다 — 그 상태로
  // 제출하면 진짜 원인(주소)이 아니라 손도 안 댄 이름 칸을 탓하는 문구가 떴다.
  it("URL 칸이 못 읽는 주소면 주소 오류를 먼저 — 손 안 댄 이름 칸을 탓하지 않는다", async () => {
    render(<DayMarksSection />);
    fireEvent.click(screen.getByTestId("day-marks-import-btn"));
    fireEvent.click(screen.getByRole("radio", { name: "URL" }));
    fireEvent.change(screen.getByTestId("day-marks-import-url"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByTestId("day-marks-import-submit"));
    const err = await screen.findByTestId("day-marks-import-error");
    expect(err.textContent).toContain("주소를 입력하세요");
    expect(calls("calendar_fetch_ics")).toHaveLength(0);
    expect(calls("calendar_source_save")).toHaveLength(0);
  });

  it("URL 을 못 받으면 친절한 문구로, 저장은 하지 않는다", async () => {
    const base = callMock.getMockImplementation()!;
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "calendar_fetch_ics" ? Promise.reject(new Error("private address")) : base(cmd, args),
    );
    render(<DayMarksSection />);
    fireEvent.click(screen.getByTestId("day-marks-import-btn"));
    fireEvent.click(screen.getByRole("radio", { name: "URL" }));
    fireEvent.change(screen.getByTestId("day-marks-import-url"), { target: { value: "https://x.test/a.ics" } });
    fireEvent.click(screen.getByTestId("day-marks-import-submit"));
    const err = await screen.findByTestId("day-marks-import-error");
    expect(err.textContent).toContain("캘린더를 받아오지 못했습니다");
    expect(calls("calendar_source_save")).toHaveLength(0);
  });

  it("불러온 캘린더 줄: 개수 · 켜기 토글 · 다시 불러오기(URL 재수신 → 같은 출처 교체)", async () => {
    list = {
      marks: [mark({ id: "imp", source_id: "s1", title: "개교기념일", day_off: false })],
      sources: [SRC],
      hides: [],
    };
    const base = callMock.getMockImplementation()!;
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "calendar_fetch_ics"
        ? Promise.resolve({
            text: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260601\r\nSUMMARY:개교기념일\r\nEND:VEVENT\r\nEND:VCALENDAR",
          })
        : base(cmd, args),
    );
    render(<DayMarksSection />);
    const line = await screen.findByTestId("day-marks-source-s1");
    expect(line.textContent).toContain("학교 달력");
    expect(line.textContent).toContain("1개");

    fireEvent.click(screen.getByTestId("day-marks-source-enable-s1"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("calendar_source_update", { id: "s1", enabled: false }));

    fireEvent.click(screen.getByTestId("day-marks-source-refresh-s1"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("calendar_source_save", {
        workspace_id: "ws1",
        source_id: "s1",
        name: "학교 달력",
        url: SRC.url,
        marks: [{ uid: null, title: "개교기념일", year: 2026, month: 6, day: 1, repeat: "once", day_off: false }],
      }),
    );
  });

  it("다시 불러오기에서 저장(call())이 실패하면 알림을 한 번 더 띄우지 않는다", async () => {
    list = { marks: [mark({ id: "imp", source_id: "s1", title: "개교기념일" })], sources: [SRC], hides: [] };
    const base = callMock.getMockImplementation()!;
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "calendar_fetch_ics") {
        return Promise.resolve({
          text: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260601\r\nSUMMARY:a\r\nEND:VEVENT\r\nEND:VCALENDAR",
        });
      }
      if (cmd === "calendar_source_save") return Promise.reject(new Error("db"));
      return base(cmd, args);
    });
    render(<DayMarksSection />);
    fireEvent.click(await screen.findByTestId("day-marks-source-refresh-s1"));
    await waitFor(() => expect(calls("calendar_source_save")).toHaveLength(1));
    await waitFor(() =>
      expect((screen.getByTestId("day-marks-source-refresh-s1") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it("불러온 캘린더 삭제는 한 번 묻는다", async () => {
    list = { marks: [], sources: [SRC], hides: [] };
    render(<DayMarksSection />);
    fireEvent.click(await screen.findByTestId("day-marks-source-delete-s1"));
    expect(calls("calendar_source_delete")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("calendar_source_delete", { id: "s1" }));
  });
});
