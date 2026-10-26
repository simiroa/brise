import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment } from "../../lib/commands.gen";
import { t } from "../../i18n/t";
import { IconQuote, IconTrash } from "../icons";
import { isFootnoteKind } from "../attachments/tileIcon";
import { centeredHintStyle } from "./shared";
import { MarkdownBody } from "./MarkdownBody";
import { PromptDialog } from "../PromptDialog";
import { call, callSilent } from "../../lib/invoke";
import { useNotesStore } from "../../stores/notes";
import { revealFootnoteInEditor, setHoveredFootnote } from "../editor/footnoteMark";

/** Filter + order footnote rows for a note. Kind is a closed union in commands.gen until
 * regen adds 'footnote'; runtime values still arrive as kind='footnote'. */
export function footnoteAttachments(attachments: Attachment[]): Attachment[] {
  return attachments
    .filter((a) => isFootnoteKind(a.kind))
    .slice()
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

async function loadFootnoteText(att: Attachment): Promise<string> {
  try {
    // IPC 조회 — asset 프로토콜 fetch 는 Windows 에서 scope 403 으로 전면 실패했다
    // (specs/commands/attachments.yaml attachment_read_text 참고). silent: 항목별 실패는
    // 리스트 안 문구로 보여주므로 전역 토스트를 겹치지 않는다.
    const res = await callSilent<{ text: string }>("attachment_read_text", { id: att.id });
    return res.text;
  } catch {
    return t("attachments.preview_text_failed");
  }
}

/**
 * Preview pane for a note's footnotes — **one list, no detail mode** (owner decision).
 *
 * Every footnote on the active note renders in one scrollable list. Clicking a footnote marker
 * in the editor body sets `{kind:"footnotes", focusId}` (see editor/footnoteMark.ts), which lands
 * here as `focusId`: the matching entry scrolls into view and takes the accent highlight. The
 * attachments bar shows a single synthetic "각주 N" tile that opens the same list with no focus.
 *
 * Typography is three tiers and only three: label-caps (header + entry number) < --text-sm
 * italic quote (the anchored phrase) < --text-md body (MarkdownBody — footnotes are always stored as .md).
 *
 * ponytail: 항목마다 읽기 전용 TipTap(useEditor) 인스턴스 하나. 수십 개까지는 무방(각 인스턴스는
 * 가벼운 ProseMirror 뷰 하나, 로드 뒤 한 번만 렌더)하나 수백 개면 마운트 비용이 눈에 띈다.
 * 업그레이드 경로: IntersectionObserver 로 화면에 든 항목만 MarkdownBody, 나머지는 텍스트 자리표시.
 */
export function FootnotePreview({
  footnotes,
  focusId,
}: {
  /** All footnote-kind attachments on the active note (already filtered/ordered preferred). */
  footnotes: Attachment[];
  /** Scroll to + highlight this entry (footnote marker click). Undefined = plain list. */
  focusId?: string;
}) {
  const list = useMemo(() => footnoteAttachments(footnotes), [footnotes]);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // id → <li>. A ref map rather than querySelector so no CSS-escaping of attachment ids is
  // needed (and jsdom needs no CSS.escape polyfill in tests).
  const itemRefs = useRef(new Map<string, HTMLLIElement>());

  const listKey = list.map((f) => f.id).join("|");

  useEffect(() => {
    let cancelled = false;
    if (list.length === 0) {
      setBodies({});
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      const next: Record<string, string> = {};
      await Promise.all(
        list.map(async (f) => {
          next[f.id] = await loadFootnoteText(f);
        }),
      );
      if (!cancelled) {
        setBodies(next);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // list identity: depend on ids so parent array churn without content change is fine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey]);

  // hover 브리지는 모듈 전역이다 — 언마운트(패널 전환/노트 전환)에서 반드시 꺼야 에디터에
  // 강조가 남지 않는다. PresetList 가 정리를 빠뜨려 새어 나갔던 사고와 같은 부류.
  useEffect(() => () => setHoveredFootnote(null), []);

  useEffect(() => {
    if (!focusId) return;
    // Optional-call: jsdom does not implement scrollIntoView.
    itemRefs.current.get(focusId)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [focusId, listKey]);

  // ponytail: 삭제에 5초 undo(scheduleUndoableDelete)를 붙이지 않는다 — 확인 다이얼로그가
  // 이미 있는 경로이고, AttachmentsBar 의 일괄 삭제(removeTiles)도 같은 판단을 이미 내렸다.
  // 천장: 본문에 남은 <span data-footnote="지운-id"> 마크는 그대로 남아 이제 아무것도 열지
  // 못한다(첨부 바에서 지울 때도 원래 그랬다). 업그레이드 경로는 삭제 시 body_md 에서 해당
  // 마크를 벗겨내는 것 — 열려 있는 모든 섹션의 에디터 문서를 건드려야 해서 별도 웨이브다.
  const removeFootnote = async (id: string) => {
    try {
      await call("attachment_remove", { id });
    } catch {
      return; // call() already toasted the AppError
    }
    await useNotesStore.getState().reloadActive();
  };

  if (list.length === 0) {
    return (
      <div
        data-testid="footnote-preview-empty"
        style={{
          ...centeredHintStyle,
          flexDirection: "column",
          gap: "var(--space-3)",
        }}
      >
        <IconQuote size={28} strokeWidth={1.5} style={{ color: "var(--faint)", opacity: 0.7 }} />
        <span>{t("attachments.preview_footnotes_empty")}</span>
      </div>
    );
  }

  return (
    <div
      data-testid="footnote-preview"
      style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      <div
        data-testid="footnote-preview-header"
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          padding: "var(--space-4) var(--space-6)",
          borderBottom: "1px solid var(--divider)",
        }}
      >
        <div
          className="label-caps"
          style={{
            minWidth: 0,
            flex: 1,
            color: "var(--accent)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {t("attachments.preview_footnotes")}
          <span style={{ color: "var(--faint)", marginLeft: "var(--space-2)" }}>· {list.length}</span>
        </div>
      </div>

      <div className="scroll" style={{ flex: 1, overflow: "auto", padding: "var(--space-5) var(--space-6)" }}>
        {loading && Object.keys(bodies).length === 0 ? (
          <div data-testid="footnote-preview-loading" style={centeredHintStyle}>
            {t("attachments.preview_loading")}
          </div>
        ) : (
          <ul
            data-testid="footnote-preview-list"
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-5)",
            }}
          >
            {list.map((f, index) => {
              const anchor = f.url?.trim() || null;
              const active = focusId === f.id;
              return (
                <li
                  key={f.id}
                  ref={(el) => {
                    if (el) itemRefs.current.set(f.id, el);
                    else itemRefs.current.delete(f.id);
                  }}
                  data-testid="footnote-preview-list-item"
                  data-footnote-id={f.id}
                  data-active={active ? "true" : undefined}
                  // hover = 본문 앵커를 임시 강조(같은 섹션일 때만 — footnoteMark.ts 참고),
                  // 클릭 = 에디터를 그 앵커로 이동. 삭제 버튼은 이 li 안에 있으므로 그 위에
                  // 올라가도 hover 는 유지된다(강조가 깜빡이지 않는다).
                  onMouseEnter={() => setHoveredFootnote(f.id)}
                  onMouseLeave={() => setHoveredFootnote(null)}
                  onClick={() => void revealFootnoteInEditor(f.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void revealFootnoteInEditor(f.id);
                    }
                  }}
                  tabIndex={0}
                  style={{
                    cursor: "pointer",
                    // Accent is reserved for the jump target — everything else stays quiet.
                    border: active ? "1px solid var(--accent)" : "1px solid transparent",
                    borderRadius: "var(--radius-sm)",
                    padding: "var(--space-3)",
                    borderBottom:
                      index < list.length - 1 && !active ? "1px solid var(--divider)" : undefined,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-3)",
                      marginBottom: "var(--space-2)",
                    }}
                  >
                    <span className="label-caps" style={{ flex: 1, minWidth: 0, color: "var(--muted)" }}>
                      {t("attachments.preview_footnote")} · {index + 1}
                    </span>
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm"
                      data-testid="footnote-preview-delete"
                      onClick={(e) => {
                        e.stopPropagation(); // 삭제는 점프가 아니다 — li 클릭으로 새지 않게.
                        setConfirmId(f.id);
                      }}
                      title={t("attachments.remove")}
                      aria-label={t("attachments.remove")}
                      style={{ flex: "none", color: "var(--faint)" }}
                    >
                      <IconTrash size={13} strokeWidth={1.8} />
                    </button>
                  </div>
                  {anchor ? (
                    <div
                      data-testid="footnote-preview-anchor"
                      title={t("attachments.preview_footnote_anchor")}
                      style={{
                        fontSize: "var(--text-sm)",
                        color: "var(--muted)",
                        fontStyle: "italic",
                        borderLeft: "2px solid var(--divider)",
                        paddingLeft: "var(--space-3)",
                        marginBottom: "var(--space-3)",
                        lineHeight: 1.5,
                      }}
                    >
                      {anchor}
                    </div>
                  ) : null}
                  <div data-testid="footnote-preview-body">
                    <MarkdownBody text={bodies[f.id] ?? ""} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {confirmId && (
        <PromptDialog
          title={t("selection.delete_attachments_title", { n: 1 })}
          description={t("selection.delete_attachments_body")}
          mode="confirm"
          danger
          confirmLabel={t("selection.delete")}
          onCancel={() => setConfirmId(null)}
          onSubmit={() => {
            const id = confirmId;
            setConfirmId(null);
            void removeFootnote(id);
          }}
        />
      )}
    </div>
  );
}
