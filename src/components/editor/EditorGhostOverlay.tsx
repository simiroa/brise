import { useEffect, useState } from "react";
import { Editor as TiptapEditor } from "@tiptap/core";
import { PREVIEW_EXTENSIONS } from "../../lib/editorExtensions";
import { LAYOUT_HOVER_PREFIX, usePresetsStore, type PresetTargetState } from "../../stores/presets";
import { parseDiagramJson, type DiagramModel } from "../diagram/diagramSchema";
import { DiagramStaticSvg } from "../diagram/diagramStaticSvg";

// Preset hover-preview ghost — parses a preset's REAL body_md through the same markdown-capable
// schema the live editor uses (P0-1: contentType markdown), then re-serializes to HTML for the
// read-only overlay. This is the same parse path editor.commands.setContent(body_md, {
// contentType: "markdown" }) runs when the preset is actually applied — so the ghost matches the
// applied result (including any residual warts), not a prettier fiction. Reusing that path
// (rather than a hand-rolled markdown renderer) gets that for free: **bold**/task lists/images
// look like what the user gets on click.
// ponytail: this list mirrors the live editor's schema-affecting extensions but drops the
// purely-interactive ones (Placeholder/SlashCommand/WikiLink/EmojiRender) —
// none of those add schema a preset body could contain, and the ghost is read-only anyway.
// Upgrade path: if the live editor's schema ever needs to change in lockstep with this one,
// factor both into one shared constant.

/** Exported for testing. Returns "" for empty/unparseable input — a display-only ghost must never
 *  throw and take the editor panel down with it. */
export function renderPresetGhostHtml(bodyMd: string): string {
  if (!bodyMd.trim()) return "";
  try {
    // Headless markdown parse → HTML (same contentType as live setContent after P0-1).
    const ed = new TiptapEditor({
      extensions: PREVIEW_EXTENSIONS,
      content: bodyMd,
      contentType: "markdown",
    });
    try {
      return ed.getHTML();
    } finally {
      ed.destroy();
    }
  } catch {
    return "";
  }
}

/** Exported for testing. The ONE gate the ghost paints through — the same `targetState === "ready"`
 *  PresetList enables its rows on (stores/presets.ts's PresetTargetState), so "row is clickable"
 *  and "hovering it previews something" can't drift apart. Returns the body to ghost, or null
 *  for "nothing to show": a blocked target, nothing hovered, or a row with no static body of its
 *  own (blank/AI — the first is what an empty editor already looks like, the second has no prose
 *  to fake; both are still perfectly clickable). A 관계도 row hands over its JSON IR seed — the
 *  same string applyDiagramPreset writes — and `ghostDiagram` below picks it out of this one
 *  return value; nothing draws around this gate.
 *  PLAN-2026-09-21 W1: "diagram"+시드 인정(PLAN-2026-09-20 §5 함정 12)을 되돌렸다 — 관계도의 타입
 *  27장은 이제 어시스트(assist/DiagramAssist.tsx)의 **시작** 모드에서만 보이고, 시작은 항상
 *  targetState "ready" 다(빈 관계도 섹션). "diagram" 상태(내용 있는 관계도)에서는 타입 행 자체가
 *  더 이상 뜨지 않으므로 그 상태의 고스트 특례도 필요 없다 — 게이트가 다시 `ready` 한 줄. */
export function resolveGhostBody(
  targetState: PresetTargetState,
  hovered: { id: string; bodyMd: string } | null
): string | null {
  if (!hovered) return null;
  // 배치 행(`layout:<name>`, PLAN-2026-09-21 W4 후속)은 **내용 있는 관계도** 위에서만 눌린다 — 그 상태의
  // targetState 가 "diagram" 이라, "행이 눌리는 상태 = 호버가 그려지는 상태" 를 지키려면 이 게이트가
  // 그 짝을 인정해야 한다(우회 금지). 본문은 현재 관계도를 그 배치로 다시 직렬화한 것.
  const layoutRow = hovered.id.startsWith(LAYOUT_HOVER_PREFIX);
  if (layoutRow ? targetState !== "diagram" : targetState !== "ready") return null;
  return hovered.bodyMd.trim() ? hovered.bodyMd : null;
}

/** Exported for testing. A ghost body that parses as a non-empty JSON IR v1 diagram is drawn as
 *  `<DiagramStaticSvg>` instead of markdown; anything else (prose, a sheet JSON — which has no
 *  `nodes`, so it parses to `empty`) takes the Tiptap path. Cheap: `JSON.parse` on a string that
 *  starts with `#`/`-`/a letter throws on its first character. */
export function ghostDiagram(bodyMd: string | null): DiagramModel | null {
  if (!bodyMd || bodyMd.trimStart()[0] !== "{") return null;
  const model = parseDiagramJson(bodyMd);
  return model.structured && !model.empty ? model : null;
}

export interface EditorGhostOverlayProps {
  scrollEl?: HTMLElement | null;
}

/**
 * Preset hover-preview ghost overlay:
 * Decomposed from EditorPanel to prevent unnecessary re-renders of the TipTap editor
 * when preset hover state changes.
 */
export function EditorGhostOverlay({ scrollEl }: EditorGhostOverlayProps) {
  // 프리셋 호버 고스트 — 판정은 전부 stores/presets.ts 쪽 한 기준(targetState)으로 모았다.
  // PresetList 는 같은 값으로 행을 활성/비활성한다: 행이 눌리는 상태면 호버도 반드시 그려진다.
  const presetTargetState = usePresetsStore((s) => s.targetState);
  const hoveredPreset = usePresetsStore((s) => s.hovered);
  const ghostBodyMd = resolveGhostBody(presetTargetState, hoveredPreset);

  // 헤드리스 Tiptap 파싱(renderPresetGhostHtml)은 effect 에서만 — 렌더 페이즈에서 에디터 인스턴스를
  // 만들고 destroy 하던 예전 useMemo 는 StrictMode 이중 렌더에서 두 번 돌았고, 렌더 중 부수효과라
  // 는 점에서도 틀렸다. 마지막으로 그린 본문을 md 와 함께 들고 있어서 (a) 숨길 때 페이드아웃할
  // 내용이 남고(.ghost-preview 의 .12s 크로스페이드), (b) 호버가 A→B 로 바뀌는 한 프레임 동안
  // 엉뚱한 본문이 보이지 않는다(아래 ghostVisible 의 md 일치 검사).
  const [ghost, setGhost] = useState<{ md: string; html: string }>({ md: "", html: "" });
  // 관계도 시드는 마크다운 경로를 타지 않는다 — 렌더 중 파싱이지만 순수 함수라 StrictMode 이중 렌더도
  // 무해하고, 위 effect 처럼 상태를 거칠 이유(에디터 인스턴스 생성/파괴)가 없다.
  const diagram = ghostDiagram(ghostBodyMd);

  // JSON 인데 관계도가 아닌 본문(= 시트 템플릿 JSON)은 산문 경로를 타지 않는다 — 빈 시트에서 예산 행을
  // 호버하면 JSON 원문이 문단으로 뜬 적이 있다(2026-09-20). 시트 셀 고스트는 SheetGhostOverlay 가 따로 그린다.
  const prose = !!ghostBodyMd && !diagram && ghostBodyMd.trimStart()[0] !== "{";
  useEffect(() => {
    if (prose && ghostBodyMd !== ghost.md) {
      setGhost({ md: ghostBodyMd, html: renderPresetGhostHtml(ghostBodyMd) });
    }
  }, [prose, ghostBodyMd, ghost.md]);

  const ghostVisible = !!diagram || (!!ghostBodyMd && ghost.md === ghostBodyMd && ghost.html !== "");

  // data-preset-preview suppresses Tiptap's own empty-body placeholder (editor.body_placeholder, tokens.css)
  // while the ghost is visible, so the two hints never overlap.
  useEffect(() => {
    if (!scrollEl) return;
    if (ghostVisible) {
      scrollEl.setAttribute("data-preset-preview", "true");
    } else {
      scrollEl.removeAttribute("data-preset-preview");
    }
    return () => {
      scrollEl.removeAttribute("data-preset-preview");
    };
  }, [scrollEl, ghostVisible]);

  return (
    <div
      // 관계도 고스트는 산문 폭(.mdbody 800px 컬럼)을 물려받지 않는다 — 캔버스 전체를 덮어야 뒤가 안 비친다.
      className={diagram ? "ghost-preview" : "mdbody ghost-preview"}
      // 배치 미리보기는 살아있는 캔버스 위에 뜬다 — 불투명 바탕으로 기존 그림을 잠깐 가린다(tokens.css).
      // 겹쳐 보이면 어느 쪽이 미리보기인지 읽을 수 없다(오너 2026-09-20).
      data-over-content={diagram && hoveredPreset?.id.startsWith(LAYOUT_HOVER_PREFIX) ? "true" : undefined}
      inert
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 1,
        overflow: "hidden",
        pointerEvents: "none",
        opacity: ghostVisible ? 1 : 0,
      }}
    >
      {diagram ? (
        // 상자 높이를 차지해 fit 이 기준을 갖게 한다 — 예전 width 100% 는 작은 시드를 확대하고 큰 시드는 아래를 잘랐다.
        <div data-testid="ghost-diagram" style={{ height: "100%", boxSizing: "border-box", padding: "var(--space-4)", opacity: 0.55 }}>
          <DiagramStaticSvg model={diagram} fit />
        </div>
      ) : (
        <div className="ProseMirror" dangerouslySetInnerHTML={{ __html: ghost.html }} />
      )}
    </div>
  );
}
