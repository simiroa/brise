import { useEffect, useState } from "react";
import { callSilent } from "../../lib/invoke";
import { openAttachmentExternal, revealAttachmentExternal } from "../../lib/attachmentOpen";
import type { Attachment, SlidePreviewRenderOutput } from "../../lib/commands.gen";
import type { Theme } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import { IconExternalLink, IconFile, IconImage } from "../icons";
import { t } from "../../i18n/t";
import { NoFormatFallback } from "./shared";
import { RAW_IMAGE_EXTS, CODE_PREVIEW_EXTS, PLAIN_MONO_EXTS } from "../../lib/fileKinds";
import { MarkdownBody } from "./MarkdownBody";
import { CodeBody } from "./CodeBody";
import { PendingIndicator } from "../common/PendingIndicator";

/** 슬라이드는 변환기가 있을 때만 pdf 로 보인다 — 없으면 조용히 텍스트로 폴백한다. */
type SlideState = { pdfPath: string | null; reason: string | null } | "pending" | null;


/** 왜 슬라이드로 안 보이는지 — 사유별 한 줄. */
function slideHintKey(reason: string): string {
  if (reason === "disabled") return "attachments.slide_disabled";
  if (reason === "no_converter") return "attachments.slide_no_converter";
  return "attachments.slide_failed";
}

export function DocPreview({
  att,
  baseDir,
  convert,
  theme,
}: {
  att: Attachment;
  baseDir: string | null;
  convert: ((path: string) => string) | null;
  theme: Theme;
}) {
  const [textData, setTextData] = useState<string | null>(null);
  // 앞부분만 담겨 왔다 — 안 알리면 사용자가 파일 전체를 봤다고 믿는다.
  const [textTruncated, setTextTruncated] = useState(false);
  const [slide, setSlide] = useState<SlideState>(null);
  // 슬라이드 폴백 본문 — 같은 파일이 사료로도 들어와 있으면(원본 보관 정책 "keep") 추출된
  // 본문이 이미 DB 에 있다. attachment_read_text 는 pptx 를 받지 않으므로 이쪽이 유일한 본문.
  const sources = useNotesStore((s) => s.activeNote?.sources);
  const ext = att.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  const isSlide = ext === "pptx";
  // ponytail: 첨부 ↔ 사료를 **이름**으로 잇는다 — `sources` 에 attachment_id 컬럼이 없어서다.
  // 같은 노트에 이름이 같은 pptx 가 둘이면 엉뚱한 본문이 붙는다(드물지만 가능하다). 또 원본
  // 보관을 "keep" 으로 넣은 것만 첨부와 사료가 둘 다 존재한다. 제대로 풀려면 sources 에
  // attachment_id 를 두고 add_file 이 채워야 한다 — 스키마 변경이라 이번 범위 밖이다.
  const slideBody = isSlide ? sources?.find((s) => s.name === att.name)?.body ?? null : null;

  useEffect(() => {
    let cancelled = false;
    setTextData(null);
    setTextTruncated(false);

    if (att.rel_path) {
      const ext = att.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
      if (att.kind === "note" || ext === "txt" || ext === "md" || CODE_PREVIEW_EXTS.has(ext ?? "") || PLAIN_MONO_EXTS.has(ext ?? "")) {
        // IPC 조회 — asset 프로토콜 fetch 는 Windows 에서 scope 403 으로 전면 실패했다
        // (specs/commands/attachments.yaml attachment_read_text 참고).
        callSilent<{ text: string; truncated: boolean }>("attachment_read_text", { id: att.id })
          .then((res) => { if (!cancelled) { setTextData(res.text); setTextTruncated(res.truncated); } })
          .catch(() => { if (!cancelled) setTextData(t("attachments.preview_text_failed")); });
      }
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.id, baseDir]);

  useEffect(() => {
    if (!isSlide) {
      setSlide(null);
      return;
    }
    let cancelled = false;
    setSlide("pending");
    // 게이트(설정 off·변환기 부재·실패·타임아웃)는 전부 백엔드 한 곳에 있다 — 여기선 사유만 받는다.
    // 토스트가 뜨면 안 되므로 callSilent(함정 #8: call(...).catch 는 금지 형태).
    callSilent<SlidePreviewRenderOutput>("slide_preview_render", { attachment_id: att.id })
      .then((res) => { if (!cancelled) setSlide({ pdfPath: res.pdf_path, reason: res.reason }); })
      .catch(() => { if (!cancelled) setSlide({ pdfPath: null, reason: "failed" }); });
    return () => { cancelled = true; };
  }, [att.id, isSlide]);

  const openExternal = () => openAttachmentExternal(att.id);

  // pdf 는 원본이든 슬라이드 변환본이든 **같은 iframe** 이 그린다(두 번째 구현 금지).
  const pdfSrc =
    convert && slide && slide !== "pending" && slide.pdfPath
      ? convert(slide.pdfPath)
      : ext === "pdf" && baseDir && convert && att.rel_path
        ? convert(`${baseDir}/${att.rel_path}`)
        : null;
  if (pdfSrc) {
    return (
      <iframe
        src={pdfSrc}
        // Task 4 finding: tried setting color-scheme on the iframe element itself so the
        // embedded Chromium PDF viewer would pick up our app theme instead of the OS theme.
        // It does not help — Chromium's built-in PDF viewer renders in its own top-level
        // browsing context (effectively a separate document/UI, not our page's subtree), so
        // `color-scheme` set on the *hosting* <iframe> element never reaches it; only a
        // `color-scheme` meta/property inside that document itself would, and we don't
        // control that document. Left in place since it's harmless and correct for any HTML
        // content that *does* end up rendered through this element, but the PDF viewer's own
        // chrome/scrollbars genuinely cannot be re-themed from here.
        style={{ width: "100%", height: "100%", border: "none", colorScheme: theme }}
      />
    );
  }
  if ((ext === "html" || ext === "htm") && baseDir && convert && att.rel_path) {
    return (
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <iframe
          src={convert(`${baseDir}/${att.rel_path}`)}
          // 오너 결정: 스크립트 차단. sandbox="" (권한 전무) — 스크립트·폼·팝업·상위
          // 내비게이션이 전부 막히지만 sandbox 는 서브리소스 로드를 막지 않으므로 CSS·이미지·
          // 폰트는 그대로 렌더된다. allow-same-origin 은 주지 않는다.
          // ponytail: 스크립트로 차트를 그리는 보고서는 이 안에서 비어 보인다 — 그때의 업그레이드
          // 경로는 sandbox 를 allow-scripts 로 완화하는 것이고, 그러면 로컬 파일이라도 그 문서가
          // 원격 리소스를 스스로 불러올 수 있다는 새 위험이 들어온다. 지금은 아래 "외부에서 열기"가
          // 탈출구다.
          sandbox=""
          style={{ width: "100%", height: "100%", border: "none", colorScheme: theme }}
        />
        <div className="overlay" style={{ position: "absolute", bottom: 16, right: 16, display: "flex", padding: "var(--space-2)", boxShadow: "var(--shadow-lg)" }}>
          <button onClick={openExternal} title={t("attachments.preview_open_external")} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text)", display: "grid", placeItems: "center" }}>
            <IconExternalLink size={14} />
          </button>
        </div>
      </div>
    );
  }
  if (slide === "pending") {
    return (
      <div style={{ flex: 1, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <PendingIndicator active />
        <div style={{ fontSize: "var(--text-md)", color: "var(--faint)" }}>{t("attachments.slide_converting")}</div>
      </div>
    );
  }
  // 슬라이드 폴백: 변환기가 없거나 변환이 실패했다. 왜 슬라이드로 안 보이는지 한 줄로 알리고
  // 설정으로 가는 길을 준다 — 토스트로 시끄럽게 하지 않는다.
  if (isSlide && slide && slide.reason) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {slideBody !== null ? (
          <MarkdownBody text={slideBody} />
        ) : (
          <NoFormatFallback
            icon={<IconFile size={48} strokeWidth={1.5} style={{ color: "var(--faint)" }} />}
            onOpenExternal={openExternal}
          />
        )}
        <div style={{ display: "flex", justifyContent: "center", gap: 8, padding: "var(--space-3)", fontSize: "var(--text-sm)", color: "var(--faint)" }}>
          <span>{t(slideHintKey(slide.reason))}</span>
          <button
            type="button"
            onClick={() => void callSilent("settings_window_open", {}).catch(() => {})}
            style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--accent)", fontSize: "inherit", textDecoration: "underline" }}
          >
            {t("attachments.slide_open_settings")}
          </button>
        </div>
      </div>
    );
  }
  if (textData !== null) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {textTruncated && (
          <div
            data-testid="doc-preview-truncated"
            style={{
              flex: "none",
              padding: "var(--space-2) var(--space-5)",
              fontSize: "var(--text-xs)",
              color: "var(--muted)",
              borderBottom: "1px solid var(--divider)",
            }}
          >
            {t("attachments.preview_truncated")}
          </div>
        )}
        {/* 소스·스크립트(.py/.ts/…)는 코드 뷰어, csv/log/vtt 는 하이라이트 없는 고정폭, 나머지는 마크다운. */}
        {CODE_PREVIEW_EXTS.has(ext ?? "") || PLAIN_MONO_EXTS.has(ext ?? "") ? (
          <CodeBody text={textData} ext={ext ?? ""} name={att.name} onReveal={() => revealAttachmentExternal(att.id)} />
        ) : (
          <MarkdownBody text={textData} />
        )}
      </div>
    );
  }
  // RAW 는 "미리보기 안 되는 파일" 이 아니라 "미리보기 안 되는 **사진**" 이다 — 아이콘과 문구로
  // 그만큼만 말한다. 이미지로 분류하면 그릴 수 있다는 거짓말이 된다(lib/fileKinds.ts 주석).
  if (RAW_IMAGE_EXTS.has(ext ?? "")) {
    return (
      <NoFormatFallback
        icon={<IconImage size={48} strokeWidth={1.5} style={{ color: "var(--faint)" }} />}
        onOpenExternal={openExternal}
        hint={t("attachments.preview_raw_image")}
      />
    );
  }
  return (
    <NoFormatFallback
      icon={<IconFile size={48} strokeWidth={1.5} style={{ color: "var(--faint)" }} />}
      onOpenExternal={openExternal}
    />
  );
}
