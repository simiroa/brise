// 차트 종류 9개가 공유하는 원시 조각(축·격자·툴팁·팔레트). SheetChart.tsx 는 빈 데이터 카드·제목·
// ResponsiveContainer 래핑만 갖고, 종류별 recharts 본체는 `./` 의 개별 파일이 갖는다(W6, D2 규율과 동형).
import type { CSSProperties, FC, ReactElement } from "react";
import { CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";

// PLAN-2026-09-20 D7: 단색 + 투명도 톤(amicro mono-charts 참고). tokens.css 에 새 색 토큰을 만들지 않고
// accent 하나에서 5단을 뽑는다 — hex 리터럴 0개(check:colors 래칫).
//
// 대비 실측(2026-09-20, tokens.css 의 :root/라이트 오버라이드 hex 로 직접 계산, sRGB 선형 채널 가중
// 휘도 0.2126R+0.7152G+0.0722B, color-mix(in srgb, accent N%, transparent)는 캔버스 위에서
// accent·bg 를 N:100-N 으로 섞은 것과 같다):
//   다크  accent #9cc5a4 / bg #171b1a → 휘도 100%=186 · 75%=146 · 55%=114 · 40%=90  · 28%=71  (bg=26)
//   라이트 accent #7da98c / bg #f4efe3 → 휘도 100%=158 · 75%=178 · 55%=194 · 40%=207 · 28%=216 (bg=239)
// 인접 단 최소 차 = 다크 19(40↔28), 라이트 10(40↔28) — 라이트 쪽이 좁아지지만 accent(녹)와
// bg(따뜻한 크림)의 색상(hue)이 달라 명도만으론 안 보이는 차를 색상이 보완한다. 6번째 톤이
// 필요해지면 이 계산부터 다시 하고 tokens.css 에 --chart-1..n 을 추가한다(SheetChart.tsx 의
// 옛 PALETTE 주석 — 하드코딩 hex 를 섞었다가 라이트 테마에서 배경으로 날아간 사고 참고).
export const PALETTE = [
  "var(--accent)",
  "color-mix(in srgb, var(--accent) 75%, transparent)",
  "color-mix(in srgb, var(--accent) 55%, transparent)",
  "color-mix(in srgb, var(--accent) 40%, transparent)",
  "color-mix(in srgb, var(--accent) 28%, transparent)",
] as const;

export const COMPACT_NUM = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
export const FULL_NUM = new Intl.NumberFormat();

export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** `series_2` → `#2`. 사용자에게 내부 키를 그대로 보이지 않으면서 i18n 키도 늘리지 않는다. */
export const seriesLabel = (key: string, idx: number): string => `#${key.split("_")[1] ?? idx + 1}`;

/** 0 을 항상 도메인에 포함 — 음수는 축 아래로, 양수 전용 데이터는 0 기준선을 유지한다. */
export const ZERO_ANCHORED_DOMAIN: [(v: number) => number, (v: number) => number] = [
  (min) => Math.min(0, min),
  (max) => Math.max(0, max),
];

interface TooltipEntry {
  name?: string | number;
  value?: number | string;
  color?: string;
}

/** 떠 있는 표면 = `.overlay`(CheatsheetPopover 선례). recharts 의 흰 배경 기본값을 쓰지 않는다. */
export const ChartTooltip: FC<{ active?: boolean; payload?: TooltipEntry[]; label?: string | number }> = ({
  active,
  payload,
  label,
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="overlay sheet-chart-tooltip">
      {label !== undefined && label !== "" && <div className="sheet-chart-tooltip-label">{String(label)}</div>}
      {payload.map((p, i) => (
        <div key={i} className="sheet-chart-tooltip-row">
          <span className="sheet-chart-tooltip-dot" style={{ color: p.color ?? "var(--accent)" }}>
            ●
          </span>
          {payload.length > 1 && <span>{String(p.name ?? "")}</span>}
          <strong>{FULL_NUM.format(num(p.value))}</strong>
        </div>
      ))}
    </div>
  );
};

/** 시리즈마다 세로 그라디언트 하나 — id 는 spec.id·용도 접미사라 같은 섹션의 다른 차트와 겹치지 않는다.
 *  색은 PALETTE(accent 단색 톤) 그대로, 투명도만 top→bottom 으로 낮춘다(D7 단색 유지 — hex 0개). */
export function gradientDefs(id: string, tag: string, count: number, top: number, bottom: number): ReactElement {
  return (
    <defs>
      {Array.from({ length: count }, (_, i) => (
        <linearGradient key={i} id={`${id}-${tag}-${i}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={top} />
          <stop offset="100%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={bottom} />
        </linearGradient>
      ))}
    </defs>
  );
}

export function cartesianGrid(): ReactElement {
  return <CartesianGrid stroke="var(--divider)" strokeDasharray="2 2" vertical={false} />;
}

export function xAxisEl(compact: boolean): ReactElement {
  // compact(어시스트 카드·미리보기): 축선·눈금선 없이 라벨만, 양끝에 6px 숨통 — 가장자리 꽉 찬 배치에서
  // 첫/마지막 점·막대가 잘리지 않게(PLAN-2026-09-30 §3).
  return (
    <XAxis
      dataKey="name"
      stroke="var(--divider)"
      interval="preserveStartEnd"
      minTickGap={compact ? 24 : 8}
      tickLine={!compact}
      axisLine={!compact}
      padding={compact ? { left: 6, right: 6 } : undefined}
    />
  );
}

export function yAxisEl(compact: boolean): ReactElement {
  return (
    <YAxis
      hide={compact} // 컴팩트는 Y축 거터를 없앤다 — 값은 툴팁이 준다(좌우 여백 제거, PLAN-2026-09-30 §3)
      stroke="var(--divider)"
      width={compact ? 34 : 46}
      tickCount={compact ? 3 : 5}
      domain={ZERO_ANCHORED_DOMAIN}
      tickFormatter={(v: number) => COMPACT_NUM.format(v)}
    />
  );
}

export function tooltipEl(): ReactElement {
  // isAnimationActive=false: recharts 는 툴팁을 (0,0)에서 마우스 위치로 슬라이드시키는 애니메이션이 기본이라
  // 첫 호버 때 화면 밖에서 숫자 팁이 날아든다(오너 2026-09-21 "버그 같은 애니메이션"). 시리즈와 같이 끈다.
  return <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--hover)" }} isAnimationActive={false} />;
}

/** 범례는 시리즈(또는 파이 조각) 2개 이상일 때만 — 1개뿐이면 범례가 제목과 같은 말을 반복한다. */
export function legendEl(compact: boolean, count: number): ReactElement | null {
  if (compact || count < 2) return null;
  return <Legend verticalAlign="bottom" height={20} iconSize={8} />;
}

/** 카드형 종류(total·kpi) 둘의 공통 박스 — recharts 를 태우지 않는 요약 카드. */
export function cardBoxStyle(width: number | string, height: number): CSSProperties {
  return {
    width,
    height,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "var(--space-6)",
    // 배경 없음 — 카드가 흐름 안에 놓이므로 .app 시트가 비친다(SINGLE-SHEET ACRYLIC CONTRACT).
    borderRadius: "var(--radius-md)",
    // accent 을 살짝 머금은 테두리 + 위쪽 은은한 빛(PLAN-2026-09-30) — 불투명 면이 아니라 투명 그라디언트라
    // 아크릴 계약(.app 시트가 비침)을 지킨다.
    border: "1px solid color-mix(in srgb, var(--accent) 22%, var(--line))",
    backgroundImage: "radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 70%)",
    boxSizing: "border-box",
  };
}
