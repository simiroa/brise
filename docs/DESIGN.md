# Design System: Hanji, Celadon, Ink (한지 위의 청자와 먹)

## Concept
The application's visual identity is built on the "Three Materials Principle" (3재료 원칙) to evoke a modern yet deeply grounded aesthetic inspired by traditional Korean elements.

1. **Background = Hanji (한지)**
   - **Light Mode**: Warm Hanji white (`#f4efe3` base) with low saturation.
   - **Dark Mode**: Night Hanji (`#171b1a` warm-grey-green base), synthesizing with the existing `bg-dim` slider.
   - **Texture**: We use an inline SVG `feTurbulence` data-URI overlay with a very low opacity (4% for light, 2.5% for dark) to give a subtle, tactile paper feel without external file dependencies.

2. **Accent = Celadon (청자)**
   - Used strictly for buttons, selections, and active states. **Structure (hairlines) is not an
     accent job** — it belongs to the theme color `--theme`; see "색 세 층" below.
   - **Prohibited**: Excessive use of celadon (옥색) for large backgrounds.
   - **Default Accent Color**: `#7da98c` for light mode, `#9cc5a4` for dark mode. Celadon is the
     *default*, no longer the only option — see below.
   - **The accent is generated, not enumerated** (2026-09-12, PLAN-2026-09-12 §4/D4). The old
     5-swatch Celadon whitelist (`VALID_ACCENTS`) is gone; `src/lib/accentPalette.ts` computes the
     palette in **OKLCH** and emits sRGB hex (the stored value stays hex, so Rust
     `validate_setting`'s `accent` arm — `is_hex_color` — did not change). Three axes, two of them
     the user's: **H** = a hue slider (0–360°), **C** = a 5-chip chroma ladder
     (`[0, .03, .064, .1, .145]` — step 0 is truly achromatic and greys out the hue chip, since hue
     cannot affect a C=0 result), and **L = a per-theme constant** (`ACCENT_L`: dark `.7847`,
     light `.6947`). L is not a user axis on purpose: a lightness that reads on `#171b1a` is not the
     one that reads on `#f4efe3`, so letting the user pick it means the accent drowns or stabs the
     moment the theme flips. OKLCH rather than HSL because HSL's yellow looks far brighter than its
     blue at the same L — turning the hue slider would make the accent's visual weight slosh.
   - **`--on-accent` is computed, not tabulated** — `onAccentFor()` measures contrast from the
     chosen color's L, so adjusting the `ACCENT_L` constants later carries the text color along.
     Every chip clears 4.5:1 against body text (`accentPalette.test.ts` asserts it).
   - **Shimmer Effect**: Primary accent buttons utilize `.btn-shimmer` which triggers a diagonal highlight sweep on hover (400ms ease-out, single sweep). Continuous/always-on animations are explicitly forbidden. Follows `prefers-reduced-motion` for accessibility.

3. **Text = Ink (먹)**
   - **Editor Font**: `--font-editor` defaults to **Pretendard** (2026-09-09, owner: "가독성이 뛰어난 폰트"). One bundled family covers Latin *and* the full 11,172-syllable Hangul range, so prose no longer straddles two families. The serif stack (`'Source Serif 4'` + `'Noto Serif KR'`) stays as a Settings > Appearance > Font choice, not the default.
   - Weight is set to `400/500/600` to ensure text is substantial (not too thin), aiming for a 450~500 visual weight.
   - **Self-Hosted**: `@fontsource` packages are used (offline requirement, no CDNs). Default body+UI is Pretendard (`@fontsource/pretendard`, weights 400/600 only — 766KB/786KB woff2 each; its single `latin` subset file actually carries all Hangul). Alternative stacks stay bundled: sans = Source Sans 3 + Noto Sans KR, serif = Source Serif 4 + Noto Serif KR. Mono is Source Code Pro.
   - **Ink Colors**: Dark grey for light mode (`#3b3833`), avoiding absolute black. Hanji-bright grey (`#e0deda`) for dark mode.

## 색 세 층 — 테마색 / 강조색 / 중성 (2026-09-12, PLAN-2026-09-12 §2/E1)

색은 **세 층**이고, 각 층은 정하는 주체와 칠하는 대상이 다르다.

| 층 | 토큰 | 누가 정하나 | 무엇을 칠하나 |
|---|---|---|---|
| ① **테마색** | `--theme` | 앱 (테마별 고정, 사용자가 못 바꾼다) | **구조** — 구분선 `--divider`/`--line`, 배경 채도, OS 아크릴 틴트 |
| ② **강조색** | `--accent` | 사용자 (hue 슬라이더 + 채도 5단) | **상태** — 선택·호버·포커스·활성, 주요 버튼, 링크, `--search-hit` |
| ③ **중성** | `--surface-*` · `--text`/`--muted`/`--faint` | 자동 (배경 합성에서 도출) | 면과 글자 |

**왜 갈랐나.** 예전에는 `--accent` 하나가 "앱의 정체성"과 "사용자의 선택"을 겸했다. 강조색이
청자색 원툴인 동안은 충돌이 보이지 않았지만 hue 를 연 순간 갈라졌다 — 레드를 고르면 화면의
**모든 선**이 분홍이 되고, 채도 0단을 고르면 전부 회색이 된다. 그 충돌을 피하려고 선을 잠시
무채색(`--text` 계열)으로 돌렸더니 이번엔 "라인 전부가 무채색이라 탁하다"(오너 QA)가 됐다.
`--theme` 은 회피가 아니라 분리다 — 선은 다시 청자로 물들되, 사용자의 hue 선택과 **무관**하다.

**값.** 다크 `#9cc5a4` (역사적 청자 그대로 — 옛 다크 구분선 `rgba(156,197,164,…)` 의 RGB 가 바로
이 색이었다), 라이트 `#33573a` (같은 hue·채도 HSL 131.7°/26.1%, 밝기만 69.2% → 27.0%).
라이트의 27% 는 취향이 아니라 계산 결과다 — **양 테마 공통 알파** 26%/13% 가 한지 캔버스 위에서
오늘과 같은 선 무게(CR 1.502 / ΔL\* −14.95)를 내는 밝기를 이분탐색으로 찾았다. 옛날에는 다크가
`.26/.13`, 라이트가 `.34/.16` 에 색까지 서로 달라 **두 테마가 서로 다른 규칙**이었다. 이제
규칙은 하나다: `color-mix(in srgb, var(--theme) 26%|13%, transparent)` — 두 테마 모두 같은 식,
같은 알파, 달라지는 것은 `--theme` 뿐이다(라이트 블록은 `--divider`/`--line` 을 재정의하지 않는다).

**어느 층인지 고르는 법** — 새 색을 칠할 때 자문할 것은 하나다: *사용자가 강조색을 레드로
바꿨을 때 이것도 빨개져야 하는가?*
- 예 → `--accent` (선택·호버·포커스·주요 버튼·링크 — "지금 이것" 을 가리키는 것)
- 아니오, 하지만 앱 색이긴 하다 → `--theme` (선·구조·바탕의 물듦)
- 색이 아니라 면·글자다 → 중성 토큰 (`--surface-*` / `--text`)

`src/styles/tokensColorContract.test.ts` 가 이 계약을 지킨다 — 구분선을 `--accent` 파생으로
되돌리거나 라이트에만 알파를 따로 주면 빨개진다.

**예외 — 설정 창 아이콘 배지** (2026-09-14 그릴링 Q3 → 2026-09-15 D2 개정). 히어로 헤더·
`SectionHeader`/카드·행 앞에 붙는 장식용 아이콘 배지는 위 heuristic("지금 이것을 가리키는가")에
안 맞는데도(선택 상태가 아니라 **모든** 항목에 상시로 붙는다) 강조색으로 칠한다. 색은 **한 벌뿐**:
배경 `color-mix(in srgb, var(--accent) 15%, transparent)` 틴트 + 아이콘 `var(--accent)`, 테두리
없음. 부품은 `IconChip`(`src/components/settings/IconChip.tsx`) 하나이고 크기는 48(히어로) /
32(카드 헤더·배너) / 24(행·레일)뿐이다 — 인라인 `color-mix` 아이콘 박스를 손수 만들지 않는다.
단색 `--accent` 배경 + `--on-accent` 아이콘(2026-09-14 D4)은 폐기됐다. 다른 화면(본문·다이어그램
등)으로 이 패턴을 확장하지 않는다 — 설정 창 한정 예외다.

## Single-Surface Principle (base tone) + Surface Style preset (flat/acrylic)

Canvas, panels, cards and modals all resolve to the exact same **base** tone, `--surface-base`
(derived from `--app-canvas` and the dark-only `bg-dim` slider). `--surface` is the only remaining
alias of `--surface-base` — structure comes from visible hairlines (`--divider`/`--line`) and
selection tints (`--sel`/`--hover`), not from stacking multiple opaque tones.

**본문 안에서는 기준면이 갈아끼워진다** (2026-09-12, PLAN-2026-09-12 §3/E5). `.content-canvas`
(본문 래퍼)는 `--content-tint` 반투명 틴트를 **자기 한 장에만** 칠하는데, 표면 토큰은 전부
`:root` 의 `--surface-base` 에서 파생돼 그 틴트를 몰랐다. 결과는 본문 안 모든 면이 밝은 패치로
뜨는 것이었다 — 실측(CDP)에서 `--surface-sunken` 이 본문 바탕보다 **밝았고**(CR 1.020),
`--surface-soft` 배지는 바탕과 CR 1.000 으로 완전히 무효였다. 그래서 `.content-canvas` 블록이
기준면을 "시트 + 본문 틴트" 합성색으로 재정의하고, **파생 6종**(`--app-canvas` ·`--surface` ·
`--surface-soft` ·`--surface-sunken` ·`--bg-surface` ·`--bg-base`)을 **같은 식 그대로** 함께
재정의한다.

- 파생을 함께 적어야 하는 이유: 커스텀 프로퍼티는 **선언된 지점**에서 `var()` 가 치환된다.
  `:root` 의 `--surface: var(--surface-base)` 는 그 자리에서 문자열로 굳어 상속되므로, 하위에서
  base 만 덮어도 **소급되지 않는다**(실측으로 확인 — 파생은 변화 0이었다).
- 소비처(222곳)는 **한 줄도 고치지 않는다.** 이름은 그대로고 바탕만 바뀐다.
- 틴트 0% 에서 이 블록은 **무연산**이다(`color-mix(in srgb, X 0%, Y) = Y`). 새 색을 만드는 것이
  아니라 이미 칠해져 있던 틴트를 토큰에 알려줄 뿐이다.
- 사이클 방지용으로 `:root` 에 `--app-sheet-base`(= 틴트 이전의 시트 기준면)가 하나 있다.
  `.content-canvas` 에서 그 토큰을 재정의하면 자기 참조 사이클이 되어 두 선언이 통째로 무효가
  된다 — 하지 말 것.
- 포커스 모드(`.content-canvas--focus`)는 틴트를 안 칠하므로 **기준면 하나만** 되돌린다;
  파생은 전부 기준면을 읽으므로 따라온다.
- ⚠️ 파생 공식이 이제 **두 벌**(`:root` / `.content-canvas`)이다. 한쪽만 고치면 본문만 조용히
  어긋나므로 `src/styles/tokensColorContract.test.ts` 가 두 블록을 구조적으로 대조한다 —
  `:root` 에 기준면 파생 토큰을 새로 추가하면 "본문에도 추가하라"고 빨개진다.

**Current design — SINGLE-SHEET ACRYLIC CONTRACT** (full comment block in
`src/styles/tokens.css`, above the `.app` rule): Settings > Appearance > "Surface style" is a
two-value preset, `flat` (default, opaque) or `acrylic` (labelled "Acrylique" in the UI).
Translucency happens in **exactly one place**: under `:root[data-surface='acrylic']`, `--bg`
(`.app`'s own canvas background) is overridden to a single `color-mix(in srgb, var(--surface-base)
calc(var(--sheet-alpha)*100%), transparent)` tint. That is the whole recipe — **there is no CSS
blur anywhere**. The window is `transparent: true` (the premise of the native desktop see-through),
and while it is, WebView2 does not paint `backdrop-filter: blur()` at all (the computed style has it,
the pixels don't — measured 2026-08-14); `.app`'s backdrop-filter and the old `--surface-blur`
token were deleted after that finding (2026-08-16). The real blur belongs to the native compositor material (Acrylic,
via the `window-vibrancy` crate) applied in `src-tauri/src/commands/window.rs` — see
`docs/TAURI-WINDOW.md` for the native side of this contract. `--sheet-alpha` (0–1, default 0.85,
acrylic-only) is the **only** sheet knob. No other selector draws its own translucency; every panel,
card, and chrome region inside `.app` is that one sheet showing through.

`.app` (a class rule in tokens.css, not an inline style) is the one place every window passes
through — main, settings, activity, AI history, briefing, section windows all render a `.app` root
(pet windows do not). It owns the sheet paint (`--bg` + repeat/size/position) **and the text
colour** (`color: var(--text)`). Both used to be inline on `App.tsx`'s root only, so the aux
windows' own `.app` roots missed them (sheet: 2026-08-15; colour: aux `h1` rendered
`rgb(255,255,255)` in dark, fixed by GRILL-2026-10-19 R1-A). Auto-contrast (`lib/appearance.ts`
`applyCssVars`) rewrites `--text` itself on `:root`, so every `.app` picks it up.

**Two roles, not a preset-specific class per component:**
- **in-flow** — everything living in the document flow, `.card` included (editor body, preview
  pane, attachments, sidebar, tab bar, window strip, title bar): **no opaque background.** `.card`
  owns only the hairline border + radius; the `.app` sheet underneath (opaque under flat,
  translucent under acrylic) shows straight through it. The only in-flow paint is the translucent
  body tint (`--content-tint`) on `.content-canvas` / `.modal-body` — a darkening layer over the
  sheet, not a surface of its own.
- **floating** — `.overlay` (modals, context menus, dropdowns, toasts, popovers): **always opaque
  under both presets**, `background: var(--app-sheet-base)` (not `--surface`: inside
  `.content-canvas` `--surface` is re-based onto the tinted body tone, so in-tree and portaled
  popovers would differ). There is no acrylic-specific `.overlay` rule — the earlier glass recipe
  (0.82 alpha floor, `--overlay-blur`, `saturate(1.8)`, `--glass-rim`) was removed on 2026-08-14
  when CSS blur turned out not to render in the transparent window; the owner kept the desktop
  see-through and made floating surfaces opaque. `src/styles/tokens.fonts.test.ts` asserts the
  blur/rim tokens stay gone. Glass for a floating surface is attempted as a **separate OS window**
  with native Acrylic instead (§떠 있는 표면을 OS 창으로 뺀다).
  Until 2026-08-14 the modal was a `<dialog showModal()>` in the top layer; a JS layer mirrored
  the card's rectangle onto `document.body` to fake its glass. That mirror made the card's
  background depend on JS succeeding, with no fallback — when it failed the modal rendered with no
  surface at all. `ModalShell` left the top layer (focus isolation is `inert`) and the mirror is
  deleted; `scripts/check-surface-contract.mjs` bans its identifiers from coming back.
- **`.card-reading`** — pairs with either `.card` or `.overlay` (`className="card card-reading"`)
  to add a 2px border (instead of the default 1px) on long-form reading surfaces — editor body,
  preview pane. It changes only the border; it does not opt anything out of the sheet.

**Adding a new surface correctly:** don't invent a preset-specific variant class. Decide only
whether the element is in-flow (use `.card`, paint no background) or floating (use `.overlay`,
opaque) — that's the entire decision. Never set `background: var(--surface)` (or `--bg` /
`--overlay` / `--surface-base`) **inline** on a panel element; an inline background shadows the
class rule, so the sheet (or the `.overlay` opacity) can never reach that element and it freezes
as an opaque box under every preset. The guard script `scripts/check-surface-contract.mjs`
(`npm run check:surface`) enforces this — see the SURFACE PRESET CONTRACT section below.

## Tokens must live in `:root`, never `.app`

This is a landmine that has already caused a real bug, so it gets its own callout: **every design
token must be declared on `:root`, never on `.app` or any other in-tree selector.**

`ModalShell` (`src/components/ModalShell.tsx`) renders its content via `createPortal` straight to
`document.body`, *outside* the `.app` div entirely. If tokens were scoped to `.app`, anything
inside a modal would have no CSS variables to inherit — backgrounds, borders, and dim overlays
would all resolve to their invalid/empty fallback, which is how modals once rendered fully
transparent. Scoping every token to `:root` instead means the portal-rendered modal tree sits
under the same root and inherits everything normally.

If you add a new token, put it in the `:root { ... }` block (or the `:root[data-theme='light']`
override block) in `src/styles/tokens.css` — never inside a class selector that only matches
something inside `.app`.

**정의(definition)와 재정의(re-definition)는 다르다** (2026-09-12). 위 규칙이 금지하는 것은
**오직 `:root` 밖에만 존재하는 토큰**이다 — 포털된 모달이 상속받을 값이 아예 없어지기 때문이다.
이미 `:root` 에 정의된 토큰을 서브트리에서 **다시** 정의하는 것은 허용되고, 실제로
`.content-canvas` 가 표면 기준면에 대해 그렇게 한다(위 Single-Surface 절). 모달은
`document.body` 로 포털돼 본문 바깥에 있으므로 `:root` 값을 그대로 받는다 — 그게 맞다. 떠 있는
표면은 본문의 틴트가 아니라 앱 전체 위에 뜨는 것이기 때문이다. 판정 기준: **`:root` 만 보고도
모든 토큰이 값을 갖는가?** 그렇다면 서브트리 재정의는 안전하다.

## Scale Tokens

Spacing and type sizes used to be ad-hoc — padding strings drifted across 44 different literal
values, and font sizes across 14 (with near-duplicates like `10.5px`/`11px`/`11.5px` coexisting).
`tokens.css` now defines standardized scales and new UI must use them instead of hardcoded numbers:

### Token Scales Reference

| Category | Tokens & Values | Description |
|---|---|---|
| **Type Scale**<br>(`calc(<base> * var(--fs))`) | • `--text-2xs` (9px)<br>• `--text-xs` (11px)<br>• `--text-sm` (12px)<br>• `--text-md` (13px)<br>• `--text-section` (15px)<br>• `--text-lg` (15px)<br>• `--text-xl` (19px)<br>• `--text-2xl` (22px)<br>• `--text-title` (27px)<br>• `--text-label` (10.5px) | • 9px: 조밀 눈금/확장자 배지<br>• 11px: 메타 텍스트/힌트<br>• 12px: 보조 텍스트/폼 필드<br>• 13px: 기본 UI 본문/행 라벨<br>• 15px: 그룹/섹션 제목 (라벨 위계 상위)<br>• 15px: 카드 제목/서브헤딩<br>• 19px: 모달/패널 헤더<br>• 22px: 최상위 타이틀<br>• 27px: TitleBar 노트 제목 히어로 크기<br>• 10.5px: 대문자 트래킹 소형 라벨 |
| **Font Weight** | • `400` (Regular)<br>• `600` (Semibold/Bold)<br>• `inherit` | 번들 폰트 교집합에 맞춘 **2단 사다리**. `500`/`700`/`800`/`bold` 직접 선언 금지 (게이트 강제) |
| **Spacing Scale** | • `--space-2xs` (2px)<br>• `--space-1` (4px)<br>• `--space-2` (6px)<br>• `--space-3` (8px)<br>• `--space-4` (10px)<br>• `--space-5` (12px)<br>• `--space-6` (14px)<br>• `--space-7` (18px)<br>• `--space-8` (22px) | 패딩/마진/갭 전용 9단 사다리.<br>`--space-2xs`는 "0 다음 한 칸" — 아이콘+라벨 쌍, 칩 클러스터, 툴바 아이콘 행처럼 4px면 벌어져 보이는 밀착 간격 전용이다(사다리 밖 생값 114곳을 이름 붙여 들인 것, 계산값 동일). 이보다 좁아야 하면 그건 간격이 아니라 정렬 문제다.<br>사이드바/콘텐츠 인셋은 `--sidebar-pad` / `--content-inset` (`var(--space-6)` = 14px)으로 정렬 |
| **Control Heights**<br>(`calc(a + b*var(--fs))`) | • `--ctrl-h-sm` (`10px + 16px*var(--fs)`)<br>• `--ctrl-h` (`12px + 18px*var(--fs)`)<br>• `--ctrl-h-lg` (`14px + 21px*var(--fs)`) | 글꼴 배율 `--fs` 연동 3단 컨트롤 높이 (fs=1.0 기준 각 26px / 30px / 35px). 버튼/입력필드/행 높이 표준화 |
| **Line Height** | • `--lh-tight` (1.2)<br>• `--lh-ui` (1.45)<br>• `--lh-read` (1.45) | • 1.2: 헤딩, 카드 헤더, 뱃지, **에디터 h1/h2**<br>• 1.45: 기본 UI 컨트롤, 메뉴 행, **에디터 h3**, 그리고 본문·에디터 리딩 (1.7 → 1.5 → 1.45, 2026-09-09·09-10 오너 지시)<br>**원칙 1: 글자가 커질수록 배율은 작아진다** — 무단위라 배율이 그대로 절대 간격이 되므로, 큰 글자는 같은 배율에서 줄이 흩어진다. 본문(15px)과 UI(13px)에 이 원칙을 그대로 적용한 결과 두 값이 1.45 에서 만났다 — 사다리가 두 단이 된 것은 우연이 아니다.<br>**원칙 2: 단락 사이 간격 > 줄 사이 간격.** 행간만 줄이면 단락이 덩어리로 안 읽힌다. 그래서 `--lh-read` 를 1.45 로 줄이면서 에디터 단락 margin 을 `.5em` → `.7em` 으로 키웠다(이전에는 줄 간극과 단락 간극이 둘 다 ≈7.5px 로 **정확히 같았다** — 오너가 느낀 "다른 노트앱보다 넓다"의 실제 원인).<br>**원칙 3: 행간은 행 길이(measure)와 같은 방향으로 움직인다.** 에디터 컬럼은 800px(한글 ~50자)로 넓은 편이라 1.45 가 하한선이다 — 더 조밀하게 가려면 행간이 아니라 `max-width` 를 먼저 좁혀야 한다.<br>새 리딩 표면은 이 사다리에서 고르고 생값을 쓰지 않는다. |
| **Opacity / Dim** | • `--dim-disabled` (0.45)<br>• `--dim-ghost` (0.6)<br>• `--dim-faint` (0.35) | • 0.45: 비활성화 컨트롤/행<br>• 0.6: 뮤트된 힌트, 고스트 요소<br>• 0.35: 미세 아이콘, 배경 구분선 |
| **Transition Duration** | • `--dur-fast` (0.12s)<br>• `--dur-med` (0.16s)<br>• `--dur-slow` (0.22s) | • 0.12s: 색상/투명도 호버 마이크로 인터랙션<br>• 0.16s: 그립/토글/팝오버 등장<br>• 0.22s: 오버레이 확대 등장 |
| **Z-Index Layer** | • `--z-overlay` (10)<br>• `--z-sidebar` (25)<br>• `--z-popover` (40)<br>• `--z-dropdown` (50)<br>• `--z-modal` (80)<br>• `--z-toast` (9000) | 전역 스택 계층 SSOT. 컴포넌트 지역 스태킹(0~3, auto) 외 생값 사용 금지 |

Every type token is `calc(<base-px> * var(--fs))` — see the font-scale note below for why that
matters beyond just "consistent sizing."

### Ratchet Protocol (래칫 규약)

타이포 및 간격 스케일 계약은 게이트 `npm run check:type-scale` (`scripts/check-type-scale.mjs`, `npm run check` 8종 중 하나)에 의해 래칫으로 관리됩니다:

1. **단방향 축소 원칙**: `scripts/check-type-scale.allow.json`의 베이스라인은 오직 줄어들기만 합니다.
2. **`--update` 인상 거부**: `node scripts/check-type-scale.mjs --update` 명령은 감소된 위반 수 반영 및 파일 제거만 수행하며, 위반 수가 늘어나거나 새 파일이 유입되면 `exit 1`로 실패합니다 (래칫 세탁 방지).
3. **상한 인상 절차**: 정당한 이유로 상한을 올려야 할 경우, `check-type-scale.allow.json`을 직접 수동 수정해야 하며, 이는 diff에 기록되어 코드 리뷰를 거쳐야 합니다.
4. **정당한 예외 처리**: 1px 광학 정렬이나 캔버스/SVG 기하 데이터 등 사다리 밖의 값이 정당한 경우, 해당 줄에 `/* type-scale-exempt: <구체적 이유> */` 주석을 명시합니다 (이유가 누락된 exempt는 게이트 실패 처리).

## Component Layer

Repeated interactive patterns are now defined once in `tokens.css` rather than re-implemented
per component:

| Class | Use |
|---|---|
| `.card` | In-flow panel/card surface: no background (single-sheet contract — the `.app` sheet shows through), `--divider` border, `--radius-md` |
| `.overlay` | Floating panel surface (modal/menu/dropdown/toast/popover): **always opaque** under both presets, `background: var(--app-sheet-base)` (no acrylic variant, no CSS blur). `--divider` border, `--radius-md` |
| `.card-reading` | Pairs with `.card` or `.overlay` (`className="card card-reading"`) — 2px border instead of the default 1px, for long-form reading surfaces. Used by the editor body wrapper and preview pane (`App.tsx`, `SourcePanel.tsx`) |
| `.icon-btn` (+ `--sm` / `--lg` / `--static` / `--danger`) | Square icon buttons (toolbar/header actions). `--static` removes hover for non-interactive status slots; `--danger` gives a red hover fill (used by the window-strip close button) |
| `.btn` / `.btn-primary` | Text buttons (secondary hairline / primary fill). Wave 2 migrates `btnSecondary`/`btnAccent` call sites; do not add a second button face |
| `.menu-row` | Rows in choice dialogs, context menus, tree rows — hover/focus/selected states |
| `.field` | Text inputs |
| `.label-caps` | Small uppercase tracked labels |
| `.attach` / `.related-chip` (+ `.tb-tag-x` hover rule) | Tiles and tag chips — the border lives on the class (not inline styles) specifically so `:hover` can override it without fighting inline `!important` |

**Hover and focus state belongs in CSS, not in event handlers that mutate
`e.currentTarget.style` directly.** Doing it inline fights React's rendering (the next re-render
can silently stomp the manually-set style), and it can't express `:focus-visible` or
`prefers-reduced-motion` consistently the way a CSS rule can. A few older components
(`EditorPanel.tsx`, `TitleBar.tsx`) still have a handful of these inline mutations left over from
before the component layer existed — treat them as legacy, not as the pattern to copy. All new
interactive elements should use the classes above (or add a new one here) rather than adding
another `onMouseEnter` handler.

## 테마 시스템 (Theme system) — 제3자가 쉽게 바꾸는 법

테마는 **두 축**이며, 값은 전부 `tokens.css`의 CSS 커스텀 프로퍼티다. JS는 `<html>`에 두 속성만 쓴다
(`src/stores/settings.ts` `applyCssVars`).

| 축 | 속성 | 값 | 정의 위치 |
|---|---|---|---|
| **테마(명도)** | `data-theme` | `dark` / `light` | `tokens.css` `:root`(dark 기본) + `:root[data-theme='light']` |
| **표면(재질)** | `data-surface` | `flat` / `acrylic` | `flat`=`:root` 기본(불투명), `acrylic`=`:root[data-surface='acrylic']` |

그 외 사용자 조절값(accent, 글꼴 배율 `--fs`, 배경 어둡기 `--bg-dim`, 배경 톤 `--app-canvas`, 본문 틴트
`--content-tint-color`/`--content-tint-amount`, 시트 불투명도 `--sheet-alpha`)도 전부 CSS 변수다 — 컴포넌트는 변수를 읽기만 한다.
**`--theme` 은 이 목록에 없다** — 테마별 고정값이고 사용자 손잡이가 아니다(§색 세 층). 새
테마(명도)를 추가한다면 그 블록에서 `--theme` 도 함께 정해야 한다: 같은 청자 hue·채도에서
밝기만 그 캔버스에 맞게 고르고, 구분선 알파(26%/13%)는 **건드리지 않는다**.

> **본문 틴트는 색과 세기가 두 변수다** (2026-09-12, PLAN-2026-09-12 §5/D6). `content_tint` 는
> 절대값이 아니라 **부호 있는 오프셋**이고(실효 = 테마 기준값 다크 16 / 라이트 7 + 값), 음수면
> 색이 `#000` → `#fff` 로 뒤집혀 본문이 사이드바보다 밝아진다. 부호를 색이 표현하므로 세기는
> 항상 양수 퍼센트다 — **`%` 를 빼먹으면 `color-mix` 가 통째로 무효가 되어 본문 배경이 조용히
> 사라진다.** 사이드바는 이 값을 따라가지 않는다(전역 `--bg-dim` 담당). 노트북 스위처 칩도
> `--notebook-chip-tint` 로 떼어냈다 — 사이드바에 있는 칩이 본문 밝기를 따라가면 거짓말이 된다.

> **glass 표면은 2026-07-21 제거, mica 표면은 2026-07-24 `acrylic`으로 리네임됨** (실제 OS 효과는
> 처음부터 Acrylic이었다 — `window.rs`의 `apply_style` 참고). 이제 표면 프리셋은 `flat` + `acrylic`
> 두 가지이며, 반투명은 오직 `.app` 한 곳에서만 일어난다 — SINGLE-SHEET ACRYLIC CONTRACT
> (`tokens.css` 하단 주석)가 그 계약을 정의한다.

**새 표면 프리셋을 추가하려면** (예: `sepia`):
1. `tokens.css`에 `:root[data-surface='sepia']{ ... }` 블록 추가 — SINGLE-SHEET ACRYLIC CONTRACT를
   따라 `--bg` 자체를 덮어쓰는 단일 틴트만 정의한다(CSS `backdrop-filter` 는 투명 창에서 그려지지 않는다 — 흐림이 필요하면 네이티브 창 재질). 카드/크롬이
   각자 다른 반투명값을 그리게 하지 말 것 — 그게 이 계약이 막는 정확한 회귀다.
2. `src/stores/settings.ts`의 `SurfaceStyle` 유니온에 `"sepia"` 추가.
3. `src/components/settings/AppearanceSection.tsx`의 `SURFACE_STYLES` 배열에 추가 + i18n 키 `settings.surface_sepia`
   (en/fr/ko 3개 — `check:i18n`가 강제).
4. 백엔드 `src-tauri/src/db/migrations.rs` `validate_setting`의 `surface_style` 허용목록에 추가.
5. OS 창 효과가 필요하면 `src-tauri/src/commands/window.rs`의 `action_for_style` 매핑 +
   `docs/TAURI-WINDOW.md` 갱신. (선택) 파라미터가 있으면 `XParams` 컴포넌트 + `AppearanceSection`에
   한 줄, `settings.ts`에 상태/세터/클램프, `migrations.rs`에 키/기본값.
6. 이 프리셋에 새 배경/카드 규칙이 필요해도 in-flow(`.card`, 배경 없음) vs floating(`.overlay`, 항상
   불투명) 두 역할 중 어디 속하는지만 결정한다 — 프리셋별 카드 변형 클래스를 새로 만들지 않는다.

**새 테마(명도)를 추가하려면**: `tokens.css`에 `:root[data-theme='x']` 블록(색 토큰 override) + `Theme` 유니온 +
설정 UI + `validate_setting` 의 `theme` 허용. 표면과 동일한 패턴.

배경 규칙은 항상 아래 계약을 지킨다:

## SURFACE PRESET CONTRACT — backgrounds live on classes, never inline

`data-surface` (`flat` / `acrylic`)는 오직 `.app` 한 곳에서만 반투명을 그린다(SINGLE-SHEET ACRYLIC
CONTRACT, `tokens.css` 하단). 그 안의 모든 패널은 두 역할 중 하나다:
- **in-flow** (`.card` 포함 — 에디터 본문/미리보기/첨부/사이드바/탭바/윈도우 스트립/타이틀): 배경
  없음, `.app` 시트가 그대로 비친다. 구조는 헤어라인(`--divider`/`--line`)만 만든다.
- **floating** (`.overlay` — 모달/컨텍스트 메뉴/드롭다운/토스트/팝오버): **프리셋과 무관하게 항상
  불투명** `background: var(--app-sheet-base)`. acrylic 전용 규칙도 CSS 블러도 없다. 2026-08-14
  이전엔 acrylic 에서 시트 톤 + 블러 + 0.82 알파 바닥 + `saturate(1.8)` + 그레인 + 림 하이라이트
  (`--overlay-blur`·`--glass-rim`)의 유리 레시피를 그렸는데, 창이 `transparent: true` 인 동안
  WebView2 가 `backdrop-filter: blur()` 를 화면에 반영하지 않는다는 실측으로 통째 걷어냈다 — 오너는
  데스크톱 비침을 지키고 떠 있는 표면을 불투명으로 가는 쪽을 택했다(`tokens.css` `.app` 규칙 아래
  주석, `tokens.fonts.test.ts` 가 두 토큰의 재등장을 막는다). 떠 있는 표면의 유리감은 아래
  "떠 있는 표면을 OS 창으로 뺀다"(별도 OS 창 + 네이티브 Acrylic)로 다시 시도한다.
  `--surface` 가 아니라 `--app-sheet-base` 인 이유: `.content-canvas` 안에서 `--surface` 는 틴트
  입힌 본문 톤으로 재정의되므로, body 로 포털되는 팝오버와 트리 안에서 뜨는 팝오버의 색이 갈린다.

  쌍둥이 레이어 이야기 — 2026-08-14 이전에는 모달이 `<dialog>.showModal()` 로
  top layer 에 있었고, 그 안에서는 backdrop-filter 가 페이지를 샘플링하지 못해서 body 에 카드
  사각형을 JS 로 복제한 쌍둥이 레이어가 대신 그렸다. 그 구조는 카드 배경을 JS 성공 여부에
  의존하게 만들고 폴백이 없어서, 쌍둥이가 안 그려지면 모달이 표면 없이 렌더됐다(실제 사고).
  `ModalShell` 이 top layer 를 포기하고(포커스 격리는 `inert`, 스크림은 다시 진짜 div
  `.modal-scrim`) 쌍둥이는 삭제됐다 — 재등장은 `scripts/check-surface-contract.mjs` 가 막는다.

**The rule:** a panel/overlay/backdrop MUST get its background from a class. Never set
`background: "var(--surface)"` (or `--surface-base` / `--bg` / `--overlay`) **inline** on a surface
element. An inline background shadows the class rule, so neither the sheet nor `.overlay`'s
opacity can ever reach it, and that one panel freezes as an opaque box under every preset. This
exact mistake recurred on the window strip, the tab bar, the modal scrim, and the modal header —
every time it broke the single-sheet look. Non-surface accents (`--accent`, `--sel`, folder
colors, preview art) are fine inline; only the surface-tone tokens above are reserved for classes.

Reading surfaces still go through a class: pair `.card` (or `.overlay`) with `.card-reading` for
the 2px border used by the editor body and preview pane. Form controls use `.field` (or, where an
inline opaque `--surface` on an `<input>`/`<select>` is unavoidable, it is grandfathered in the
guard's baseline — see below).

**Guard:** `npm run check:surface` (`scripts/check-surface-contract.mjs`) checks two things — (a)
any *new* inline surface background beyond the committed baseline, so that mistake can't silently
regress; (b) any reappearance of the deleted old-model identifiers (`glass`, `card-glass`,
`card-opaque`, `surface-flush`, `--surface2`, `--panel`, `--card-scene`, `--surface-alpha`,
`--mica-alpha`, `data-surface='mica'`) — a single hit fails, no baseline. If a new inline
`--surface` is genuinely intended (a form control), run the script with `--update` to record it
(baseline covers check (a) only). `npm run check` runs this alongside the i18n and settings-key
guards.

## 떠 있는 표면을 OS 창으로 뺀다 (Modal → separate window)

**왜 이런 게 존재하나.** 이 앱에서 CSS 유리는 불가능하다. 창이 `transparent: true`(네이티브
Acrylic 의 전제)인 동안 WebView2 는 `backdrop-filter: blur()` 를 **화면에 반영하지 않는다** —
계산된 스타일에는 blur 가 정상적으로 들어 있고 픽셀만 그대로다(실측: `transparent` 를 false 로
바꾸면 같은 CSS 로 즉시 블러가 걸린다). 그래서 "창 뒤 데스크톱 비침"과 "앱 내부 유리"는 상호
배타다. 그런데 **Acrylic 창은 자기 뒤에 있는 다른 창을 실제로 블러한다**(실측). 그러므로 진짜
유리가 필요한 표면은 CSS 로 흉내내지 말고 **별도 OS 창**으로 띄운다 — 컴포지터가 대신 해준다.

**어떤 표면이 대상인가.** 전부가 아니다. 창은 비싸다(WebView2 인스턴스, 상태가 React 트리 공유
대신 IPC, 포커스·z-order·화면 경계를 직접 소유).

| 대상 | 조건 | 예 |
|---|---|---|
| **창으로 뺀다** | 콘텐츠가 많고, 오래 열려 있고, 뒤 앱을 보면서 쓰는 것 | 설정(완료), 활동 이력(완료), AI 히스토리(완료), 스냅샷, 데이터 관리 |
| **모달로 둔다** | 짧은 확인·한 줄 입력·선택 한 번 | PromptDialog, AiConfirmModal, 컨텍스트 메뉴 다이얼로그 |
| **절대 창 아님** | 컨텍스트 메뉴·드롭다운·토스트·툴바 팝오버 | `.overlay` 그대로(불투명) |

모달로 남는 것들은 프리셋과 무관하게 **불투명**하다(위 SURFACE PRESET CONTRACT 3항). 유리를
CSS 로 다시 시도하지 말 것 — 위 이유로 화면에 닿지 않는다.

떠 있는 목록(`.overlay` 안의 `.menu-row.menu-item`)은 트리거와 같은 밀도다(`--text-sm`,
`--space-2/4`). `.menu-row` 기본 패딩은 선택 다이얼로그·트리 행용이고, 포털 메뉴가 그걸
물리면 글자와 칸이 한 단계 커 보인다. 밀도는 tokens.css 의 `.overlay .menu-row.menu-item`
한 규칙이 소유한다 — 소비처에서 인라인으로 다시 덮지 말 것.

### 새 창을 추가할 때의 체크리스트

전부 2026-08-14 설정 창 분리에서 실제로 밟은 함정이다. 하나라도 빠지면 증상이 조용하다.

1. **capabilities 에 라벨을 등록한다.** `src-tauri/capabilities/default.json` 의 `windows` 배열에
   새 라벨을 넣거나 별도 capability 파일을 만든다. 빠뜨리면 core 커맨드가 **조용히 거부**돼
   `data-tauri-drag-region` 드래그와 `getCurrentWindow().close()` 가 아무 반응 없이 죽는다.
   에러도 안 난다 — 그냥 안 움직인다.
2. **창을 만드는 커맨드는 `async fn` 이어야 한다.** Tauri 는 동기 커맨드를 메인 스레드에서
   실행하는데 창 생성은 그 메인 스레드의 이벤트 루프가 돌아야 완료된다 — 동기로 두면 교착한다:
   창 껍데기는 뜨는데 웹뷰는 `about:blank` 인 채 **흰 화면**이고 invoke 프로미스는 영영 돌아오지
   않는다. 펫 창이 이 함정을 안 밟은 건 커맨드가 아니라 트레이 핸들러와 `setup()` 에서만
   만들어지기 때문이다.
3. **`parent()` 가 아니라 `owner()`.** Tauri 2 의 `parent()` 는 WS_CHILD 자식 창을 만든다(부모
   클라이언트 영역에 클리핑). z-order 소유 관계를 원하면 `owner()` 다.
4. **엔트리에서 `tokens.css` 를 직접 import 한다.** 새 창은 `App.tsx` 를 부팅하지 않으므로
   그 파일 상단의 import 를 타지 않는다 — 안 하면 창 전체가 **스타일 없이** 뜬다(PetApp.tsx 와
   같은 이유).
5. **`load()` 뒤에 `applySurfaceEffectAfterShow()` 를 부른다.** `load()` 는 아크릴을 일부러 걸지
   않는다(숨겨진 HWND 에 window-vibrancy 를 걸면 창이 안 뜬다) — 적용은 그 함수로 분리돼 있고,
   본 창 부팅 경로만 부르고 있었다. 안 부르면 그 창만 영원히 flat 이다.
6. **창끼리 스토어는 별개다.** 각 웹뷰가 자기 zustand 스토어를 갖는다. 설정을 쓰는 창과 그리는
   창이 다르므로 `settings_set` 이 `settings-changed` 를 브로드캐스트하고
   `lib/settingsChanged.ts` 가 200ms 디바운스 후 `load()` 한다. 새 창도 이 리스너를 달아야
   테마·강조색 변경이 따라온다.
7. **`load()` 는 첫 로드에서만 `surfaceEffectApplied` 를 리셋한다.** 6번 리스너 때문에 `load()`
   가 수시로 다시 도는데, 매번 리셋하면 창 지오메트리 저장 같은 무해한 쓰기만으로 아크릴이
   flat 으로 되감긴다(실측: 본 창이 매 부팅 불투명해졌다).
8. **표면 프리셋은 앱 전체다.** `window_set_effect` 는 펫이 아닌 **모든 창**에 효과를 걸고,
   반환값 `applied` 는 **호출한 창** 기준이다(그 값이 그 창의 CSS 폴백 스위치라서). 다른 창은
   최선노력 — AND 로 묶으면 준비 안 된 보조 창 하나가 본 창을 flat 으로 떨어뜨린다.
9. **창 안의 팝오버는 `popoverRoot` 를 탄다**(`lib/ui.ts`). 모달 스크림 안에서는 스크림의
   자식으로, 아니면 body 로 간다.
10. **커맨드 이름 가드.** 스펙 yaml 없이 `lib.rs` 에 직접 등록한 커맨드는
    `src/lib/commandNames.test.ts` 의 `UNSPECCED` 에 넣어야 테스트가 통과한다.
11. **브라우저 모드 한계.** 동기화 탭(/app)에는 OS 창이 없다. 창을 여는 버튼은 그쪽에서 조용히
    무동작이 된다 — 의도한 천장이면 `ponytail:` 주석으로 남기고, 아니면 그 클라이언트에서만
    인앱 패널로 같은 컴포넌트를 렌더한다(패널 컴포넌트는 창/모달과 무관하게 재사용 가능해야 한다).

### 창의 내용물은 패널 컴포넌트로 분리한다

`SettingsPanel` 이 판례다: ModalShell 을 쓰지 않고, 자기 스크롤 컨테이너를 소유하고, `onClose`
콜백만 받는다. 창 크롬(제목/닫기/드래그)은 창 루트(`settings/SettingsWindowApp.tsx`)가 그린다.
이렇게 나눠야 같은 패널을 브라우저 모드에서 모달로도 띄울 수 있다.

## Font Scale Is App-Wide

The "Taille police" (font scale) slider in Settings sets `--fs`, and *every* type token
(`--text-xs` … `--text-2xl`, `--text-label`, `--text-2xs`, `--text-section`) multiplies by it.
Type scale and box scale move together under `--fs`: control height tokens (`--ctrl-h-btn: 32px`, `--ctrl-h-field: 34px`) scale with the font scale to prevent clipping or misalignment.

The rule for dense UI: **tolerate large text by wrapping, shrinking, or reducing density — never
by clipping.** The concrete example already in the codebase is the year-axis tick rendering in
`src/components/leftpanel/YearFilter.tsx`: the number of ticks drawn is computed from *both* the
available sidebar width and the current `--fs` value (wider labels at high `--fs` mean fewer ticks
fit, so the axis thins itself out rather than truncating or overlapping labels).

UI chrome uses `--font-body` (`Source Sans 3` + self-hosted `Noto Sans KR`). `--font-heading`
is an alias of `--font-body` — a heading is size, not weight and not a second face (Decision ①). Hangul in the UI is
always the self-hosted Noto Sans KR file; `system-ui` is a Latin-only fallback and must not be
relied on for Korean. Editor prose stays `--font-editor` (Pretendard by default).
`--font-mono` is Source Code Pro for code.

## Token Table

| Token Variable | Description | Light Value | Dark Value |
|----------------|-------------|-------------|------------|
| `--paper-texture` | Inline SVG noise data-URI | `url(...)` (4% opacity) | `url(...)` (2.5% opacity) |
| `--app-canvas` | Base hanji tone (before `bg-dim`) | `#f4efe3` | `#171b1a` |
| `--surface-base` | `--app-canvas` mixed with `bg-dim`. **Re-based inside `.content-canvas`** to "sheet + body tint" so every surface in the body sits on the tone the body actually paints (§Single-Surface) | `color-mix(--app-canvas, bg-dim% black)` | same formula |
| `--app-sheet-base` | `= --surface-base`, named once more so `.content-canvas` can read the **pre-tint** sheet without a self-reference cycle. Never re-define it outside `:root` | same | same |
| `--surface` | Alias of `--surface-base` — single-surface principle. Re-declared verbatim in `.content-canvas` (substitution freezes at the declaration site, so the alias does not follow a re-based `--surface-base` on its own) | same tone | same tone |
| `--sheet-alpha` | SINGLE-SHEET ACRYLIC CONTRACT knob — `.app`'s own sheet opacity (0–1, default 0.85, acrylic-only). The only sheet knob: the old `--surface-blur` was removed with CSS blur (2026-08-16) — see tokens.css contract comment | same | same |
| `--theme` | ① Theme color — the app's identity color, fixed per theme, **not a user knob**. Paints structure: hairlines, background saturation, the OS acrylic tint | `#33573a` | `#9cc5a4` |
| `--divider` / `--line` | Hairlines that create structure now that surfaces are one tone. **Theme-derived, never accent-derived** (2026-09-12): a red/blue accent must not turn every line pink, and a chroma-0 accent must not grey them out. One rule for both themes — same formula, same two alpha steps; only `--theme` differs | `color-mix(--theme 26%, transparent)` / `13%` | same formula |
| `--sel` / `--hover` | The only backgrounds: accent-tinted selection / hover | `color-mix(accent 16%/8%, transparent)` | same formula |
| `--bg` | `.app`'s own canvas: texture + accent glows + solid canvas fallback under `flat`; overridden to a single `color-mix(--surface-base × --sheet-alpha)` tint under `:root[data-surface='acrylic']` so `.app` itself is the one translucent sheet, sitting over the real Windows Acrylic material behind the (`transparent:true`) window — see tokens.css SINGLE-SHEET ACRYLIC CONTRACT | Hanji warm white gradient (flat) / sheet tint (acrylic) | Night Hanji grey-green gradient (flat) / sheet tint (acrylic) |
| `--ink` | Primary text color for editor | `#3b3833` | `#e0deda` |
| `--text` | Primary UI text color | `#3b3833` | `#e0deda` |
| `--accent` | Primary brand/interaction color | `#7da98c` (Celadon) | `#9cc5a4` (Bright Celadon) |
| `--font-editor` | Prose/editor stack (Settings > Appearance > Font overrides it at runtime) | `'Pretendard', 'Source Sans 3', system-ui, sans-serif` | `'Pretendard', 'Source Sans 3', system-ui, sans-serif` |
| `--font-body` | UI sans-serif. Hangul is self-hosted Noto Sans KR — `system-ui` is Latin-only fallback, not a Hangul fallback | `'Source Sans 3', 'Noto Sans KR', system-ui, sans-serif` | `'Source Sans 3', 'Noto Sans KR', system-ui, sans-serif` |
| `--font-heading` | Alias of `--font-body` — heading is weight, not a second face | `var(--font-body)` | `var(--font-body)` |
| `--font-mono` | Code / mono stack | `'Source Code Pro', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | `'Source Code Pro', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |
| `--space-1..8` | Spacing scale (4px → 22px) | same | same |
| `--text-2xs/xs/sm/md/lg/xl/2xl`, `--text-label`, `--text-section` | Type scale, all `calc(px * var(--fs))` | same | same |
| `--ctrl-h-btn`, `--ctrl-h-field` | Control height scale (32px / 34px at fs=1) | `calc(32px * var(--fs))` / `calc(34px * var(--fs))` | same |
| `--lh-tight`, `--lh-ui`, `--lh-read` | Line-height ladder (1.2 / 1.45 / 1.45) | same | same |
| `--dim-disabled`, `--dim-ghost`, `--dim-faint` | Opacity dim tokens (0.45 / 0.6 / 0.35) | same | same |

## Hairline Principle (선 원칙, W24)

모든 구분선은 **1px** 이다(두께로 위계를 만들지 않는다). 위계는 색 두 단계로만 표현한다:

- **`--divider`** (진한 헤어라인) — **구조 경계**: 헤더 행 하단(대시보드/노트 공통),
  패널·구역 사이(어시스트↔에디터, 첨부 상단), 캔버스 외곽선, 탭 행, 툴바/상태줄 경계.
- **`--line`** (옅은 헤어라인) — **그룹 내부 구분**: 리스트 행 사이, 카드/그룹 안의
  서브섹션, 사이드바 푸터처럼 같은 영역 안의 층. **설정 창은 예외 — 거기선 `--line`을 쓰지
  않는다**(§설정 레이아웃 ②).

두 토큰 모두 **테마색 `--theme` 파생**이다(2026-09-12, PLAN-2026-09-12 §2/E1) —
`color-mix(in srgb, var(--theme) 26%|13%, transparent)`, **양 테마 같은 식·같은 알파**.
경위: 원래는 accent 26%/13% 파생(=청자 선)이었는데 강조색 hue 가 열리면서 레드·블루 화면에
녹색 선만 남았다. 잠시 `--text` 계열 무채색으로 돌렸으나 이번엔 화면이 탁해졌다(오너 QA).
선은 강조도 무채도 아니라 **앱의 구조색**이라는 것이 결론이고, 그래서 사용자가 못 바꾸는
`--theme` 을 따로 뒀다(§색 세 층). 강조가 맞는 `--sel`/`--hover`와 검색 하이라이트
(`--search-hit`)는 그대로 accent 파생이다.

규칙: (1) 같은 종류의 경계는 모든 화면에서 같은 단계를 쓴다 — 대시보드 헤더 밑선과 노트 헤더
밑선이 다르면 위반이다(W24에서 실제 수정). (2) 선의 양끝은 특별한 이유가 없는 한 컨테이너
안쪽 면까지 닿는다(풀블리드, W22 ⑧). (3) 새 회색/알파를 발명하지 않는다 — 두 토큰 밖의 선
색이 필요해 보이면 위계 설계가 잘못된 것이다.

## Row / Button / Motion Ladders (W24)

**행 높이 4단** — 크롬 행은 바깥에서 안으로 갈수록 낮아진다. 행 높이의 단일 소스는 항상
컨테이너의 고정 `height`이고, 내용물(탭·버튼)은 상하 패딩 없이 flex 로 세로 중앙 정렬한다
(내용물 패딩이 행을 키우는 순간 옆 패널의 선과 어긋난다 — W24 섹션 탭 수정의 교훈):

| 단계 | 값 | 쓰는 곳 |
|---|---|---|
| 창 크롬 | 48px | 창 상단 컨트롤 스트립, 사이드바 스위처 스트립 |
| 문서 탭 | 40px | TabBar(문서 탭 행) |
| 섹션 툴바 | `--row-toolbar` (40px) | 리치텍스트 / 시트 / 관계도 툴바 행 |
| 구역 헤더 | `--row-tabs` (36px@fs1) | 섹션 탭, 어시스트 헤더, 첨부 헤더 |

**버튼 크기 3단** — `.icon-btn--sm` 26 / `.icon-btn` 30 / `.icon-btn--lg` 36. 예외는
`.toolbar-btn`(30×28, 40px 툴바 행 전용) 하나만 인정하고 새 크기를 만들지 않는다.
텍스트를 담는 툴바 버튼은 `.toolbar-btn toolbar-btn--text`(높이 28px 고정, `padding:0 var(--space-3)`, 텍스트+셰브런 인라인 flex) 모디파이어를 사용한다.

**상태줄 좌/우 슬롯 규약 (W26)** — `.section-statusbar` 는 세 섹션(리치텍스트/시트/관계도)이 공용하며 다음 두 슬롯으로 고정한다:
- **좌 = 문서 상태**: `<BodyCollapseToggle/>` 가 항상 첫 요소 → 그 뒤에 섹션별 통계 (`display:flex; align-items:center; gap:var(--space-7)`).
- **우 = 도움말**: `<CheatsheetPopover/>` (`?` 원형 버튼 토글) 하나만 위치하며, 상시 켜져 있는 인라인 힌트는 두지 않는다.

**전환 시간 3단** — 마이크로 인터랙션은 `--dur-fast`(.12s, 색/투명도 호버) /
`--dur-med`(.16s, 그립·토글·팝오버 등장) / `--dur-slow`(.22s, 확대되며 나타나는 오버레이 —
호버 프리뷰·고스트+ 메뉴)만 쓴다. 더 긴 값은 장식 애니메이션(shimmer, breathe) 전용이며
루프 애니메이션은 hover 1회 원칙(아래 Prohibitions)을 따른다.

**라운드(r) 사다리(W24)** — `--radius-xs`(4) / `--radius-sm`(6, 버튼·칩·입력) /
`--radius-md`(10, 카드·팝오버·캔버스) / `--radius-lg`(16, 히어로 박스 — 날씨 창 등) /
`--radius-pill`(999, 알약 배지·프로그레스 바) / `50%`(원). px 리터럴 금지 — 8px·12px 같은
사다리 밖 값은 가까운 단으로 스냅한다(W24에서 일괄 이행). 예외: 높이 ~10px 이하의 장식
요소(칸반 점, 미니 스파크 등)에 한해 1–3px 미세 라운드를 리터럴로 허용한다 — 토큰을 더
만들지 않기 위한 의도적 바닥이다.

## 설정 레이아웃 (Settings layout)

**⓪ 창 프레임은 메인 창과 같은 관계다**(GRILL-2026-10-19 R1-D/E — PLAN-2026-09-15 D10 ②③ 대체).
좌측 레일은 메인 사이드바처럼 **칠도 우측 선도 없이** 맨 시트 위에 서고, 오른쪽 칸은 맨 시트 위
`--row-chrome`(48px) 닫기 스트립 + 그 아래 틴트·외곽선·좌상단 라운드·8px 인셋을 모두 가진
`.content-canvas` 다(인라인으로 프레임을 지우지 않는다). 다른 보조 창(브리핑·활동 이력·AI 히스토리·
섹션 분리)의 `AuxWindowChrome` 머리줄도 `--row-chrome` 높이 · 아래 구분선 없음 · 제목 `--text-lg`/600
(설정 레일 헤더와 같은 크기) 이다. 글자색은 `.app` 클래스가 모든 창에 준다(§Single-Sheet).

**① 위계는 3단뿐이다.**
| 단 | 무엇 | 표현 |
|---|---|---|
| 페이지 | 좌측 레일이 고른 것 | **페이지 히어로는 없다**(2026-10-24 D3 — 사이드바 선택이 페이지 이름을 말하고 범위는 창 헤더 칩이 말한다). 마스터 스위치는 페이지 첫 줄 `SettingsRow`(첫 카드), 상태 `Badge` 는 그 행 라벨 옆, 동작 버튼은 관련 카드 `SectionHeader.actions` 에 둔다. |
| 그룹 | 카드 하나 = 관심사 하나 | `SectionHeader`(`--text-section` / `font-weight: 600` / `var(--text)`) |
| 행 | 값 하나 = 컨트롤 하나 | 라벨 `--text-md` + 힌트 `--text-xs muted` |

- 그룹 안에 하위 그룹이 필요하면 제목은 `--text-md / weight 600 / --text`이고 그 위에 `--divider` 헤어라인을 둔다(②와 같은 선 — 하위 그룹 경계도 영역 경계다). `--text-xl`·`--text-lg`로 손수 키우지 않는다.
- 행이 4개를 넘고 성격이 갈리면 카드를 쪼갠다(하위 제목을 만들지 않는다).
- **카드 최상단의 트레일링 액션**(design-review 2026-09-14 §4-A)도 `SectionHeader`의 `actions` 슬롯
  하나로 통일한다 — ⑦의 `SubGroup.actions`와 같은 계약, 우측 정렬 · title 옆 한 줄. **카드/페이지
  전체를 켜고 끄는 "마스터 토글"은 항상 여기 꽂는다**(§4-E) — 헤더 없는 단독 행이나 다른 헤더 아래
  평범한 행으로 두지 않는다. 카드가 통째로 그 토글에 종속되는 경우(펫·캔버스 플러그인 카드처럼)엔
  `title`을 페이지 라벨과 동일하게 채운 `SectionHeader`를 카드 맨 위에 둔다.

**② 구분선.** 선은 **영역 경계**에만 긋는다(PLAN-2026-09-12 §2/D2):
- ⓐ 카드와 카드 사이, ⓑ 카드 안 하위 그룹과 하위 그룹 사이 — **둘 다 같은 `--divider`**.
- **옵션 행 아래에는 긋지 않는다.** 행 사이는 선이 아니라 간격(`--space-*`)이 가른다.
- 설정 창 안에서 `--line`을 새로 쓰지 않는다. 두 번째 선 색이 곧 두 번째 뜻이기 때문이다.
- 컨트롤 외곽선(`SegGroup` 테두리, `.field`, `.overlay`, `Toggle` 트랙)은 구분선이 아니다 — 규칙 대상 밖이고 그대로 둔다.
- 새 회색·알파를 인라인으로 발명하지 않는다.

> 왜 바뀌었나: 오너 QA에서 "펫 표시" 아래의 **행 선**과 "트레이 기능" 위의 **영역 선**이 같은 굵기·같은 색으로 나란히 놓여, 어디가 묶음의 끝인지 읽히지 않았다. 고칠 점은 선의 개수가 아니라 **선이 한 가지 뜻만 갖게** 하는 것이다. 예전 2단 규칙(카드 사이 `--divider` / 행 사이 `--line`)은 폐기됐다.
>
> 게이트: `scripts/check-surface-contract.mjs` (h) — `src/components/settings/**`와 `SettingsPanel.tsx`의 `border`/`borderTop`/`borderBottom`에 `var(--line)`이 등장하면 실패한다(남은 위반은 래칫 베이스라인으로 묶여 있고 늘어나는 것만 막는다).

**③ 문구.** 행 힌트는 한 줄이 상한.
- 두 줄이 필요하면 `?` 버튼(FeatureBriefModal)이나 title 툴팁으로 내린다.
- **예외**: AI 기능 카탈로그 행의 ⓘ 툴팁(`HintBadge`, `detailKey`)은 2~3문장이어도 그대로 툴팁에 둔다(2026-09-15 D6) — 한 줄 상한은 행 힌트에만 적용된다.
- 상태가 바뀔 때마다 문구가 통째로 갈리는 힌트를 쓰지 않는다.
- 금지 어휘: 화면 문구에 이모지 프리픽스를 붙이지 않는다.

**④ 비활성(disabled) 표현.**
- 행 전체를 opacity로 죽인다(값: `--dim-disabled: .45`).
- 사유는 title 툴팁 + aria-label 접미로만 준다.

**⑤ 2단 배치 조건.**
- 좌측이 시각 요소(지도·QR·미리보기)이고 우측이 입력/판독일 것.
- 640px에서 우측 열이 최소 240px를 확보할 것. 아니면 세로로 쌓는다.
- 열 폭은 **고정 px 이 아니라 `repeat(auto-fit, minmax(260px, 1fr))`** 이다 — `260px 1fr` 로 박으면
  창을 키워도 좌측 시각 요소가 안 자라고, 좁히면 무너지는 대신 잘린다(지역 페이지, D12).

**⑥ 스위치 그리드.** (`src/components/settings/SwitchGrid.tsx`, PLAN-2026-09-12 §3/D3)

| | |
|---|---|
| **쓴다** | 서로 **독립**인 on/off 토글이 **3개 이상** 연속될 때 |
| **안 쓴다** | 값 컨트롤(셀렉트·슬라이더·텍스트 입력). 토글이 둘 이하일 때. 하나가 다른 하나를 켜야 의미가 생기는 **종속** 토글 |

- `grid-template-columns: repeat(auto-fit, minmax(210px, 1fr))` — 본문 740px에서 3열, 좁히면
  2열 → 1열로 자동 붕괴(설정 창 최소 폭 560px에서 본문 ≈400px).
- **셀 안에서 토글은 라벨 바로 뒤에 붙는다. 우측 정렬하지 않는다** — 폭이 고정인 컨트롤은 우측
  정렬의 이득이 0이고, 라벨과 토글 사이에 폭만큼의 빈 강만 만든다(같은 행인지 눈으로 다시
  확인하게 된다). 힌트(ⓘ)는 `SettingsRow`와 같은 형태로 라벨 옆에.
- **값 컨트롤을 여기 넣지 않는 이유**: 그것들은 폭이 필요하고, 세로로 줄 맞은 우측 정렬이 값
  비교를 돕는다. 1열 `SettingsRow` + 220px 우측 정렬(`SETTINGS_CTRL_WIDTH`)을 그대로 쓴다.
- 위험도가 다른 토글을 한 격자에 섞지 않는다 — 격자를 나누고 카드를 나눈다(AI 권한 페이지가
  읽기 2 / 쓰기 2 / 안전장치 2 로 셋으로 선 이유).
- **예외**(design-review 2026-09-14 §4-H, 문서-구현 정합화): 같은 카드 계열 안에서 카드마다
  토글 개수가 갈려도(예: AI 권한의 세 카드가 전부 2개씩) **그 계열 전체가 SwitchGrid로 통일**한다
  — "토글 둘 이하는 안 쓴다"는 좌우 정렬 기준이 카드마다 따로 노는 걸 막기 위한 규칙이고, 같은
  계열 안에서는 그 반대(정렬 기준을 카드마다 다시 계산)가 더 흔들린다.
- **항목 수가 열 수의 배수가 아니면 마지막 줄에 혼자 남는 셀이 생긴다** — 210px 최소폭에서
  본문 740px 기준 3열이므로, 4번째 항목은 다음 줄에 혼자 남아 카드 폭의 2/3를 비운다(설정 리뷰
  2026-09-13, `GeneralSection`의 옛 4토글 격자에서 실측). 그리드에 넣을 항목이 3의 배수가 아니면
  성격이 다른 항목(값과 짝인 토글 등)을 격자 밖 `SettingsRow`로 내려 배수를 맞춘다 — 그리드 CSS로
  마지막 줄을 늘리려 하지 않는다.

**⑦ 카드 안 하위 그룹 부품.** (`src/components/settings/SubGroup.tsx`)

한 카드 안에서 관심사가 여러 개(예: 통계·자동 백업·원본 처리 = "데이터가 어떻게 보관되는가")로
갈리되 **관심사 하나하나가 카드를 따로 받을 만큼 무겁지 않을 때** 쓴다 — 그런 항목들을 전부
1행짜리 카드로 흩어 놓으면 페이지가 무게가 같은 카드 여러 장으로 늘어서 스캔 기준이 사라진다
(①의 "관심사 하나 = 카드 하나"를 과도하게 잘게 쪼갠 상태). `title`(`--text-md`/600/`--text`,
`SectionHeader`보다 한 단 아래) · `divider`(앞 하위그룹과의 `--divider` 경계, 첫 하위그룹은 생략)
· `actions`(하위그룹 제목 옆 트레일링 버튼 — "데이터 폴더 열기"/"지금 백업"처럼 카드 헤더에 손으로
반복 구현하던 제목+버튼 조합을 여기로 통일한다) 세 슬롯을 받는다.

**⑧ 빈 상태(empty state).** (design-review 2026-09-14 §4-G) 두 형(form)만 쓴다 — 셋째 변형을
손으로 새로 만들지 않는다.

| 데이터 모양 | 형태 |
|---|---|
| 표(테이블) | 열 헤더는 유지, 본문 자리에 **가운데 정렬** 문구 1줄(`--text-sm` / `--muted`) — 수집 페이지의 소스 테이블이 기준 |
| 행 목록 / 카드 안 리스트 | 헤더 없이 **좌측 정렬** 문구 1줄, 카드 좌우 인셋과 동일한 들여쓰기(`--text-sm` / `--muted`, `padding: var(--space-2) 0`) — 챗 메모리 · 반복 일정 · 펫 프리셋이 기준 |

표는 열 구조 자체가 정보라 헤더를 지우면 안 되고(그래서 가운데 정렬로 무게를 준다), 나머지는
전부 한 줄 문구가 행 하나를 대신하는 것뿐이라 그 행과 같은 정렬(좌측)을 쓴다.

**배지(badge).** `SectionHeader`/`SubGroup`의 `badge` 슬롯은 `src/components/settings/Badge.tsx`
(`tone: "neutral" | "accent" | "danger"`) 하나로 통일한다(design-review 2026-09-14 §4-B) — 테두리 없는 색상
텍스트나 파일마다 다시 만든 알약을 새로 추가하지 않는다.
2026-10-19(GRILL R8)부터 앱 전체의 **글자 든 배지**가 이 모양 한 벌을 쓴다 — `styles/tokens.css` 의
`.badge` + `data-tone="accent|danger|warn|info|success|muted"`(없으면 muted): 톤 색 12% 틴트 바탕 · 35% 테두리 ·
톤 색 글자(라이트의 accent 만 `--badge-accent-ink` 비율로 `--text` 를 섞어 4.5:1 확보). 설정 `Badge`·공용
`Pill` 은 이 클래스의 얇은 래퍼다. 자기 모양이 따로 있는 칩(관계도 그룹 머리 칩·범례/노드 버블의 켜진 색 칩)은
`--badge-tint`·`--badge-line` 만 빌린다. 점·색 견본·채운 숫자 배지(설정 레일 개수 등)·버튼은 이 어휘가 아니다.

**⑨ 설정 공용 컴포넌트 시스템 (Common Settings Components, 2026-09-14)**

설정 페이지 전반의 시각적 일관성과 정보 구조 표준화를 위해 다음 4종의 공용 컴포넌트를 정의하고 사용한다. 모든 컴포넌트는 한지(Hanji: 단일 서피스 캔버스), 청자(Celadon: 악센트 틴트 및 활성 상태), 먹(Ink: 선명한 텍스트 위계)의 3재료 원칙을 엄격히 준수한다.

### 1. (삭제) `SettingsPageHeader`
2026-10-24 D3 로 컴포넌트째 삭제했다 — 페이지 히어로(아이콘·제목·설명)와 `page_desc_*` 문구는 없다. 옛 히어로 `actions` 는 위 위계 표의 규칙대로 첫 행·행 라벨 옆·카드 머리줄로 갔다.

### 2. `SettingsToggleGrid` (`src/components/settings/SettingsToggleGrid.tsx`)
독립적인 설정 토글들을 정돈된 2열 그리드로 배치하는 컴포넌트 (`GeneralSection`, `AiPermissionsSection` 등에서 활용).
- **2열 레이아웃**: `grid-template-columns: repeat(2, minmax(0, 1fr))`, 행 간격 `--space-7` (18px).
- **수직 헤어라인 구분선**: 좌측 열 셀 우측에 `1px solid var(--divider)` 경계를 적용하여 열 간 명확한 시각적 구획 형성.
- **셀 구조**: 볼드 라벨(`--text-md`, 600 weight, `var(--text)`), 선택적 힌트(`--text-xs`, `var(--muted)`), 선택적 도움말 팝오버(`helpPopover`), 우측 끝 정렬(`margin-left: auto`) 스위치(`Toggle`).
- **테스트 식별자 보존**: 각 아이템의 커스텀 `testId`를 우선 보존하며, 미지정 시 기본값 `switch-grid-toggle-${item.id}` 부여.

```ts
export interface SettingsToggleItem {
  id: string;
  label: string;
  hint?: string;
  helpPopover?: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}

export interface SettingsToggleGridProps {
  items: SettingsToggleItem[];
  columns?: number; // 기본값 2
  testId?: string;
}
```

### 3. `MetricTileGroup` / `MetricTile` (`src/components/settings/MetricTileGroup.tsx`)
통계 및 지표 요약을 3열 카드로 균형 있게 보여주는 메트릭 컴포넌트 (`GeneralSection` 저장소 통계, `AiCapabilityCatalog` 기능 요약 등).
- **3열 그리드**: `grid-template-columns: repeat(3, minmax(0, 1fr))`, 간격 `--space-5` (12px).
- **타일 외형**: `background: var(--surface-sunken)`, `border: 1px solid var(--divider)`, `border-radius: var(--radius-sm)`, 패딩 `var(--space-6) var(--space-7)` (14px 18px).
- **내부 요소**: 좌측 36×36px 청자 틴트 아이콘 상자(`color-mix(in srgb, var(--accent) 15%, transparent)`), 우측 대형 볼드 수치(`--text-xl`, 600 weight, `var(--text)`), 라벨(`--text-sm`, `var(--muted)`), 선택적 보조 설명문(`--text-xs`, `var(--muted)`).

```ts
export interface MetricTileItem {
  id: string;
  icon: React.ReactNode;
  value: string | number;
  label: string;
  subtext?: string;
  testId?: string;
}

export interface MetricTileGroupProps {
  tiles: MetricTileItem[];
  columns?: number; // 기본값 3
  testId?: string;
}
```

### 4. `StorageGauge` (`src/components/settings/StorageGauge.tsx`)
디스크 및 리소스 사용량을 직관적으로 보여주는 게이지 프로그레스 바.
- **상단 정보 행**: 좌측 상세 구성 텍스트(`--text-sm`, `var(--muted)`, 400 weight), 우측 용량 비율 텍스트(`--text-sm`, `var(--muted)`, 600 weight, 미지정 시 `formatSize`로 자동 서식화).
- **게이지 트랙**: 높이 6px, 완전 둥근 알약 반경(`var(--radius-pill)`), 침잠 배경(`var(--surface-sunken)`).
- **악센트 채움 바**: `usedBytes / totalBytes` 비율로 산출(0% ~ 100% 클램핑), 청자 악센트 채움(`var(--accent)`), 알약 반경(`var(--radius-pill)`), `role="progressbar"` 접근성 속성 제공.

```ts
export interface StorageGaugeProps {
  usedBytes: number;
  totalBytes: number;
  breakdownText: string;
  ratioText?: string;
  testId?: string;
}
```

## Design Rules & Prohibitions
- **NO Taglines, Helper Text or Secondary Labels**: Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout.
- **NO Excessive Celadon Backgrounds**: Celadon must only be used as an accent (highlights, buttons, selection). It must not flood large container backgrounds.
- **NO Continuous Animations**: Animations like the shimmer sweep must only occur once on interaction (e.g., `:hover`) and complete swiftly (400ms).
  - **예외 — AI 작업 신호(`tokens.css` AI-GLOW, 2026-09-26 오너 결정)**: AI 가 대상을 손대는 **동안만**
    루프한다(`data-ai-glow="active"`, 끝나면 페이드 아웃). 넓은 면(에디터 창·챗 입력 칸, `data-ai-glow-beam`)은
    테두리 빛줄기, 나머지 작은 호스트(트리 행·탭·칩·어시스트 행)는 글자색 흐름(잉크)이다 — 작은 호스트까지
    박스를 두르면 과하고, 16개 동시 실측에서 121→45fps 로 떨어졌다. 새 호스트를 붙일 때도 이 둘 중에서 고른다.
    - **단 하나의 상시 예외 — AI 진입 버튼(`AiActionsMenu`, `.ai-entry`, 같은 날 오너 결정)**:
      테두리 링이 아니라 **아이콘 글리프 자체가 발광**한다 — 잉크와 같은 색 흐름(4s) + 두 겹
      drop-shadow 숨쉬기. 노트 제목 줄(☆ 옆) 한 곳에만 있다(섹션 툴바에는 두지 않는다).
      다른 요소에 상시 발광을 늘리지 않는다.
- **NO Absolute Black**: Avoid `#000000` for text; use the defined `--ink` colors which harmonize with the Hanji backgrounds.
- **NO accent-derived structure**: hairlines, background saturation and the OS tint use `--theme`, never `--accent` — the accent is the user's hue, and structure must not follow it (§색 세 층). Conversely, don't paint selection/hover/focus with `--theme`.
- **NO Component-Level Color Overrides**: All components must use CSS variables from `tokens.css`. Modifying component styles to bypass tokens indicates a flaw in the token design.
- **NO tokens outside `:root`**: see the portal callout above — this has caused a real, shipped bug (fully transparent modals).
- **NO fixed-width assumptions for dense UI**: `--fs` scales everything; layouts must degrade by wrapping/shrinking/thinning, never by clipping.
- **NO hover-driven size changes**: `:hover` (and `onMouseEnter`) may change color, border-color, shadow, opacity — never width/height/padding/font-size or any property that reflows neighbors. Layout must be identical with and without the pointer. Floating layers (overlays, portals) may use `transform: scale()` for entrance animation because transforms don't reflow; in-flow elements may not grow even via transform (visual jump reads as reflow). Lesson: the W22 ghost-+ inline expansion (tile grew on hover, neighbors shifted) — discarded and rebuilt as a portal overlay.
- **Strict Color Token Enforcement (No Color Literals)**: `scripts/check-colors.mjs` strictly bans raw hex (`#...`), `rgb()`, `rgba()`, and `hsl()` literals in all UI source files (`src/**/*.{tsx,ts,css}`). Every color must resolve through tokens in `tokens.css` or CSS `color-mix()`.
- **Only Declared Font Weights (400 / 600)**: Only font weights with loaded faces (400 regular, 600 semi-bold, and inherit) may be declared in CSS/TSX. Declaring 500, 700, 800, or `bold` is strictly forbidden and blocked by `scripts/check-type-scale.mjs`.
- **Type Scale Scale Variable Requirement**: Font sizes in TSX must use `var(--text-*)` (e.g. `--text-xs` through `--text-2xl`) and must not declare raw pixel numbers (`fontSize: 14`), ensuring full responsiveness under `--fs` user scaling.
- **Settings Hairline Contract**: In `src/components/settings/`, hairline borders may ONLY use `var(--divider)`. `var(--line)` is forbidden in settings components by `scripts/check-surface-contract.mjs` (Section h).
- **Strict Spacing Ladder Compliance**: All padding, margin, and gap values must strictly use tokens or ladder literals from `{0, 4, 6, 8, 10, 12, 14, 18, 22}px` (`--space-1` through `--space-8`), enforced by `scripts/check-type-scale.mjs`.
- **Surface Preset Contract**: In-flow elements must get backgrounds from classes (or none), never via inline `background: var(--surface)` which breaks single-sheet acrylic transparency.

