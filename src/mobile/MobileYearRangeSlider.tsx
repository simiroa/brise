import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useSearchStore } from "../stores/search";
import { t } from "../i18n/t";
import {
  yearRangeLabel,
  isFullYearRange,
  yearDensity,
  densityMarkWidth,
  yearAtFraction,
  nearestYearHandle,
  moveYearHandle,
  expandToYearAxis,
} from "../components/leftpanel/yearfilter/yearAxis";

type Range = { from: number; to: number };

/**
 * 폰 타임라인 상단의 연도 **범위** 슬라이더 — 데스크톱 TimelineFilter 와 같은 축
 * (`useSearchStore.yearFrom/yearTo` · `setYearRange`)이고 같은 순수 헬퍼(yearAxis.ts)를 쓴다.
 *
 * 터치: 트랙 전체(높이 48px)가 한 히트존이다. 닿은 자리에서 가까운 손잡이를 잡고(nearestYearHandle)
 * 포인터 캡처로 끌며, 손을 뗄 때 한 번만 setYearRange 한다(끄는 동안 note_query 를 쏘지 않는다).
 * 손잡이마다 히트박스를 두지 않는 이유는 yearAxis.ts::nearestYearHandle 주석. `touch-action: none`
 * 은 이 띠에만 걸려 아래 목록의 세로 스크롤과 다투지 않는다.
 *
 * `trailing` = 머리 줄 오른쪽 끝 자리(타임라인의 연도 점프 버튼 — 범위가 아니라 스크롤 보조).
 *
 * ponytail: 데스크톱의 축 줌·기간(era) 프리셋·직접 입력은 없다 — 프리셋은 필터 시트의
 * MobileYearChips 가 같은 setYearRange 로 맡는다. 수백 년 축이면 1px ≈ 수 년이라 정밀 지정이
 * 어렵다; 필요해지면 손잡이 키보드(←/→ 1년)처럼 ±1 스텝 버튼을 라벨 옆에 다는 게 업그레이드 경로.
 */
export function MobileYearRangeSlider({ trailing }: { trailing?: ReactNode }) {
  const bounds = useSearchStore((s) => s.yearBounds);
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const yearCounts = useSearchStore((s) => s.yearCounts);
  const setYearRange = useSearchStore((s) => s.setYearRange);

  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ handle: "from" | "to"; pointerId: number } | null>(null);
  const [draft, setDraftState] = useState<Range | null>(null);
  // 손을 뗄 때 읽을 최신 초안 — 상태 클로저는 마지막 move 를 아직 못 봤을 수 있다.
  const draftRef = useRef<Range | null>(null);
  const setDraft = (next: Range | null) => {
    draftRef.current = next;
    setDraftState(next);
  };

  const view: Range = draft ?? { from: yearFrom, to: yearTo };
  const span = bounds.max - bounds.min;
  const pct = (y: number) => (span > 0 ? ((y - bounds.min) / span) * 100 : 0);
  const full = isFullYearRange(view.from, view.to, bounds);
  const label = yearRangeLabel(view.from, view.to, bounds);
  const marks = yearDensity(yearCounts, bounds.min, bounds.max);

  const yearAt = (clientX: number): number | null => {
    const rail = railRef.current;
    if (!rail) return null;
    const rect = rail.getBoundingClientRect();
    if (!(rect.width > 0)) return null;
    return yearAtFraction((clientX - rect.left) / rect.width, bounds.min, bounds.max);
  };

  const commit = (next: Range, expand = false) => {
    // U-9: 라벨은 데이터 연도로 잘려 보이므로 끌어서 데이터 끝에 닿은 손잡이는 축 끝(패딩 포함)으로 확정한다.
    // 키보드 ±1 은 확장하지 않는다 — 확장하면 데이터 끝 연도에서 한 칸이 제자리로 돌아와 멈춘다.
    const wide = expand ? expandToYearAxis(next.from, next.to, bounds) : next;
    if (wide.from !== yearFrom || wide.to !== yearTo) setYearRange(wide.from, wide.to);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !(span > 0)) return;
    const year = yearAt(e.clientX);
    if (year === null) return;
    const base = { from: yearFrom, to: yearTo };
    // M-6: 손잡이 ±22px 안에서만 드래그를 시작한다 — 띠를 스치는 탭·세로 스와이프로 점프하지 않게.
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || !(rect.width > 0)) return;
    const xOf = (y: number) => rect.left + ((y - bounds.min) / span) * rect.width;
    const handle = nearestYearHandle(year, base.from, base.to);
    if (Math.abs(e.clientX - xOf(handle === "from" ? base.from : base.to)) > 22) return;
    dragRef.current = { handle, pointerId: e.pointerId };
    // jsdom/구형 웹뷰엔 없을 수 있다 — 없으면 캡처 없이(손가락이 띠 밖으로 나가면 거기서 끝) 동작.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDraft(moveYearHandle(base, handle, year, bounds));
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const year = yearAt(e.clientX);
    if (year === null) return;
    setDraft(moveYearHandle(draftRef.current ?? { from: yearFrom, to: yearTo }, d.handle, year, bounds));
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>, apply: boolean) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (apply && draftRef.current) commit(draftRef.current, true);
    setDraft(null);
  };

  const onHandleKey = (handle: "from" | "to") => (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const cur = { from: yearFrom, to: yearTo };
    commit(moveYearHandle(cur, handle, (handle === "from" ? cur.from : cur.to) + step, bounds));
  };

  return (
    <div className="mobile-year-range" data-testid="mobile-year-range">
      <div className="mobile-year-range-head">
        <span
          className="mobile-year-range-label"
          data-full={full ? "true" : undefined}
          data-testid="mobile-year-range-label"
          aria-live="polite"
        >
          {label}
        </span>
        {!full && (
          <button
            type="button"
            className="mobile-year-range-reset"
            data-testid="mobile-year-range-reset"
            onClick={() => setYearRange(bounds.min, bounds.max)}
          >
            {t("search.timeline_show_all")}
          </button>
        )}
        {trailing && <span className="mobile-year-range-trailing">{trailing}</span>}
      </div>
      <div
        className="mobile-year-range-track"
        data-testid="mobile-year-range-track"
        role="group"
        aria-label={t("mobile.filter_year_label")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
      >
        <div ref={railRef} className="mobile-year-range-rail">
          {marks.map((m) => (
            <span
              key={m.year}
              aria-hidden
              className="mobile-year-range-mark"
              style={{ left: `${m.frac * 100}%`, width: densityMarkWidth(m.count) }}
            />
          ))}
          <span
            aria-hidden
            className="mobile-year-range-fill"
            style={{ left: `${pct(view.from)}%`, width: `${Math.max(0, pct(view.to) - pct(view.from))}%` }}
          />
          {(["from", "to"] as const).map((h) => {
            const value = h === "from" ? view.from : view.to;
            return (
              <div
                key={h}
                role="slider"
                tabIndex={0}
                className="mobile-year-range-knob"
                data-testid={`mobile-year-range-${h}`}
                aria-label={t(h === "from" ? "search.era_from_placeholder" : "search.era_to_placeholder")}
                aria-valuemin={h === "from" ? bounds.min : view.from + 1}
                aria-valuemax={h === "from" ? view.to - 1 : bounds.max}
                aria-valuenow={value}
                aria-orientation="horizontal"
                onKeyDown={onHandleKey(h)}
                style={{ left: `${pct(value)}%` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
