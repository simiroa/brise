import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSettingsStore } from "../../stores/settings";
import { SwitchGrid, SWITCH_GRID_COLUMNS, type SwitchGridItem } from "./SwitchGrid";
import { MetricTileGroup, MetricTile, type MetricTileItem } from "./MetricTileGroup";
import { StorageGauge } from "./StorageGauge";

describe("Challenger 1 M1: Common Components Adversarial Challenge", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "ko" });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * 1. StorageGauge Stress Tests & Boundary Conditions
   * ───────────────────────────────────────────────────────────────────────── */
  describe("StorageGauge Adversarial Challenges", () => {
    it("handles totalBytes = 0 without division by zero or NaN", () => {
      render(
        <StorageGauge
          usedBytes={0}
          totalBytes={0}
          breakdownText="0B 사용됨"
          testId="zero-storage"
        />
      );

      // PLAN-2026-09-15 D7: 분모를 모르면 바 없이 숫자만.
      expect(screen.queryByTestId("zero-storage-bar")).toBeNull();

      const ratio = screen.getByTestId("zero-storage-ratio");
      expect(ratio.textContent).toBe("0 KB");
    });

    it("handles totalBytes = 0 with positive usedBytes safely", () => {
      render(
        <StorageGauge
          usedBytes={1024 * 1024}
          totalBytes={0}
          breakdownText="정원 미설정"
          testId="zero-denom-positive-num"
        />
      );

      expect(screen.queryByTestId("zero-denom-positive-num-bar")).toBeNull();

      const ratio = screen.getByTestId("zero-denom-positive-num-ratio");
      expect(ratio.textContent).toBe("1 MB");
    });

    it("clamps negative usedBytes to 0% progress", () => {
      render(
        <StorageGauge
          usedBytes={-5000}
          totalBytes={10000}
          breakdownText="음수 사용량"
          testId="negative-used"
        />
      );

      const bar = screen.getByTestId("negative-used-bar");
      expect(bar.style.width).toBe("0%");
      expect(bar.getAttribute("aria-valuenow")).toBe("0");
    });

    it("clamps usedBytes > totalBytes (overflow) to 100% progress without layout explosion", () => {
      render(
        <StorageGauge
          usedBytes={200000}
          totalBytes={10000}
          breakdownText="용량 초과 상태"
          testId="overflow-used"
        />
      );

      const bar = screen.getByTestId("overflow-used-bar");
      expect(bar.style.width).toBe("100%");
      expect(bar.getAttribute("aria-valuenow")).toBe("100");
    });

    it("handles floating-point bytes with precision rounding", () => {
      const usedBytes = 123456.789;
      const totalBytes = 987654.321;
      const expectedRatio = usedBytes / totalBytes; // ~12.49999%
      const expectedPercent = Math.min(100, Math.max(0, expectedRatio * 100));

      render(
        <StorageGauge
          usedBytes={usedBytes}
          totalBytes={totalBytes}
          breakdownText="부동 소수점 바이트"
          testId="float-storage"
        />
      );

      const bar = screen.getByTestId("float-storage-bar");
      expect(bar.style.width).toBe(`${expectedPercent}%`);
      expect(bar.getAttribute("aria-valuenow")).toBe(String(Math.round(expectedPercent)));

      const ratio = screen.getByTestId("float-storage-ratio");
      expect(ratio.textContent).toContain("KB");
    });

    it("prefers explicit ratioText when provided regardless of byte values", () => {
      render(
        <StorageGauge
          usedBytes={999999}
          totalBytes={999999}
          breakdownText="사용자 지정 라벨"
          ratioText="99.9% 사용 중 (경고)"
          testId="custom-ratio"
        />
      );

      const ratio = screen.getByTestId("custom-ratio-ratio");
      expect(ratio.textContent).toBe("99.9% 사용 중 (경고)");
    });

    it("handles infinite usedBytes gracefully by clamping to 100%", () => {
      render(
        <StorageGauge
          usedBytes={Infinity}
          totalBytes={1024 * 1024}
          breakdownText="무한대 사용량"
          testId="infinity-storage"
        />
      );

      const bar = screen.getByTestId("infinity-storage-bar");
      expect(bar.style.width).toBe("100%");
      expect(bar.getAttribute("aria-valuenow")).toBe("100");
    });

    it("handles negative totalBytes safely without negative width or crash", () => {
      render(
        <StorageGauge
          usedBytes={100}
          totalBytes={-500}
          breakdownText="음수 정원"
          testId="negative-total"
        />
      );

      expect(screen.queryByTestId("negative-total-bar")).toBeNull();
      expect(screen.getByTestId("negative-total-ratio").textContent).toBe("1 KB");
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * 2. SwitchGrid columns — 나머지 경계 조건은 SwitchGrid.test.tsx 가 본다
   * ───────────────────────────────────────────────────────────────────────── */
  describe("SwitchGrid columns Adversarial Challenges", () => {
    it("renders empty item array gracefully without throwing", () => {
      render(<SwitchGrid items={[]} aria-label="empty" data-testid="empty-grid" columns={2} />);
      const grid = screen.getByTestId("empty-grid");
      expect(grid.children.length).toBe(0);
      expect(grid.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    });

    it("supports 1 and 3 columns and falls back to auto-fit when columns is 0", () => {
      const items: SwitchGridItem[] = [
        { id: "c1", label: "Col 1", checked: true, onChange: vi.fn() },
        { id: "c2", label: "Col 2", checked: false, onChange: vi.fn() },
        { id: "c3", label: "Col 3", checked: true, onChange: vi.fn() },
      ];

      const { rerender } = render(<SwitchGrid items={items} aria-label="g" columns={1} />);
      expect(screen.getByTestId("switch-grid").style.gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))");

      rerender(<SwitchGrid items={items} aria-label="g" columns={3} />);
      expect(screen.getByTestId("switch-grid").style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");

      rerender(<SwitchGrid items={items} aria-label="g" columns={0} />);
      expect(screen.getByTestId("switch-grid").style.gridTemplateColumns).toBe(SWITCH_GRID_COLUMNS);
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * 3. MetricTileGroup Stress Tests & Boundary Conditions
   * ───────────────────────────────────────────────────────────────────────── */
  describe("MetricTileGroup Adversarial Challenges", () => {
    it("renders empty tiles array gracefully without throwing", () => {
      render(<MetricTileGroup tiles={[]} testId="empty-metric-group" />);
      const group = screen.getByTestId("empty-metric-group");
      expect(group).toBeTruthy();
      expect(group.children.length).toBe(0);
    });

    it("supports custom columns configurations (1, 2, 4, 5)", () => {
      const tiles: MetricTileItem[] = [
        { id: "t1", icon: <span>1</span>, value: 100, label: "항목 1" },
        { id: "t2", icon: <span>2</span>, value: 200, label: "항목 2" },
      ];

      const { rerender } = render(
        <MetricTileGroup tiles={tiles} columns={1} testId="metric-1col" />
      );
      expect(screen.getByTestId("metric-1col").style.gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))");

      rerender(<MetricTileGroup tiles={tiles} columns={2} testId="metric-2col" />);
      expect(screen.getByTestId("metric-2col").style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");

      rerender(<MetricTileGroup tiles={tiles} columns={4} testId="metric-4col" />);
      expect(screen.getByTestId("metric-4col").style.gridTemplateColumns).toBe("repeat(4, minmax(0, 1fr))");

      rerender(<MetricTileGroup tiles={tiles} columns={5} testId="metric-5col" />);
      expect(screen.getByTestId("metric-5col").style.gridTemplateColumns).toBe("repeat(5, minmax(0, 1fr))");
    });

    it("handles missing subtext and empty string subtext cleanly without empty DOM nodes", () => {
      const tileWithoutSubtext: MetricTileItem = {
        id: "no-sub",
        icon: <span>📌</span>,
        value: 42,
        label: "서브텍스트 없음",
      };
      const tileWithEmptySubtext: MetricTileItem = {
        id: "empty-sub",
        icon: <span>📌</span>,
        value: 84,
        label: "빈 서브텍스트",
        subtext: "",
      };
      const tileWithSubtext: MetricTileItem = {
        id: "has-sub",
        icon: <span>📌</span>,
        value: 126,
        label: "서브텍스트 있음",
        subtext: "상세 설명입니다.",
      };

      render(
        <MetricTileGroup
          tiles={[tileWithoutSubtext, tileWithEmptySubtext, tileWithSubtext]}
          testId="subtext-test-group"
        />
      );

      expect(screen.getByText("상세 설명입니다.")).toBeTruthy();

      const noSubEl = screen.getByTestId("metric-tile-no-sub");
      // Should only contain icon, value, and label (no 4th element for subtext)
      const textContainerNoSub = noSubEl.children[1];
      expect(textContainerNoSub.children.length).toBe(2);

      const emptySubEl = screen.getByTestId("metric-tile-empty-sub");
      const textContainerEmptySub = emptySubEl.children[1];
      expect(textContainerEmptySub.children.length).toBe(2);

      const hasSubEl = screen.getByTestId("metric-tile-has-sub");
      const textContainerHasSub = hasSubEl.children[1];
      expect(textContainerHasSub.children.length).toBe(3);
    });

    it("handles numeric vs string values (0, negative, float, string formatting)", () => {
      const tiles: MetricTileItem[] = [
        { id: "zero-val", icon: <span data-testid="icon-zero">#</span>, value: 0, label: "숫자 영" },
        { id: "neg-val", icon: <span>-</span>, value: -15, label: "음수 값" },
        { id: "float-val", icon: <span>.</span>, value: 99.98, label: "부동 소수점" },
        { id: "str-val", icon: <span>S</span>, value: "1,024건", label: "문자열 값" },
        { id: "empty-val", icon: <span>E</span>, value: "", label: "빈 문자열" },
      ];

      render(<MetricTileGroup tiles={tiles} columns={5} testId="values-group" />);

      // Crucial test: value 0 must be rendered as text "0", not omitted as falsy
      expect(screen.getByText("0")).toBeTruthy();
      expect(screen.getByText("-15")).toBeTruthy();
      expect(screen.getByText("99.98")).toBeTruthy();
      expect(screen.getByText("1,024건")).toBeTruthy();
      expect(screen.getByTestId("metric-tile-empty-val")).toBeTruthy();
    });

    it("renders standalone MetricTile with zero value and verifies DOM structure", () => {
      render(
        <MetricTile
          tile={{
            id: "standalone-zero",
            icon: <span>⚡</span>,
            value: 0,
            label: "단독 타일 영",
            subtext: "서브 설명",
            testId: "custom-standalone-tile",
          }}
        />
      );

      expect(screen.getByTestId("custom-standalone-tile")).toBeTruthy();
      expect(screen.getByText("0")).toBeTruthy();
      expect(screen.getByText("단독 타일 영")).toBeTruthy();
      expect(screen.getByText("서브 설명")).toBeTruthy();
    });
  });
});
