import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { HomeHeader } from "./HomeHeader";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";

// lib/weather(cachedWeather) → lib/invoke (IPC). Soft-fail like HomeTab.test.tsx — irrelevant to
// this header test (no location is resolved below, so nothing is fetched anyway).
vi.mock("../../lib/invoke", () => ({
  call: vi.fn().mockRejectedValue({ code: "IO", message: "test" }),
  callSilent: vi.fn().mockRejectedValue({ code: "IO", message: "test" }),
  registerFlush: () => () => {},
  flushAll: async () => {},
  emitNotice: () => {},
}));

// No location resolved by default (Settings unset, no notes loaded) — WeatherSlot's real
// short-circuit path, exercised here without needing a fetch mock. Individual tests can flip it.
const weatherLoc = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("./useWeatherLocation", () => ({
  useWeatherLocation: () => weatherLoc.value,
}));

describe("HomeHeader layout", () => {
  beforeEach(() => {
    weatherLoc.value = null;
    useSettingsStore.setState({
      uiLang: "en",
    });
    useNotesStore.setState({
      totalNotes: 0,
      noteIndex: new Map(),
      folders: [],
    });
  });

  it("renders col1 (date/time); unfinished chip is gone (2026-08-07)", () => {
    const { getByTestId, queryByTestId } = render(<HomeHeader />);
    expect(getByTestId("home-header-col1")).toBeDefined();
    // useWeatherLocation is mocked to null in this suite (no location resolved) and the unfinished
    // chip was removed outright — the right zone has nothing to show, so it should not render at all.
    expect(queryByTestId("home-header-right")).toBeNull();
    expect(queryByTestId("home-header-unfinished")).toBeNull();
    expect(queryByTestId("home-reminder-bell")).toBeNull();
    expect(getByTestId("home-date").textContent).toBeTruthy();
    expect(getByTestId("home-time").textContent).toBeTruthy();
  });

  // GRILL-2026-10-19 R4·R14: 문구는 브리핑 창으로 이사했다(src/briefing/QuoteLine.tsx) — 대시보드
  // 머리줄에는 가운데 문구 열도, 문구의 복사·새로고침 버튼도 다시 생기지 않는다.
  it("has no phrase column — the quote moved to the briefing window (R4·R14)", () => {
    const { getByTestId, queryByTestId, queryByRole } = render(<HomeHeader />);
    expect(queryByTestId("home-header-left")).toBeNull();
    expect(queryByTestId("home-phrase")).toBeNull();
    expect(queryByRole("button")).toBeNull();
    // 가운데 열을 수학적 중앙에 두던 3열 대칭 그리드도 함께 없어졌다 — 좌/우 두 존의 flex 행.
    const row = getByTestId("home-header-row") as HTMLElement;
    expect(row.style.display).toBe("flex");
    expect(row.style.gridTemplateColumns).toBe("");
  });

  // R14 "비우고 낮춘다": 높이는 노트 타이틀바와 공유하던 --row-header 가 아니라 자기 내용(날씨 박스 ·
  // 날짜+시계 줄높이)의 최댓값이다. 위치가 있으면 날씨 박스 자리를 미리 잡고(비동기 도착 때 출렁임 방지),
  // 없으면 날짜·시계만으로 더 낮다.
  it("height no longer follows --row-header; it is sized by its own content (R14)", () => {
    const { getByTestId, unmount } = render(<HomeHeader />);
    const noLoc = (getByTestId("home-header") as HTMLElement).getAttribute("style") ?? "";
    expect(noLoc).not.toContain("--row-header");
    expect(noLoc).toContain("var(--text-clock)");
    expect(noLoc).not.toContain("36px");
    unmount();

    weatherLoc.value = { lat: 37.5665, lng: 126.978, source: "workspace" };
    const withLoc = (render(<HomeHeader />).getByTestId("home-header") as HTMLElement).getAttribute("style") ?? "";
    expect(withLoc).not.toContain("--row-header");
    // 날씨 박스(비네트 36px + --space-4 ×2 + 테두리) 자리를 예약한다.
    expect(withLoc).toContain("36px");
    expect(withLoc).toContain("var(--text-clock)");
  });

  // 2026-08-15(오너 피드백): 인사말 줄을 걷어내고 순서를 뒤집었다 — 날짜가 위, 시계가 아래.
  // DOM 순서로 그 배치를 고정한다(greeting testid는 더 이상 존재하지 않는다).
  it("date comes before time in DOM order (date on top, clock below)", () => {
    const { getByTestId } = render(<HomeHeader />);
    const position = getByTestId("home-date").compareDocumentPosition(getByTestId("home-time"));
    // eslint-disable-next-line no-bitwise
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("null weather (no resolvable location) still renders date/time — col1 never collapses", () => {
    const { getByTestId, queryByTestId } = render(<HomeHeader />);
    expect(getByTestId("home-header-col1")).toBeDefined();
    expect(getByTestId("home-date").textContent).toBeTruthy();
    expect(getByTestId("home-time").textContent).toBeTruthy();
    expect(queryByTestId("home-weather-group")).toBeNull();
    expect(queryByTestId("weather-vignette")).toBeNull();
  });

  // W6-c: 시계는 --text-2xl 위의 전용 단계(--text-clock)로 한 번 더 커진다 — "시계 1순위"
  // 위계가 값으로 고정된다. 2026-08-15: 인사말(greeting) 줄은 걷어냈다(파일 상단 주석 참고).
  it("time is the largest, date secondary (W6-c hierarchy)", () => {
    const { getByTestId } = render(<HomeHeader />);
    const date = getByTestId("home-date") as HTMLElement;
    const time = getByTestId("home-time") as HTMLElement;
    expect(date.style.fontSize).toBe("var(--text-md)");
    expect(time.style.fontSize).toBe("var(--text-clock)");
    expect(time.className).toContain("home-clock-tick");
  });

  // W7-c(QA §4): 하늘은 날씨칩 박스로 축소됐다(WeatherSlot.test.tsx 가 박스 쪽을 검증한다).
  // 여기서 지키는 건 그 반대쪽 — 헤더 밴드는 배경을 칠하지 않고, --on-sky* 재바인딩도 하지 않으며,
  // 텍스트는 평범한 테마 토큰으로 돌아왔다. 밴드 전체 칠하기로의 조용한 회귀를 막는 테스트다.
  it("band itself paints no gradient and keeps normal theme tokens (W7-c)", () => {
    const { getByTestId } = render(<HomeHeader />);
    const header = getByTestId("home-header") as HTMLElement;
    expect(header.style.background).toBe("");
    expect(header.dataset.skyTone).toBeUndefined();
    expect(header.style.getPropertyValue("--text")).toBe("");
    expect(header.style.getPropertyValue("--on-sky")).toBe("");
    expect(getByTestId("home-time").style.color).toBe("var(--text)");
    expect(getByTestId("home-date").style.color).toBe("var(--muted)");
  });

  // W8-a: 우측 통계 칩(노트/폴더 수)은 정보 가치가 낮다는 오너 피드백으로 완전히 제거됐다 —
  // 그 자리는 날씨 그라데이션 박스(WeatherSlot)가 대신한다. 회귀 방지: 통계 testid가 다시
  // 생기지 않는지만 확인한다(날씨 박스 자체의 렌더링은 WeatherSlot.test.tsx가 지킨다).
  it("no longer renders the removed stats chips", () => {
    useNotesStore.setState({ totalNotes: 7, folders: [] });
    const { queryByTestId } = render(<HomeHeader />);
    expect(queryByTestId("home-header-stats")).toBeNull();
  });

  it("header horizontal padding uses --content-inset to match the note TitleBar (W24)", () => {
    const { getByTestId } = render(<HomeHeader />);
    const header = getByTestId("home-header") as HTMLElement;
    expect(header.style.padding).toContain("var(--content-inset)");
  });
});
