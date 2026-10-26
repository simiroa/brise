import React from "react";
import "./onboarding.css";
import { useSettingsStore } from "../../stores/settings";

// PLAN-2026-09-28 §3 — 온보딩 첫 화면 + 설정 4쪽의 설명용 인라인 SVG.
// 실제 입력과 분리된 aria-hidden 장식이다. 텍스트 없음(다국어 불필요), 색은 tokens.css 변수만 사용.
// 2026-09-28 리워크: 느리고("10s 루프") 단조롭던("전부 같은 scale 0.6→1.08 팝") 모션을
// 빠르고(4.4~4.8s 루프) 그림마다 다른 동작 어휘로 교체 — docs/PLAN-2026-09-28-onboarding-rebuild.md §2~§3.

const STROKE = "var(--text)";
const MUTED = "var(--muted)";
const FAINT = "var(--faint)";
const ACCENT = "var(--accent)";
const TINT = (pct: number) => `color-mix(in srgb, var(--accent) ${pct}%, transparent)`;

function ObSvg({ name, viewBox, children }: { name: string; viewBox: string; children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={viewBox}
      className={`ob-art ob-art-${name}`}
      style={{ width: "100%", height: "auto", display: "block" }}
    >
      {children}
    </svg>
  );
}

/** 작은 사각 "기록" 노드 — Ai 아트에서 재사용. */
function NodeBox({ x, y, w = 40, h = 30, children }: { x: number; y: number; w?: number; h?: number; children?: React.ReactNode }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={6} fill={TINT(6)} stroke={STROKE} strokeWidth={1.4} />
      {children}
    </g>
  );
}

/** 선-긋기(pathLength=1, stroke-dashoffset 애니메이션) 헬퍼. */
function Draw({ d, className, color = ACCENT, width = 1.6 }: { d: string; className: string; color?: string; width?: number }) {
  return <path className={className} d={d} pathLength={1} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" />;
}

// ── 첫 화면: 기록(잉크 점, 고정 앵커) → 노트 → 타임라인 → 지역(핀) → AI 새 연결
//    → 동글이가 사람 어깨에 착지(클라이맥스) → 잉크 점만 남고 리셋. 8초, 장면이 누적된다
//    (한 장면이 사라지고 다음이 뜨는 크로스페이드가 아니다). ─────────────────────────
export function WelcomeArt() {
  return (
    <ObSvg name="welcome" viewBox="0 0 320 200">
      {/* 잉크 점: 이야기의 시작과 끝을 고정하는 유일한 무애니메이션 요소. */}
      <circle cx={54} cy={58} r={5} fill={ACCENT} />

      <g className="ob-w-note">
        <path d="M54,58 Q62,63 70,66" fill="none" stroke={ACCENT} strokeWidth={1.4} strokeLinecap="round" />
        <rect x={70} y={44} width={72} height={48} rx={6} fill={TINT(8)} stroke={STROKE} strokeWidth={1.5} />
        <g className="ob-w-notelines">
          <line x1={80} y1={58} x2={126} y2={58} stroke={MUTED} strokeWidth={2} strokeLinecap="round" />
          <line x1={80} y1={68} x2={118} y2={68} stroke={ACCENT} strokeWidth={2} strokeLinecap="round" />
          <line x1={80} y1={78} x2={122} y2={78} stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
        </g>
      </g>

      <g className="ob-w-timeline">
        <Draw d="M70,128 L250,128" className="ob-w-timeline-line" color="var(--divider)" width={2} />
        <g className="ob-w-dots">
          <circle cx={110} cy={128} r={4} fill={MUTED} />
          <circle cx={170} cy={128} r={4} fill={MUTED} />
          <circle cx={225} cy={128} r={4} fill={MUTED} />
        </g>
      </g>

      <g className="ob-w-pin">
        <path
          d="M170,86 C180,86 188,95 188,104 C188,116 170,128 170,128 C170,128 152,116 152,104 C152,95 160,86 170,86 Z"
          fill={TINT(16)}
          stroke={STROKE}
          strokeWidth={1.5}
        />
        <circle cx={170} cy={103} r={5} fill="none" stroke={STROKE} strokeWidth={1.3} />
      </g>

      <g className="ob-w-ai">
        <g className="ob-w-ailinks">
          <Draw d="M170,86 Q159,66 148,48" className="ob-w-ailink" width={1.3} />
          <Draw d="M170,86 Q188,66 205,48" className="ob-w-ailink" width={1.3} />
          <Draw d="M170,86 Q172,60 175,34" className="ob-w-ailink" width={1.3} />
        </g>
        <g className="ob-w-ainodes">
          <circle cx={148} cy={48} r={3.4} fill={MUTED} />
          <circle cx={205} cy={48} r={3.4} fill={MUTED} />
          <circle cx={175} cy={34} r={3.4} fill={ACCENT} />
        </g>
      </g>

      <g className="ob-w-person">
        <path d="M270,110 Q292,90 314,110" fill="none" stroke={MUTED} strokeWidth={2} strokeLinecap="round" />
        <circle cx={292} cy={58} r={13} fill={TINT(10)} stroke={STROKE} strokeWidth={1.4} />
      </g>

      <g className="ob-w-mascot" style={{ transformBox: "view-box", transformOrigin: "292px 100px" }}>
        <ellipse cx={292} cy={96} rx={11} ry={9} fill={TINT(24)} stroke={STROKE} strokeWidth={1.4} />
        <circle cx={288} cy={93} r={1.6} fill={STROKE} />
        <circle cx={296} cy={93} r={1.6} fill={STROKE} />
      </g>
      <circle className="ob-w-burst" cx={292} cy={100} r={4} fill="none" stroke={ACCENT} strokeWidth={1.4} />
    </ObSvg>
  );
}

// 설정 4쪽 공통: 4.4초 루프. 컨테이너(책·지도·카드·PC)는 고정, 움직이는 요소만 애니메이션한다.

// ── 1/4 내 공간: 지금 고른 테마·표면 스타일을 실시간으로 그린다(2026-09-29 재작업). "데스크톱"
//    (컬러 블롭들) 위에 앱 창 하나 — 아크릴은 반투명 유리라 뒤 블롭이 흐리게 비치고, 플랫은
//    불투명해 완전히 가린다. 스토어 값이 바뀌면 두 창 사이를 opacity 크로스페이드(320ms, CSS
//    transition)로 넘긴다 — 나머지(타이핑 줄·책갈피·스와치)는 기존 4.4s 클라이맥스 루프 그대로. ──
const ACRYLIC_PANE_FILL = "color-mix(in srgb, var(--surface) calc(var(--sheet-alpha) * 100%), transparent)";

function SpaceDesktop() {
  return (
    <>
      <circle cx={62} cy={70} r={42} fill={TINT(26)} />
      <circle cx={190} cy={58} r={28} fill={ACCENT} opacity={0.35} />
      <rect x={112} y={150} width={92} height={62} rx={18} fill={TINT(16)} />
      <circle cx={68} cy={190} r={24} fill={MUTED} opacity={0.3} />
    </>
  );
}

export function SpaceArt() {
  const surfaceStyle = useSettingsStore((s) => s.surfaceStyle);
  const isAcrylic = surfaceStyle === "acrylic";

  return (
    <ObSvg name="space" viewBox="0 0 240 240">
      <defs>
        <clipPath id="obSpPaneClip">
          <rect x={44} y={40} width={152} height={152} rx={16} />
        </clipPath>
        <filter id="obSpBlur" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      {/* "데스크톱" — 창 뒤에 항상 있다. */}
      <SpaceDesktop />

      {/* 아크릴일 때만 존재: 데스크톱 복사본을 창 자리에서 흐리게(정적 필터, 애니메이션 아님). */}
      {isAcrylic && (
        <g className="ob-sp-blurbg" clipPath="url(#obSpPaneClip)" filter="url(#obSpBlur)">
          <SpaceDesktop />
        </g>
      )}

      {/* 창 — 두 장을 겹쳐 두고 opacity만 바꿔 크로스페이드한다(색 자체를 트랜지션하지 않는다). */}
      <rect
        className="ob-sp-pane"
        x={44}
        y={40}
        width={152}
        height={152}
        rx={16}
        fill={ACRYLIC_PANE_FILL}
        stroke={STROKE}
        strokeWidth={1.5}
        style={{ opacity: isAcrylic ? 1 : 0 }}
      />
      <rect
        className="ob-sp-pane"
        x={44}
        y={40}
        width={152}
        height={152}
        rx={16}
        fill="var(--surface)"
        stroke={STROKE}
        strokeWidth={1.5}
        style={{ opacity: isAcrylic ? 0 : 1 }}
      />

      {/* 노트북 성격: 타이핑 줄 + 책갈피(클라이맥스) + 강조 스와치 한 알 — 창 안. */}
      <g className="ob-sp-lines">
        <Draw d="M62,66 L120,62" className="ob-sp-type" color={MUTED} />
        <Draw d="M62,80 L108,78" className="ob-sp-type" />
        <Draw d="M62,94 L116,92" className="ob-sp-type" color={FAINT} />
      </g>

      <path className="ob-sp-bookmark" d="M148,40 L164,40 L164,104 L156,95 L148,104 Z" fill={ACCENT} />
      <circle className="ob-sp-burst" cx={156} cy={94} r={4} fill="none" stroke={ACCENT} strokeWidth={1.4} />

      <g className="ob-sp-swatches">
        <circle cx={92} cy={172} r={7} fill={ACCENT} stroke={STROKE} strokeWidth={1} />
      </g>
      <circle className="ob-sp-ripple" cx={92} cy={172} r={7} fill="none" stroke={ACCENT} strokeWidth={1.4} />
    </ObSvg>
  );
}

// ── 2/4 지역: 지도에 핀이 튕기며 꽂히고 → 파동이 번지고 → 달력 한 칸이 켜지며 타임라인 점이
//    같은 박자로 반짝이고 → 시계 바늘이 빠르게 돌고 구름 뒤에서 해가 튀어나온다(클라이맥스) ──────
export function RegionArt() {
  return (
    <ObSvg name="region" viewBox="0 0 240 240">
      <NodeBox x={20} y={30} w={46} h={40}>
        <rect x={20} y={30} width={46} height={10} rx={3} fill={TINT(20)} />
        {[26, 36, 46, 56].flatMap((cx) => [46, 58].map((cy) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={2.2} fill={MUTED} />
        )))}
        <circle className="ob-rg-calcell" cx={46} cy={58} r={3.4} fill={ACCENT} />
      </NodeBox>

      <NodeBox x={70} y={90} w={100} h={70}>
        <circle cx={120} cy={122} r={30} fill="none" stroke={FAINT} strokeWidth={1.2} />
      </NodeBox>

      <g className="ob-rg-pin">
        <path d="M120,95 C130,95 138,104 138,113 C138,125 120,140 120,140 C120,140 102,125 102,113 C102,104 110,95 120,95 Z" fill={TINT(30)} stroke={ACCENT} strokeWidth={1.5} />
        <circle cx={120} cy={113} r={4} fill={ACCENT} />
      </g>
      <circle className="ob-rg-ring" cx={120} cy={140} r={10} fill="none" stroke={ACCENT} strokeWidth={1.4} />
      <circle className="ob-rg-ring ob-rg-ring2" cx={120} cy={140} r={10} fill="none" stroke={ACCENT} strokeWidth={1.4} />

      <line x1={20} y1={190} x2={90} y2={190} stroke="var(--divider)" strokeWidth={2} strokeLinecap="round" />
      <circle cx={35} cy={190} r={3} fill={MUTED} />
      <circle className="ob-rg-tldot" cx={55} cy={190} r={3.6} fill={ACCENT} />
      <circle cx={75} cy={190} r={3} fill={MUTED} />

      <g>
        <circle cx={205} cy={40} r={16} fill={TINT(8)} stroke={STROKE} strokeWidth={1.3} />
        <line x1={205} y1={40} x2={205} y2={27} stroke={FAINT} strokeWidth={1.3} strokeLinecap="round" />
        <line
          className="ob-rg-hand"
          style={{ transformBox: "view-box", transformOrigin: "205px 40px" }}
          x1={205}
          y1={40}
          x2={214}
          y2={35}
          stroke={ACCENT}
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      </g>

      <g>
        <ellipse cx={205} cy={195} rx={16} ry={10} fill={TINT(6)} stroke={MUTED} strokeWidth={1.2} />
        <circle className="ob-rg-sun" cx={190} cy={182} r={9} fill={ACCENT} />
      </g>
    </ObSvg>
  );
}

// ── 3/4 AI: 노트 카드 자체가 앱의 AI 보더빔(tokens.css AI-GLOW › BEAM)을 두른다 → 사용자가
//    묻고(버블) → 타이핑 점 세 개 → AI 가 한 줄씩 답을 그리고(stroke-dashoffset) → 확인
//    스탬프가 찍힌다(클라이맥스, "결과는 확인 후 반영됨"). 빔은 실제 CSS 신호라 HTML 래퍼에만
//    걸 수 있어 이 그림만 카드 하나를 <div>로 두고 안에 SVG를 담는다. 2026-09-29 재작업. ────────
export function AiArt() {
  return (
    <div aria-hidden="true" className="ob-art ob-art-ai ob-ai-card" data-ai-glow="active" data-ai-glow-beam="true">
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 240 240"
        className="ob-ai-svg"
        style={{ width: "100%", height: "100%", display: "block" }}
      >
        {/* 작업 중인 노트 — 항상 보임. */}
        <g>
          <rect x={18} y={18} width={132} height={70} rx={8} fill={TINT(8)} stroke={STROKE} strokeWidth={1.4} />
          <line x1={30} y1={36} x2={122} y2={36} stroke={MUTED} strokeWidth={2} strokeLinecap="round" />
          <line x1={30} y1={48} x2={102} y2={48} stroke={ACCENT} strokeWidth={2} strokeLinecap="round" />
          <line x1={30} y1={60} x2={112} y2={60} stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
          <line x1={30} y1={72} x2={90} y2={72} stroke={FAINT} strokeWidth={2} strokeLinecap="round" />
        </g>

        {/* 사용자 물음 버블. */}
        <g className="ob-ai-userbubble">
          <path
            d="M158,104 h60 a9,9 0 0 1 9,9 v20 a9,9 0 0 1 -9,9 h-42 l-11,11 v-11 h-7 a9,9 0 0 1 -9,-9 v-20 a9,9 0 0 1 9,-9 Z"
            fill={TINT(14)}
            stroke={STROKE}
            strokeWidth={1.3}
          />
          <line x1={168} y1={120} x2={214} y2={120} stroke={MUTED} strokeWidth={1.8} strokeLinecap="round" />
          <line x1={168} y1={130} x2={200} y2={130} stroke={FAINT} strokeWidth={1.8} strokeLinecap="round" />
        </g>

        {/* 타이핑 점. */}
        <g>
          <circle className="ob-ai-dot" cx={40} cy={150} r={3.6} fill={MUTED} />
          <circle className="ob-ai-dot ob-ai-dot-b" cx={53} cy={150} r={3.6} fill={MUTED} />
          <circle className="ob-ai-dot ob-ai-dot-c" cx={66} cy={150} r={3.6} fill={MUTED} />
        </g>

        {/* AI 응답 버블 — 줄이 순서대로 그려진다. */}
        <g className="ob-ai-reply">
          <path
            d="M18,138 h152 a10,10 0 0 1 10,10 v36 a10,10 0 0 1 -10,10 h-122 l-14,12 v-12 h-16 a10,10 0 0 1 -10,-10 v-36 a10,10 0 0 1 10,-10 Z"
            fill={TINT(10)}
            stroke={ACCENT}
            strokeWidth={1.4}
          />
          <Draw d="M30,157 L152,157" className="ob-ai-replyline" width={2} />
          <Draw d="M30,169 L130,169" className="ob-ai-replyline" width={2} color={MUTED} />
          <Draw d="M30,181 L100,181" className="ob-ai-replyline" width={2} color={FAINT} />
        </g>

        {/* 확인 스탬프 — 클라이맥스. */}
        <g className="ob-ai-stamp">
          <circle cx={204} cy={202} r={18} fill={ACCENT} />
          <path d="M196,202 L202,208 L213,194" fill="none" stroke="var(--btn-primary-fg)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <circle className="ob-ai-stampring" cx={204} cy={202} r={18} fill="none" stroke={ACCENT} strokeWidth={1.6} />
      </svg>
    </div>
  );
}

// ── 4/4 기기 연결: 신호가 PC에서 번지고 → 휴대폰·노트북이 팝하고 → 점선을 따라 요청·응답이
//    빠르게 오가고 → 자물쇠 걸쇠가 내려와 찰칵 잠긴다(클라이맥스, 보안) ────────────────────
export function ConnectArt() {
  return (
    <ObSvg name="connect" viewBox="0 0 240 240">
      <g>
        <circle className="ob-cn-ring" cx={120} cy={90} r={30} fill="none" stroke={ACCENT} strokeWidth={1.3} />
        <circle className="ob-cn-ring ob-cn-ring2" cx={120} cy={90} r={30} fill="none" stroke={ACCENT} strokeWidth={1.3} />
        <circle className="ob-cn-ring ob-cn-ring3" cx={120} cy={90} r={30} fill="none" stroke={ACCENT} strokeWidth={1.3} />
        <rect x={80} y={62} width={80} height={56} rx={6} fill={TINT(8)} stroke={STROKE} strokeWidth={1.6} />
        <line x1={92} y1={78} x2={134} y2={78} stroke={MUTED} strokeWidth={1.8} strokeLinecap="round" />
        <line x1={92} y1={90} x2={126} y2={90} stroke={ACCENT} strokeWidth={1.8} strokeLinecap="round" />
        <line x1={92} y1={102} x2={130} y2={102} stroke={FAINT} strokeWidth={1.8} strokeLinecap="round" />
        <rect x={112} y={118} width={16} height={9} fill="none" stroke={STROKE} strokeWidth={1.3} />
        <line x1={98} y1={130} x2={142} y2={130} stroke={STROKE} strokeWidth={1.6} strokeLinecap="round" />
      </g>

      <g className="ob-cn-device ob-cn-device-a">
        <rect x={16} y={124} width={30} height={52} rx={7} fill={TINT(8)} stroke={STROKE} strokeWidth={1.5} />
        <line x1={23} y1={138} x2={39} y2={138} stroke={MUTED} strokeWidth={1.6} strokeLinecap="round" />
        <line x1={23} y1={146} x2={35} y2={146} stroke={ACCENT} strokeWidth={1.6} strokeLinecap="round" />
      </g>
      <g className="ob-cn-device ob-cn-device-b">
        <rect x={182} y={118} width={44} height={30} rx={4} fill={TINT(8)} stroke={STROKE} strokeWidth={1.5} />
        <path d="M176,152 L232,152 L228,158 L180,158 Z" fill={TINT(6)} stroke={STROKE} strokeWidth={1.3} />
        <line x1={190} y1={128} x2={214} y2={128} stroke={MUTED} strokeWidth={1.6} strokeLinecap="round" />
        <line x1={190} y1={136} x2={206} y2={136} stroke={FAINT} strokeWidth={1.6} strokeLinecap="round" />
      </g>

      <g className="ob-cn-links">
        <path className="ob-cn-linkfade ob-cn-march" d="M46,146 L82,116" fill="none" stroke={MUTED} strokeWidth={1.6} strokeLinecap="round" />
        <path className="ob-cn-linkfade ob-cn-march" d="M182,132 L158,116" fill="none" stroke={MUTED} strokeWidth={1.6} strokeLinecap="round" />
      </g>
      <g className="ob-cn-packets">
        <circle className="ob-cn-pkt ob-cn-pkt-a" cx={46} cy={146} r={3} fill={ACCENT} />
        <circle className="ob-cn-pkt ob-cn-pkt-b" cx={82} cy={116} r={3} fill={MUTED} />
        <circle className="ob-cn-pkt ob-cn-pkt-c" cx={182} cy={132} r={3} fill={ACCENT} />
        <circle className="ob-cn-pkt ob-cn-pkt-d" cx={158} cy={116} r={3} fill={MUTED} />
      </g>

      <g>
        <rect className="ob-cn-lockbody" x={104} y={178} width={32} height={26} rx={5} fill={TINT(16)} stroke={STROKE} strokeWidth={1.5} />
        <circle cx={120} cy={191} r={3} fill={ACCENT} />
        <path
          className="ob-cn-shackle"
          d="M110,178 L110,168 A10,10 0 0 1 130,168 L130,178"
          fill="none"
          stroke={STROKE}
          strokeWidth={2.2}
          strokeLinecap="round"
        />
      </g>
      <circle className="ob-cn-lockflash" cx={120} cy={191} r={20} fill="none" stroke={ACCENT} strokeWidth={1.4} />
    </ObSvg>
  );
}

// ── 데이터 관리: 사진·문서가 점선 경로를 따라 떨어져 → 폴더가 받아내며 통통 튄다(클라이맥스) →
//    링이 한 번 번쩍인다. 폴더 아래에는 펼쳐진 책(지금 쌓인 기록) — 위치를 바꿔도 그 안의 책은
//    그대로라는 뜻. ImportArt와 같은 낙하 어휘, 레이블 없음(장식용 aria-hidden). 4.4s 루프 ────────
export function DataArt() {
  return (
    <ObSvg name="data" viewBox="0 0 240 240">
      {/* 펼쳐진 책 — 정적, 폴더 뒤에 이미 쌓인 기록. */}
      <path
        d="M40,206 Q120,192 200,206 L200,222 Q120,210 40,222 Z"
        fill={TINT(6)}
        stroke={MUTED}
        strokeWidth={1.3}
      />
      <line x1={120} y1={196} x2={120} y2={218} stroke={MUTED} strokeWidth={1.1} />

      {/* 폴더 — 낙하물을 받아내는 자리(클라이맥스: 통통 튐). */}
      <g className="ob-dt-folder">
        <path
          d="M60,150 L96,150 L104,160 L180,160 L180,196 L60,196 Z"
          fill={TINT(12)}
          stroke={STROKE}
          strokeWidth={1.5}
        />
      </g>
      <circle className="ob-dt-burst" cx={120} cy={160} r={10} fill="none" stroke={ACCENT} strokeWidth={1.6} />

      {/* 사진 — 점선 낙하 경로 + 산 모양 아이콘. */}
      <g className="ob-dt-drop ob-dt-drop-a">
        <line x1={78} y1={40} x2={78} y2={116} stroke={STROKE} strokeWidth={1.2} strokeDasharray="4 3" />
        <rect x={54} y={40} width={48} height={38} rx={4} fill={TINT(10)} stroke={STROKE} strokeWidth={1.4} />
        <circle cx={65} cy={52} r={4} fill={MUTED} />
        <path d="M58,72 L72,58 L82,68 L98,52 L98,72 Z" fill={ACCENT} opacity={0.5} />
      </g>

      {/* 문서 — 점선 낙하 경로 + 줄. */}
      <g className="ob-dt-drop ob-dt-drop-b">
        <line x1={158} y1={34} x2={140} y2={112} stroke={STROKE} strokeWidth={1.2} strokeDasharray="4 3" />
        <rect x={134} y={34} width={44} height={54} rx={4} fill={TINT(10)} stroke={STROKE} strokeWidth={1.4} />
        <line x1={142} y1={48} x2={170} y2={48} stroke={MUTED} strokeWidth={1.8} strokeLinecap="round" />
        <line x1={142} y1={60} x2={164} y2={60} stroke={ACCENT} strokeWidth={1.8} strokeLinecap="round" />
        <line x1={142} y1={72} x2={168} y2={72} stroke={FAINT} strokeWidth={1.8} strokeLinecap="round" />
      </g>
    </ObSvg>
  );
}

// ── 기록 가져오기: 폴더·zip·Evernote풍 노트가 위에서 떨어져 → 노트북에 착지한다(클라이맥스,
//    통통 튀는 표지) → 링이 한 번 번쩍인다. 복제 그림 없음, 4.4s 루프 ─────────────────────────
export function ImportArt() {
  return (
    <ObSvg name="import" viewBox="0 0 240 240">
      <g className="ob-im-notebook">
        <rect x={54} y={168} width={132} height={46} rx={8} fill={TINT(8)} stroke={STROKE} strokeWidth={1.5} />
        <line x1={120} y1={168} x2={120} y2={214} stroke={STROKE} strokeWidth={1.4} />
        <path d="M112,178 L128,178 L128,200 L120,194 L112,200 Z" fill={ACCENT} />
      </g>
      <circle className="ob-im-burst" cx={120} cy={172} r={10} fill="none" stroke={ACCENT} strokeWidth={1.6} />

      {/* 폴더 */}
      <g className="ob-im-drop ob-im-drop-a">
        <path d="M32,56 L52,56 L58,64 L84,64 L84,86 L32,86 Z" fill={TINT(10)} stroke={STROKE} strokeWidth={1.4} />
      </g>

      {/* zip */}
      <g className="ob-im-drop ob-im-drop-b">
        <rect x={104} y={50} width={32} height={40} rx={4} fill={TINT(10)} stroke={STROKE} strokeWidth={1.4} />
        <line x1={120} y1={50} x2={120} y2={90} stroke={STROKE} strokeWidth={1.2} strokeDasharray="4 3" />
      </g>

      {/* Evernote풍 노트 — 접힌 모서리 */}
      <g className="ob-im-drop ob-im-drop-c">
        <path d="M156,50 L184,50 L192,58 L192,90 L156,90 Z" fill={TINT(10)} stroke={STROKE} strokeWidth={1.4} />
        <path d="M184,50 L184,58 L192,58 Z" fill={MUTED} />
        <line x1={163} y1={68} x2={183} y2={68} stroke={MUTED} strokeWidth={1.6} strokeLinecap="round" />
        <line x1={163} y1={77} x2={177} y2={77} stroke={FAINT} strokeWidth={1.6} strokeLinecap="round" />
      </g>
    </ObSvg>
  );
}
