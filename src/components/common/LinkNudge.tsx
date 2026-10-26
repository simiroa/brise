import { useState } from "react";
import { ContextMenuShell } from "./ContextMenuShell";
import { IconAi, IconExternalLink, IconLink } from "../icons";
import { t } from "../../i18n/t";
import { emitNotice } from "../../lib/invoke";
import { importLinksToSections, type LinkImportMode } from "../../lib/linkImport";
import { linkBodyMaybeReadable, linkSiteLabel, openExternalUrl } from "../../lib/urls";
import { useNotesStore } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";

/** 넛지가 다루는 링크들. 붙여넣기·단일 우클릭은 한 개, 선택 영역 우클릭은 여러 개다. */
export type LinkNudgeCtx = { x: number; y: number; urls: string[] };

/**
 * 링크 넛지 — "이 링크로 무엇을 할까" 두 제안(+ 브라우저에서 열기)을 말풍선처럼 띄운다.
 * 자리는 넷이고 컴포넌트는 하나다(오너 2026-09-10):
 *   ⓐ 에디터에 단독 URL 을 붙여넣은 직후, 그 링크 아래(EditorPanel.tsx)
 *   ⓑ 에디터의 링크를 우클릭했을 때 — 넛지를 놓쳐도 나중에 다시 닿을 길
 *   ⓒ **링크가 여럿 든 선택 영역**을 우클릭했을 때(editor/SelectionContextMenu.tsx) — N개 일괄
 *   ⓓ 첨부 바의 **링크 타일**을 우클릭했을 때(AttachmentsBar.tsx) — 예전에 저장해 둔 링크
 * 넷이 같은 컴포넌트를 열므로 문구·게이트·동작이 갈라질 수 없다. 그래서 components/common 에
 * 산다 — 에디터 전용이 아니다.
 *
 * "가능한 경우에만 제안" 은 lib/urls.ts 의 linkBodyMaybeReadable 이 가른다 — 정적 검사이므로
 * 눌러 보고서야 못 읽는 페이지도 있다. 그때는 실패를 정직하게 알리고(lib/linkImport.ts) 링크는
 * 첨부로 남아 "브라우저에서 열기" 로 갈 수 있다.
 */
export function LinkNudge({ ctx, onClose }: { ctx: LinkNudgeCtx | null; onClose: () => void }) {
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const [busy, setBusy] = useState<LinkImportMode | null>(null);

  // 자체검토: 확장자만으로 이미 비-HTML 인 링크(pdf·이미지·xlsx…)는 추출 대상에서 뺀다. 붙여넣기
  // 경로는 이 판정으로 넛지 자체를 띄우지 않지만(EditorPanel), 우클릭은 어떤 http 링크에서나
  // 열리므로 — "브라우저에서 열기"는 그때도 쓸 데가 있다 — 여기서 한 번 더 가른다.
  const readable = (ctx?.urls ?? []).filter(linkBodyMaybeReadable);
  const n = readable.length;

  const runImport = (mode: LinkImportMode) => {
    if (!ctx || busy || n === 0) return;
    const urls = readable;
    setBusy(mode);
    // 2개 이상은 메뉴를 바로 닫는다 — 그때부터는 진행 토스트가 상태를 말하고(lib/linkImport.ts),
    // 팝오버와 토스트가 같은 진행을 두 벌로 보여줄 이유가 없다. 하나일 때는 이 행이 그 역할이다.
    if (urls.length > 1) onClose();
    void (async () => {
      try {
        const noteId = await useNotesStore.getState().ensureMaterialized();
        if (!noteId) {
          emitNotice(t("editor.note_required_for_section"));
          return;
        }
        await importLinksToSections(urls, noteId, mode);
      } finally {
        setBusy(null);
        onClose();
      }
    })();
  };

  if (!ctx) return null;

  const rowStyle = { color: "inherit" } as const;
  const single = ctx.urls.length === 1 ? ctx.urls[0] : null;

  return (
    <ContextMenuShell
      anchor={ctx}
      onClose={onClose}
      minWidth={230}
      testId="link-nudge"
      ariaLabel={t("editor.link_nudge_title")}
      editorSafe
    >
      <div
        className="label-caps"
        style={{
          color: "var(--faint)",
          padding: "var(--space-1) var(--space-2)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {single ? linkSiteLabel(single) : t("editor.link_nudge_n_links", { n: ctx.urls.length })}
      </div>

      {n > 0 && (
        <button
          type="button"
          className="menu-row menu-item"
          data-testid="link-nudge-extract"
          disabled={!!busy}
          onClick={() => runImport("raw")}
          style={rowStyle}
        >
          <IconLink size={15} strokeWidth={1.8} />
          <span>
            {busy === "raw"
              ? t("editor.link_nudge_busy")
              : n === 1
                ? t("editor.link_nudge_extract", { site: linkSiteLabel(readable[0]) })
                : t("editor.link_nudge_extract_n", { n })}
          </span>
        </button>
      )}

      {n > 0 && aiEnabled && (
        <button
          type="button"
          className="menu-row menu-item"
          data-testid="link-nudge-ai"
          disabled={!!busy}
          onClick={() => runImport("ai")}
          style={rowStyle}
        >
          <IconAi size={15} strokeWidth={1.8} />
          <span>
            {busy === "ai"
              ? t("editor.link_nudge_busy")
              : n === 1
                ? t("editor.link_nudge_ai")
                : t("editor.link_nudge_ai_n", { n })}
          </span>
        </button>
      )}

      {/* 여러 개를 한꺼번에 브라우저로 여는 것은 제안하지 않는다 — 탭 N개는 사용자가 요청한 적 없는
          결과다. 하나일 때만 남는다. */}
      {single && (
        <button
          type="button"
          className="menu-row menu-item"
          data-testid="link-nudge-open"
          onClick={() => {
            onClose();
            void openExternalUrl(single);
          }}
          style={rowStyle}
        >
          <IconExternalLink size={15} strokeWidth={1.8} />
          <span>{t("attachments.preview_open_browser")}</span>
        </button>
      )}
    </ContextMenuShell>
  );
}
