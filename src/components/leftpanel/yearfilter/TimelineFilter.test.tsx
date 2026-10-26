import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { TimelineFilter, EraChips } from "./TimelineFilter";
import { useSearchStore } from "../../../stores/search";
import { useSettingsStore } from "../../../stores/settings";
import { useTaxonomyStore } from "../../../stores/taxonomy";
import { useNotesStore } from "../../../stores/notes";
import { useUiStore } from "../../../stores/ui";
import { useTabsStore, HOME_TAB_ID } from "../../../stores/tabs";
import { t } from "../../../i18n/t";
import type { NoteSummary } from "../../../lib/commands.gen";

function note(partial: Partial<NoteSummary> & { id: string; year: number }): NoteSummary {
  return {
    folder_id: "f1",
    title: partial.title ?? partial.id,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    month: null,
    day: null,
    ...partial,
  };
}

function seedNotes(notes: NoteSummary[]) {
  useNotesStore.setState({ noteIndex: new Map(notes.map((n) => [n.id, n])) });
}

/** Range-readout span: font-variant-numeric is the marker already used to find it elsewhere. */
function rangeLabelText(container: HTMLElement): string {
  const span = container.querySelector(
    "span[style*='font-variant-numeric'], span[style*='fontVariantNumeric']",
  ) as HTMLElement | null;
  return span?.textContent ?? "";
}

/** Real store action — restored each test so spies never leak. */
const realSetYearRange = useSearchStore.getState().setYearRange;

/** Spread counts so the density strip renders across the full axis. */
function denseCounts(min: number, max: number, step = 10): Record<number, number> {
  const out: Record<number, number> = {};
  for (let y = min; y <= max; y += step) out[y] = 2;
  return out;
}

describe("TimelineFilter", () => {
  beforeEach(() => {
    useSearchStore.setState({
      yearFrom: 1800,
      yearTo: 1900,
      yearBounds: { min: 1000, max: 2000 },
      yearCounts: {},
      setYearRange: realSetYearRange,
    });
    // Stable tick geometry: trackWidth = 308 - 44 = 264 → 40-year span gets step 10.
    useSettingsStore.setState({ leftWidth: 308, fontScale: 1 });
    // Range-readout tests seed this explicitly; everything else expects an empty corpus.
    useNotesStore.setState({ noteIndex: new Map() });
  });

  it("spies on setYearRange: mousedown on 'from' handle, 3 mousemove events call setYearRange 0 times; mouseup calls setYearRange EXACTLY ONCE with final value", () => {
    const spy = vi.fn();
    useSearchStore.setState({ setYearRange: spy });

    const { getByTitle } = render(<TimelineFilter />);
    const fromHandle = getByTitle("from");

    const trackElement = fromHandle.closest("[data-testid='timeline-brush']")!;
    vi.spyOn(trackElement, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 100,
      right: 100,
      top: 0,
      bottom: 46,
      height: 46,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Mousedown on "from" handle at 80% (1800)
    fireEvent.mouseDown(fromHandle, { clientX: 80 });
    expect(spy).toHaveBeenCalledTimes(0);

    // Mousemove 1 (clientX = 50 -> dx = -30 -> yr = 1800 - 300 = 1500). buttons: 1 models the left
    // button actually held down through the drag.
    fireEvent.mouseMove(document, { clientX: 50, buttons: 1 });
    expect(spy).toHaveBeenCalledTimes(0);

    // Mousemove 2 (clientX = 60 -> yr = 1600)
    fireEvent.mouseMove(document, { clientX: 60, buttons: 1 });
    expect(spy).toHaveBeenCalledTimes(0);

    // Mousemove 3 (clientX = 70 -> yr = 1700)
    fireEvent.mouseMove(document, { clientX: 70, buttons: 1 });
    expect(spy).toHaveBeenCalledTimes(0);

    // Mouseup
    fireEvent.mouseUp(document);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(1700, 1900);
  });

  it("mousedown -> mousemove -> mouseup with track width mocked to 0 asserts setYearRange is never called with NaN", () => {
    const spy = vi.fn();
    useSearchStore.setState({ setYearRange: spy });

    const { getByTitle } = render(<TimelineFilter />);
    const fromHandle = getByTitle("from");

    const trackElement = fromHandle.closest("[data-testid='timeline-brush']")!;
    vi.spyOn(trackElement, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 0,
      right: 0,
      top: 0,
      bottom: 46,
      height: 46,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fireEvent.mouseDown(fromHandle, { clientX: 80 });
    fireEvent.mouseMove(document, { clientX: 50, buttons: 1 });
    fireEvent.mouseUp(document);

    expect(spy).not.toHaveBeenCalledWith(expect.anything(), NaN);
    expect(spy).not.toHaveBeenCalledWith(NaN, expect.anything());
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it("regression: onUp is a no-op when no drag is in progress — a stray mouseup after a completed drag does not double-commit", () => {
    const spy = vi.fn();
    useSearchStore.setState({ setYearRange: spy });

    const { getByTitle } = render(<TimelineFilter />);
    const fromHandle = getByTitle("from");
    const trackElement = fromHandle.closest("[data-testid='timeline-brush']")!;
    vi.spyOn(trackElement, "getBoundingClientRect").mockReturnValue({
      left: 0, width: 100, right: 100, top: 0, bottom: 46, height: 46, x: 0, y: 0, toJSON: () => {},
    });

    // A normal, complete drag: mousedown at 80%, move to 50% (1500), real mouseup.
    fireEvent.mouseDown(fromHandle, { clientX: 80 });
    fireEvent.mouseMove(document, { clientX: 50, buttons: 1 }); // drag toward 1500
    fireEvent.mouseUp(document);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(1500, 1900);

    // A later, unrelated mouseup elsewhere in the app must not re-fire the commit.
    fireEvent.mouseDown(document.body);
    fireEvent.mouseUp(document.body);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("regression: a stray mousemove with no button held (button already released) self-heals the drag instead of leaving it stuck", () => {
    const spy = vi.fn();
    useSearchStore.setState({ setYearRange: spy });

    const { getByTitle } = render(<TimelineFilter />);
    const fromHandle = getByTitle("from");
    const trackElement = fromHandle.closest("[data-testid='timeline-brush']")!;
    vi.spyOn(trackElement, "getBoundingClientRect").mockReturnValue({
      left: 0, width: 100, right: 100, top: 0, bottom: 46, height: 46, x: 0, y: 0, toJSON: () => {},
    });

    fireEvent.mouseDown(fromHandle, { clientX: 80 });
    fireEvent.mouseMove(document, { clientX: 50, buttons: 1 }); // drag toward 1500 (button held)
    expect(document.body.style.cursor).toBe("ew-resize");

    // Button no longer held (buttons defaults to 0) — this is the first move after a lost mouseup.
    fireEvent.mouseMove(document, { clientX: 5 });

    // Self-healed: committed the last known drag position, cursor released.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(1500, 1900);
    expect(document.body.style.cursor).toBe("");

    // A further unrelated click must not double-commit.
    fireEvent.mouseDown(document.body);
    fireEvent.mouseUp(document.body);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("year readout element carries fontVariantNumeric 'tabular-nums'", () => {
    const { container } = render(<TimelineFilter />);
    const span = container.querySelector("span[style*='font-variant-numeric'], span[style*='fontVariantNumeric']");
    expect(span).not.toBeNull();
    expect((span as HTMLElement).style.fontVariantNumeric).toBe("tabular-nums");
  });

  it("brushing with handles narrows the filter range", () => {
    useSearchStore.setState({
      yearFrom: 1000,
      yearTo: 2000,
      yearBounds: { min: 1000, max: 2000 },
      yearCounts: denseCounts(1000, 2000),
    });

    const { getByTitle } = render(<TimelineFilter />);
    const fromHandle = getByTitle("from");
    const trackElement = fromHandle.closest("[data-testid='timeline-brush']")!;
    vi.spyOn(trackElement, "getBoundingClientRect").mockReturnValue({
      left: 0, width: 200, right: 200, top: 0, bottom: 46, height: 46, x: 0, y: 0, toJSON: () => {},
    });

    fireEvent.mouseDown(fromHandle);
    fireEvent.mouseMove(document, { clientX: 160, buttons: 1 });
    fireEvent.mouseUp(document);

    const s = useSearchStore.getState();
    expect(s.yearFrom).toBeGreaterThanOrEqual(1790);
    expect(s.yearTo).toBe(2000);
  });

  it("reset restores the full domain and the full range", () => {
    useSearchStore.setState({
      yearFrom: 1200,
      yearTo: 1800,
      yearBounds: { min: 1000, max: 2000 },
      yearCounts: denseCounts(1000, 2000),
    });

    render(<TimelineFilter />);
    const reset = screen.getByRole("button", { name: /show all|voir tout|전체로/i });
    fireEvent.click(reset);

    expect(useSearchStore.getState().yearFrom).toBe(1000);
    expect(useSearchStore.getState().yearTo).toBe(2000);

    // Reset control gone once domain is full again.
    expect(screen.queryByRole("button", { name: /show all|voir tout|전체로/i })).toBeNull();
  });

  it("brushing a 1-year width clamps to the minimum domain; no NaN/Infinity reaches setYearRange", () => {
    const spy = vi.fn((from: number, to: number) => {
      useSearchStore.setState({ yearFrom: from, yearTo: to });
    });
    useSearchStore.setState({
      yearFrom: 1000,
      yearTo: 2000,
      yearBounds: { min: 1000, max: 2000 },
      yearCounts: denseCounts(1000, 2000),
      setYearRange: spy,
    });

    const { getByTitle } = render(<TimelineFilter />);
    const fromHandle = getByTitle("from");
    const trackElement = fromHandle.closest("[data-testid='timeline-brush']")!;
    vi.spyOn(trackElement, "getBoundingClientRect").mockReturnValue({
      left: 0, width: 200, right: 200, top: 0, bottom: 46, height: 46, x: 0, y: 0, toJSON: () => {},
    });

    fireEvent.mouseDown(fromHandle);
    fireEvent.mouseMove(document, { clientX: 100, buttons: 1 });
    fireEvent.mouseUp(document);

    expect(spy).toHaveBeenCalled();
    for (const [from, to] of spy.mock.calls) {
      expect(Number.isFinite(from)).toBe(true);
      expect(Number.isFinite(to)).toBe(true);
      expect(from).not.toBe(Infinity);
      expect(to).not.toBe(Infinity);
      expect(to - from).toBeGreaterThanOrEqual(1);
      expect(from).toBeGreaterThanOrEqual(1000);
      expect(to).toBeLessThanOrEqual(2000);
    }
  });

  it("selecting an era chip whose stored range exceeds the corpus keeps handles on the track (0–100%)", () => {
    useSearchStore.setState({
      yearFrom: 1000,
      yearTo: 2000,
      yearBounds: { min: 1000, max: 2000 },
      yearCounts: denseCounts(1000, 2000),
      setYearRange: realSetYearRange,
    });
    useTaxonomyStore.setState({
      eras: [
        {
          id: "era-wide",
          workspace_id: "ws",
          name: "Far future",
          from_year: 500,
          to_year: 5000,
          position: 0,
        },
      ],
    });

    // TimelineFilter 는 상단 범위 버튼을 클릭해 팝오버 메뉴 내에서 EraChips 를 연다.
    const { getByTitle, getByTestId, getByText } = render(<TimelineFilter />);
    fireEvent.click(getByTestId("timeline-range-readout-btn"));
    fireEvent.click(getByTestId("timeline-era-select"));
    fireEvent.click(getByText(/Far future/));

    const s = useSearchStore.getState();
    expect(s.yearFrom).toBe(1000);
    expect(s.yearTo).toBe(2000);

    const fromLeft = parseFloat((getByTitle("from") as HTMLElement).style.left);
    const toLeft = parseFloat((getByTitle("to") as HTMLElement).style.left);
    expect(fromLeft).toBeGreaterThanOrEqual(0);
    expect(fromLeft).toBeLessThanOrEqual(100);
    expect(toLeft).toBeGreaterThanOrEqual(0);
    expect(toLeft).toBeLessThanOrEqual(100);
    // Full corpus after clamp → handles at the ends.
    expect(fromLeft).toBe(0);
    expect(toLeft).toBe(100);
  });

  it("era dropdown shows remove action in options and calls removeEra", async () => {
    const removeEra = vi.fn();
    useSearchStore.setState({
      yearFrom: 1000,
      yearTo: 2000,
      yearBounds: { min: 1000, max: 2000 },
      setYearRange: realSetYearRange,
    });
    useTaxonomyStore.setState({
      eras: [
        {
          id: "era-1",
          workspace_id: "ws",
          name: "Choson",
          from_year: 1392,
          to_year: 1897,
          position: 0,
        },
      ],
      removeEra,
    });

    const { getByTestId, getByLabelText } = render(<EraChips />);
    fireEvent.click(getByTestId("timeline-era-select"));

    const removeBtn = getByLabelText(/Choson 삭제|Remove Choson|Supprimer Choson/i);
    expect(removeBtn).toBeDefined();
    fireEvent.click(removeBtn);
    expect(removeEra).toHaveBeenCalledWith("era-1");
  });

  it("commitAdd clamps a partial overshoot into bounds and still rejects to <= from", async () => {
    const addEra = vi.fn().mockResolvedValue({
      id: "e1",
      name: "Modern",
      from_year: 1800,
      to_year: 2000,
    });
    useSearchStore.setState({
      yearFrom: 1000,
      yearTo: 2000,
      yearBounds: { min: 1000, max: 2000 },
      setYearRange: realSetYearRange,
    });
    useTaxonomyStore.setState({ eras: [], addEra });

    render(<EraChips />);
    fireEvent.click(screen.getByRole("button", { name: /add period|ajouter une période|기간 추가/i }));

    const nameInput = screen.getByPlaceholderText(/period name|nom de la période|기간 이름/i);
    const fromInput = screen.getByPlaceholderText(/from|de|시작/i);
    const toInput = screen.getByPlaceholderText(/to|à|종료/i);

    fireEvent.change(nameInput, { target: { value: "Modern" } });
    fireEvent.change(fromInput, { target: { value: "1800" } });
    fireEvent.change(toInput, { target: { value: "5000" } });
    fireEvent.keyDown(toInput, { key: "Enter" });

    expect(addEra).toHaveBeenCalledWith("Modern", 1800, 2000);

    // Re-open and try inverted range.
    addEra.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /add period|ajouter une période|기간 추가/i }));
    const name2 = screen.getByPlaceholderText(/period name|nom de la période|기간 이름/i);
    const from2 = screen.getByPlaceholderText(/from|de|시작/i);
    const to2 = screen.getByPlaceholderText(/to|à|종료/i);
    fireEvent.change(name2, { target: { value: "Bad" } });
    fireEvent.change(from2, { target: { value: "1900" } });
    fireEvent.change(to2, { target: { value: "1800" } });
    fireEvent.keyDown(to2, { key: "Enter" });

    expect(addEra).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/after|après|커야/i);
  });

  it("commitAdd refuses a range that collapses entirely outside the corpus", () => {
    const addEra = vi.fn();
    useSearchStore.setState({
      yearFrom: 1000,
      yearTo: 2000,
      yearBounds: { min: 1000, max: 2000 },
    });
    useTaxonomyStore.setState({ eras: [], addEra });

    render(<EraChips />);
    fireEvent.click(screen.getByRole("button", { name: /add period|ajouter une période|기간 추가/i }));
    fireEvent.change(screen.getByPlaceholderText(/period name|nom de la période|기간 이름/i), {
      target: { value: "Future" },
    });
    fireEvent.change(screen.getByPlaceholderText(/from|de|시작/i), {
      target: { value: "3000" },
    });
    fireEvent.change(screen.getByPlaceholderText(/to|à|종료/i), {
      target: { value: "4000" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText(/to|à|종료/i), { key: "Enter" });

    expect(addEra).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/1000|2000/);
  });
});

/* 오너 QA7 후속으로 계약이 뒤집혔다. 예전에는 이 라벨이 noteIndex 를 전수 스캔해 얻은
   **이벤트 날짜** 구간("1592.07.13 – 1650.03.02")을 보여줬다. 그런데 라벨을 클릭해 열리는
   편집 팝오버는 yearFrom/yearTo(연도)를 넣으므로, 화면의 숫자와 편집 값이 서로 다른 수를
   가리켰다 — 오너가 "조절하려고 클릭하면 버그"라고 보고한 그것이다. 필터 모델 자체가 연도
   단위(setYearRange(int,int))라 날짜 라벨은 왕복이 불가능하다.
   새 계약: **보이는 값 = 손잡이 위치 = 편집 팝오버가 채우는 값**, 셋 다 필터 연도 범위.
   대시보드 타임라인 헤더(timeline-range-readout)와 같은 규칙이다. */
describe("TimelineFilter range readout (filter year range)", () => {
  beforeEach(() => {
    useSearchStore.setState({
      yearBounds: { min: 1000, max: 2000 },
      yearCounts: {},
      setYearRange: realSetYearRange,
    });
    useSettingsStore.setState({ leftWidth: 308, fontScale: 1 });
    useNotesStore.setState({ noteIndex: new Map() });
  });

  it("readout is the selected year range, not the notes' event dates", () => {
    seedNotes([
      note({ id: "a", year: 1592, month: 7, day: 13 }),
      note({ id: "b", year: 1650, month: 3, day: 2 }),
    ]);
    useSearchStore.setState({ yearFrom: 1500, yearTo: 1700 });
    const { container } = render(<TimelineFilter />);
    expect(rangeLabelText(container)).toBe("1500 – 1700");
  });

  it("an empty range still reads as its own years (no corpus scan behind the label)", () => {
    useSearchStore.setState({ yearFrom: 1800, yearTo: 1900 });
    const { container } = render(<TimelineFilter />);
    expect(rangeLabelText(container)).toBe("1800 – 1900");
  });

  it("from === to collapses to a single year", () => {
    useSearchStore.setState({ yearFrom: 1592, yearTo: 1592 });
    const { container } = render(<TimelineFilter />);
    expect(rangeLabelText(container)).toBe("1592");
  });

  it("padded full-range axis: readout names the real note years, not the padding (2026-10-10)", () => {
    // applyYearCounts({2026:1,2027:3}) → data 2026–2027, axis padYearRange → 2025–2028.
    // 패딩은 손잡이·눈금이 트랙 끝에 붙지 않게 하는 화면 틀이지 노트가 있는 해가 아니다 —
    // 예전 라벨 "2025 – 2028" 은 노트 없는 해를 이름에 넣어 오너가 "이상하다"고 짚었다.
    useSearchStore.getState().applyYearCounts({ 2026: 1, 2027: 3 });
    const b = useSearchStore.getState().yearBounds;
    expect(b.padded).toBe(true);
    expect(b.min).toBe(2025);
    expect(b.max).toBe(2028);
    expect(useSearchStore.getState().yearFrom).toBe(2025);
    expect(useSearchStore.getState().yearTo).toBe(2028);

    const { container, queryByTestId } = render(<TimelineFilter />);
    expect(rangeLabelText(container)).toBe("2026 – 2027");
    expect(queryByTestId("timeline-filter-reach")).toBeNull();
  });

  it("padded full range: edit dialog opens on the shown years and confirming them keeps 'all'", () => {
    useSearchStore.getState().applyYearCounts({ 2026: 1, 2027: 3 });
    const { getByTestId, getByPlaceholderText, getByText } = render(<TimelineFilter />);
    fireEvent.click(getByTestId("timeline-range-readout-btn"));
    expect((getByPlaceholderText(/from|de|시작/i) as HTMLInputElement).value).toBe("2026");
    expect((getByPlaceholderText(/to|à|종료/i) as HTMLInputElement).value).toBe("2027");
    fireEvent.click(getByText(/^(OK|확인|Confirmer|Add|추가|Ajouter)$/i));
    // 데이터 양끝을 그대로 확인하면 축 전체로 넓힌다 — 안 그러면 같은 노트인데 "필터 걸림"이 된다.
    expect(useSearchStore.getState().yearFrom).toBe(2025);
    expect(useSearchStore.getState().yearTo).toBe(2028);
  });

  it("a range inside the data reads as-is", () => {
    useSearchStore.getState().applyYearCounts({ 1900: 1, 2000: 1 });
    useSearchStore.setState({ yearFrom: 1950, yearTo: 1960 });
    const { container } = render(<TimelineFilter />);
    expect(rangeLabelText(container)).toBe("1950 – 1960");
  });

  it("readout and the edit dialog always name the same numbers (QA7 클릭 버그 회귀 가드)", () => {
    seedNotes([note({ id: "a", year: 1592, month: 7, day: 13 })]);
    useSearchStore.setState({ yearFrom: 1590, yearTo: 1600 });
    const { container, getByTestId, getByPlaceholderText } = render(<TimelineFilter />);

    expect(rangeLabelText(container)).toBe("1590 – 1600");
    fireEvent.click(getByTestId("timeline-range-readout-btn"));
    expect((getByPlaceholderText(/from|de|시작/i) as HTMLInputElement).value).toBe("1590");
    expect((getByPlaceholderText(/to|à|종료/i) as HTMLInputElement).value).toBe("1600");
  });

  it("open-dashboard button (크게보기) sits on the readout row and routes to the dashboard timeline", () => {
    const setHomeInnerTab = vi.fn();
    const setActiveTab = vi.fn();
    useUiStore.setState({ setHomeInnerTab });
    useTabsStore.setState({ setActiveTab });

    const { getByTestId } = render(<TimelineFilter />);
    fireEvent.click(getByTestId("timeline-open-dashboard"));

    expect(setHomeInnerTab).toHaveBeenCalledWith("timeline");
    expect(setActiveTab).toHaveBeenCalledWith(HOME_TAB_ID);
  });

  it("clicking the range readout button opens direct range edit dialog and commits new range", () => {
    useSearchStore.setState({ yearFrom: 1500, yearTo: 1700 });
    const { getByTestId, getByPlaceholderText, getByText } = render(<TimelineFilter />);

    const btn = getByTestId("timeline-range-readout-btn");
    fireEvent.click(btn);

    const dialog = getByTestId("timeline-range-edit-dialog");
    expect(dialog).toBeDefined();

    const fromInput = getByPlaceholderText(t("search.era_from_placeholder"));
    const toInput = getByPlaceholderText(t("search.era_to_placeholder"));

    fireEvent.change(fromInput, { target: { value: "1550" } });
    fireEvent.change(toInput, { target: { value: "1650" } });

    const confirmBtn = getByText(t("search.era_confirm"));
    fireEvent.click(confirmBtn);

    expect(useSearchStore.getState().yearFrom).toBe(1550);
    expect(useSearchStore.getState().yearTo).toBe(1650);
  });

  // 기간(era) 선택 UI 는 EraChips 한 벌뿐 — 좌측 필터도 대시보드 헤더와 같은 드롭다운을 마운트한다.
  it("mounts the shared era dropdown; picking an era applies its range", () => {
    useTaxonomyStore.setState({
      eras: [{ id: "era-1", workspace_id: "ws", name: "조선시대", from_year: 1392, to_year: 1897, position: 0 }],
    });
    useSearchStore.setState({ yearFrom: 1000, yearTo: 2000, setYearRange: realSetYearRange });
    const { getByTestId, getByText } = render(<TimelineFilter />);

    fireEvent.click(getByTestId("timeline-range-readout-btn"));
    fireEvent.click(getByTestId("timeline-era-select"));
    fireEvent.click(getByText(/조선시대/));

    expect(useSearchStore.getState().yearFrom).toBe(1392);
    expect(useSearchStore.getState().yearTo).toBe(1897);
  });
});
