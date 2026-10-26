# Tauri v2 Window Management Rules

## 권한 (Capabilities)
모든 window API(예: `minimize`, `toggle-maximize`, `close`, `destroy`, `start-dragging`)는 Tauri v2에서 명시적인 capabilities 권한이 필요합니다. 
`src-tauri/capabilities/` 내 설정 파일(예: `default.json`)의 `permissions` 배열에 다음과 같이 추가해야 합니다:
- `core:window:allow-minimize`
- `core:window:allow-toggle-maximize`
- `core:window:allow-close`
- `core:window:allow-destroy`
- `core:window:allow-start-dragging`

## 창 닫기 (Close vs Destroy)
`getCurrentWindow().onCloseRequested`에서 `e.preventDefault()`를 호출하여 기본 닫기 동작을 취소한 경우, 리소스를 정리한 후 **직접 `destroy()`**를 호출하여 창을 닫아야 합니다.
이때 `capabilities`에 `core:window:allow-destroy` 권한이 누락되어 있으면 `destroy()` 호출이 권한 거부(조용히 실패)되어 애플리케이션이 닫히지 않는 버그가 발생합니다.

*이번 버그 사례 (P26)*: `onCloseRequested`에서 `preventDefault` 후 백그라운드 태스크(받아쓰기 임시 WAV 정리 등)를 처리하고 `destroy()`를 호출했으나, 권한이 없어 앱이 종료되지 않는 문제가 있었습니다. 권한 추가 및 실패 시 `window.close()`로 폴백하는 로직을 추가하여 해결했습니다.

## 커스텀 프레임과 드래그 영역 (Drag Region)
Tauri v2에서는 CSS의 `WebkitAppRegion` (예: `-webkit-app-region: drag;`) 설정이 **동작하지 않습니다**.
창 드래그 영역을 지정하려면 HTML 요소에 반드시 `data-tauri-drag-region=""` 속성을 추가해야 합니다.

주의: `data-tauri-drag-region`이 설정된 영역 내부의 요소들은 이벤트 전파가 OS 수준에서 차단될 수 있습니다 (mousedown 등). 내부의 상호작용 가능한 요소(버튼 등)를 클릭할 수 있게 하려면, 해당 요소를 의미론적으로 상호작용 가능한 태그(`<button>`, `<a>`, `<input>` 등)로 구성하거나, `data-tauri-drag-region="false"` 속성을 명시적으로 부여해야 합니다.

## Chrome layout (verify against `src/App.tsx` before changing)

The custom-frame chrome was restructured from a single top strip into a **row** layout, and it is
easy to regress by accident — the rules below describe the current, correct shape.

```
.app (row flex, full viewport)
├─ LeftPanel            — full-height sidebar, first child of the row. Unmounted entirely when
│                          collapsed (zero width, not just visually hidden) — see below.
└─ main column (column flex, flex:1)
   ├─ window strip      — 48px, draggable, holds (left→right): sidebar-expand/collapse toggle
   │                       (chrome-mode only) → draggable spacer → settings button → divider →
   │                       minimize / maximize / close
   ├─ TabBar             — stacked BENEATH the window strip, not merged into it (chrome-mode only)
   ├─ TitleBar
   ├─ body split         — SourcePanel | resize grip | EditorPanel (hidden in focus mode)
   └─ AttachmentsBar      (chrome-mode only)
```

Key points, all verified in `src/App.tsx` and `src/components/leftpanel/index.tsx`:

- **Sidebar is a row sibling, not an overlay.** `LeftPanel` is rendered as the first child of the
  `.app` row, at full window height, alongside — not above — the main column. Its own top strip
  (`WorkspaceSwitcher`) is `data-tauri-drag-region=""` too, so the window can be dragged from the
  left side, not just the main window strip.
- **The window strip is always rendered**, even in focus mode (`chrome = !focusMode`), so the
  custom frame stays draggable and minimize/maximize/close stay reachable no matter what. Inside it,
  the *sidebar toggle* and the *layout lock* are hidden in focus mode — chrome already hides
  everything they act on (sidebar, split/attachment grips), so a visible-but-inert control would
  just be confusing. Same rule for the editor status bar's collapse toggle (`BodyCollapseToggle`).
  The *enter-focus* button is also hidden on the dashboard tab (focus mode is note-editing only;
  landing on the dashboard while focused exits it), and Escape exits focus mode via the
  `overlayStack` chain (menus/modals opened later still consume Escape first). A preview request
  (footnote marker, section "미리보기", related note) while focused exits focus mode instead of
  vanishing into the unmounted SourcePanel — handled once in `useUiStore.setPreviewItem`.
- **The tab row is a separate row below the window strip**, not inlined into it — `{chrome &&
  <TabBar />}` renders directly under the window-strip `div`, before `<TitleBar />`.
- **Sidebar collapse is a real unmount, not a width animation.** `sidebar_collapsed` is a
  persisted setting (`useUiStore.sidebarCollapsed`, loaded via `loadSidebarCollapsed()` on boot).
  When collapsed, `<LeftPanel />` is not rendered at all (`{chrome && !sidebarCollapsed &&
  <LeftPanel />}`) — there is no narrow "peek" state.
- **The collapse/expand control lives in the main window strip, not in the sidebar itself.**
  Putting it there (rather than as a control inside `LeftPanel`) is what keeps it reachable when
  the sidebar is fully collapsed — a toggle button inside the sidebar would disappear along with
  the sidebar it's supposed to bring back. `LeftPanel`'s own top strip used to have a second
  collapse control; it was removed as redundant once the window-strip one shipped.
- **Sidebar width**: draggable between 180px and 460px (`src/components/leftpanel/index.tsx`,
  `clamp(..., 180, 460)`), persisted as the `left_width` setting.

If you touch this layout, keep the "don't regress this" spirit: the frame must stay fully
draggable, and the window controls / sidebar toggle must stay reachable in every chrome state
(normal, focus mode, sidebar collapsed).

## Window transparency (SINGLE-SHEET ACRYLIC CONTRACT)

`tauri.conf.json`'s `windows[0]` sets `"transparent": true` — required for
`src-tauri/src/commands/window.rs::window_set_effect` to have any visible effect (Tauri/WebView2
must be told at window-creation time that the surface can carry real per-pixel alpha; the DWM
Acrylic material applied later is a separate, additional step). This is unconditional —
the window is always OS-transparency-*capable*, even under the `flat` preset. `flat` looks
identical to a fully opaque window purely because the CSS paints every pixel opaquely
(`src/styles/tokens.css`'s `--bg` stays the full noise+glow+solid-canvas stack under `flat`/
default) — no OS-level flag distinguishes "flat" from "acrylic" other than whether
`window_set_effect` actually applied a DWM backdrop.

Two presets only: `flat` (no material) and `acrylic` (labelled "Acrylique" in Settings > Appearance
> "Surface style"; the old `glass` preset name was removed 2026-07-21, and the old `mica` preset
name was renamed to `acrylic` 2026-07-24 — the real OS material behind it was Acrylic from the
start, never actual Windows Mica). `window_set_effect(style)` maps `flat → clear any effect` /
`acrylic → Acrylic`, called live from `src/stores/settings.ts` on boot and on every Settings change
(no restart). It calls the `window-vibrancy` crate directly (not `tauri::Window::set_effects`,
which silently discards the apply/clear `Result`) so it can detect failure and report
`{applied: false}` — Acrylic works back to Windows 10 1809 via an undocumented
`SetWindowCompositionAttribute` fallback. When `applied` comes back false, the frontend degrades
`data-surface` to `flat` rather than trusting the user's stored preference, so an unsupported
system never shows a punched-through hole with no real material behind it.

**Tint is a fixed, theme-neutral constant, not user-picked.** `window_set_effect` also takes an
optional `tint: (u8, u8, u8, u8)` that `src/stores/settings.ts` (`acrylicTint`) computes as a fixed
neutral color per theme with alpha `90` (`ACRYLIC_TINT_ALPHA`) — this only nudges the native DWM
material so it agrees with the CSS sheet; it is not where the visible translucency amount comes
from. All the actual tint alpha and blur strength the user perceives and controls live entirely in
CSS (`--sheet-alpha`, `--surface-blur` — see `docs/DESIGN.md`'s SINGLE-SHEET ACRYLIC CONTRACT and
the contract comment at the bottom of `src/styles/tokens.css`); the native Acrylic call exists only
to make the desktop actually show through behind the CSS sheet, not to carry the app's own theming.

**Verified**: dragging (`data-tauri-drag-region`), snapping, minimize/maximize/close, and resize
all continued to work after adding `transparent: true` in this environment — no regression to the
custom frame or corner rounding was observed. `decorations: false` was already the app's setting
before this wave; `shadow` was left unset (Tauri defaults it to `true`, which is what gives an
undecorated window its Windows 11 rounded corners — no explicit change needed).

**Known Windows caveat**: Acrylic (`window-vibrancy::apply_acrylic`) has a documented
resize/drag performance issue on some Windows 10/11 builds (lag while dragging/resizing) — this
is an upstream limitation of the undocumented composition API Windows itself exposes, not
something this app's code can work around.
