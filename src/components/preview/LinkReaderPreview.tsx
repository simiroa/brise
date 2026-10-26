import { useEffect, useState } from "react";
import { callSilent, emitNotice } from "../../lib/invoke";
import { openAttachmentExternal } from "../../lib/attachmentOpen";
import type { Attachment, AttachmentFetchReaderOutput } from "../../lib/commands.gen";
import { IconLink, IconExternalLink, IconNote } from "../icons";
import { t } from "../../i18n/t";
import { centeredHintStyle } from "./shared";
import { insertAiSection, withSourceLine } from "../../lib/aiSectionBridge";

// Reader view: fetched + text-extracted server-side (Rust, repo::web_reader) rather than
// rendered in an <iframe> — most real sites refuse to be framed (X-Frame-Options / CSP
// frame-ancestors), which used to leave this pane blank with no indication of why. A plain
// HTTP GET from the backend isn't "embedding" a page, so those headers don't apply, and the
// result is rendered as plain text (never raw HTML), so there is no script-execution or
// remote-subresource surface to sanitize against. "Open in browser" is always present in
// the header below, in every state (loading/success/error), never only as an error fallback.
export function LinkReaderPreview({ att, noteId }: { att: Attachment; noteId: string }) {
  const [linkReaderStatus, setLinkReaderStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [linkReaderData, setLinkReaderData] = useState<AttachmentFetchReaderOutput | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!att.url) {
      // kind==='link' but no url is a data-integrity edge case, not a real fetch attempt —
      // still land on "error" so the fallback card (not a blank pane) is what renders.
      setLinkReaderStatus("error");
      setLinkReaderData(null);
      return;
    }
    let cancelled = false;
    setLinkReaderStatus("loading");
    setLinkReaderData(null);
    // callSilent: a failure here is not an app bug to toast — it's the ordinary "this site can't
    // be read in-app" case, already communicated clearly by the fallback card this state renders.
    callSilent<AttachmentFetchReaderOutput>("attachment_fetch_reader", { id: att.id })
      .then((data) => {
        if (cancelled) return;
        setLinkReaderData(data);
        setLinkReaderStatus("success");
      })
      .catch(() => {
        if (cancelled) return;
        setLinkReaderStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [att.id, att.url]);

  const openExternal = () => openAttachmentExternal(att.id);

  // 이미 화면에 있는 추출 결과(linkReaderData.text)를 그대로 섹션에 넣는다 — importLinkToSection
  // (lib/linkImport.ts) 은 여기서 안 부른다: 그 함수는 (첨부 확정 → fetch → 섹션) 3단계인데
  // ⓐ 는 att 로 이미 확정돼 있고 ⓑ 의 결과도 이미 손에 있다. 다시 부르면 같은 페이지를 한 번 더
  // fetch 하게 되므로, 관문을 우회하는 게 아니라 관문의 마지막 단계(섹션 삽입)만 재사용한다.
  const importToSection = async () => {
    if (!linkReaderData?.text || importing) return;
    setImporting(true);
    try {
      const title = linkReaderData.title?.trim() || att.name;
      const sec = await insertAiSection(
        title,
        withSourceLine(linkReaderData.text, [{ label: title, url: att.url ?? undefined }]),
        noteId,
      );
      if (!sec) emitNotice(t("attachments.preview_import_to_section_failed"));
    } finally {
      setImporting(false);
    }
  };

  const btnStyle = {
    flex: "none" as const,
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    background: "var(--surface)",
    border: "1px solid var(--divider)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text)",
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    cursor: "pointer",
  };

  const openBrowserBtn = (
    <button onClick={openExternal} title={t("attachments.preview_open_browser")} style={btnStyle}>
      <IconExternalLink size={13} /> {t("attachments.preview_open_browser")}
    </button>
  );

  const importToSectionBtn =
    linkReaderStatus === "success" && linkReaderData?.text ? (
      <button
        onClick={() => void importToSection()}
        disabled={importing}
        title={t("attachments.preview_import_to_section")}
        style={{ ...btnStyle, opacity: importing ? 0.6 : 1, cursor: importing ? "default" : "pointer" }}
      >
        <IconNote size={13} /> {t("attachments.preview_import_to_section")}
      </button>
    ) : null;
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "var(--space-4) var(--space-6)",
          borderBottom: "1px solid var(--divider)",
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            className="label-caps"
            style={{
              color: "var(--accent)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {(linkReaderStatus === "success" && linkReaderData?.title) || att.name}
          </div>
          {att.url && (
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--faint)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {att.url}
            </div>
          )}
        </div>
        <div style={{ flex: "none", display: "flex", gap: 8 }}>
          {importToSectionBtn}
          {openBrowserBtn}
        </div>
      </div>
      <div className="scroll" style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {linkReaderStatus === "loading" && (
          <div style={centeredHintStyle}>{t("attachments.preview_reader_loading")}</div>
        )}
        {linkReaderStatus === "success" && linkReaderData && (
          <>
            {linkReaderData.truncated && (
              <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-3)" }}>
                {t("attachments.preview_reader_truncated")}
              </div>
            )}
            <pre
              className="scroll"
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "var(--font-editor)",
                fontSize: "calc(12px*var(--fs))",
                lineHeight: 1.7,
                color: "var(--text)",
                opacity: 0.9,
              }}
            >
              {linkReaderData.text}
            </pre>
          </>
        )}
        {linkReaderStatus === "error" && (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 16,
            }}
          >
            <IconLink size={48} strokeWidth={1.5} style={{ color: "var(--faint)" }} />
            <div style={{ textAlign: "center", fontSize: "var(--text-md)", color: "var(--muted)" }}>
              {t("attachments.preview_link_unavailable")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
