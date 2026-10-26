import { useEffect, useMemo, useRef, useState } from "react";
import { ModalShell } from "../ModalShell";
import { Select } from "../Select";
import { t } from "../../i18n/t";
import { IconCheckMark } from "../icons";
import { isBrowser } from "../../lib/env";
import { useAttachmentsBase } from "../../lib/attachmentsBase";
import { reportFallback, safeErrorDetail } from "../../lib/diag";
import { exportNote, exportSectionMd } from "../../lib/noteActions";
import { useExportModalStore, type ExportRequest } from "../../stores/exportModal";
import { useSettingsStore } from "../../stores/settings";
import {
  exportDifferences,
  exportFileSlug,
  isOfficeFormat,
  loadExportDocs,
  prepareExport,
  renderPaperBody,
  type ExportDocSection,
  type ExportDocs,
  type ExportFormat,
  type ExportMargin,
  type ExportPaper,
  type ExportScope,
  type PaperOrient,
  type PaperSize,
} from "./exportDoc";
import { EXPORT_FORMATS, diffLabel, formatSpec } from "./exportFormats";
import { buildClipboardHtml, buildHtmlDocument, plainTextOf } from "./exportHtml";
import { buildPaperSrcDoc, loadAllImages, paperViewHeight, paperViewWidth } from "./exportPaper";
import { copyFormatted, saveHtmlDoc, saveOfficeDoc, type CopyResult } from "./exportSave";
import "./ExportModal.css";

/** 종이가 아닌 미리보기(형식 표의 preview "web" · "pasted")의 창 크기 — 용지를 고르지 않으니 늘 세로 종이 크기의 창이다. */
const WEB_VIEW_PAPER: ExportPaper = "a4-portrait";

/** 용지 크기 드롭다운 — 키는 리터럴로(check:i18n 미사용 키 검사가 리터럴만 센다). */
const PAPER_SIZES: readonly { id: PaperSize; label: string }[] = [
  { id: "a4", label: "export.paper_a4" },
  { id: "b5", label: "export.paper_b5" },
  { id: "letter", label: "export.paper_letter" },
];
const PAPER_ORIENTS: readonly PaperOrient[] = ["portrait", "landscape"];
const MARGINS: readonly ExportMargin[] = ["narrow", "normal", "wide"];

/** 인쇄 직전 그림 전부 불러오기를 기다리는 상한 — 넘기면 있는 만큼으로 인쇄하고 진단에 남긴다. */
const PRINT_IMAGE_WAIT_MS = 30_000;

/**
 * 파일·클립보드로 나가는 본문의 렌더 방식. 미리보기는 renderPaperBody 기본값(링크 href 를 벗겨 프레임이 어디로도 못 가게,
 * 그림은 asset 주소로 그린다)이고, 나가는 쪽은 링크를 살리고(http/https/mailto 만) 첨부 그림을 data-rel-path 로 남긴다 —
 * Rust(export_html · export_html_inline)가 첨부 루트 안에서 읽어 data: URI 로 채운다. asset 주소는 앱 밖에서 안 열린다.
 */
const OUTPUT_BODY = { links: "keep", images: "embed" } as const;

/**
 * 내보내기 모달의 열림 상태 소유자 — GlobalModalsHost 가 지연 로드로 한 번만 둔다. 열려 있지 않으면 아무것도
 * 그리지 않고, 열릴 때마다 모달을 새로 마운트해(상태가 남지 않는다) 문서를 새로 읽는다.
 */
export function ExportModalHost() {
  const request = useExportModalStore((s) => s.request);
  const close = useExportModalStore((s) => s.close);
  if (!request) return null;
  return <ExportModal request={request} onClose={close} />;
}

/**
 * 내보내기 모달 (PLAN-2026-10-07-doc-import-export §4, W6). 섹션 탭·노트 우클릭·제목 줄 메뉴가 같은 모달을
 * 범위만 달리 연다(stores/exportModal.ts). 왼쪽은 미리보기(`<iframe srcdoc>`, 앱 테마와 무관), 오른쪽은
 * 형식(HWPX·DOCX·HTML·서식 복사·Markdown)·범위·쪽 설정(크기·방향·여백)과 "달라지는 점". 형식마다 갈리는 것은 형식 표
 * (exportFormats.ts) 한 곳에 있다 — 이 파일은 그 표의 칸을 읽을 뿐이다.
 *
 * 흐름: 고른 섹션(picked) → prepareExport(각주를 본문 [n] + 끝 목록으로) → 미리보기 · 저장 · 복사 모두 같은 결과를 쓴다.
 * "달라지는 점"만 picked 원본으로 센다(각주를 펴기 전이어야 각주 수를 센다).
 * - HWPX · DOCX: 같은 입력으로 Rust writer 만 달리 부른다(exportSave.ts saveOfficeDoc).
 * - HTML: 미리보기와 같은 본문(링크 살림 · 그림은 data-rel-path) → 완성 문서 → export_html 이 그림을 채워 쓴다.
 * - 서식 복사: 같은 본문 → 인라인 style 조각 → export_html_inline 이 그림을 채워 돌려주면 클립보드에.
 * - 인쇄(W5, 모든 형식): 미리보기 iframe 문서를 그대로 `contentWindow.print()` — WebView2 인쇄 창이 프린터 선택·"Microsoft Print
 *   to PDF"·정확한 쪽 나눔을 맡는다(쪽 나눔은 계산하지 않는다). 인쇄 CSS 는 exportPaper.ts printCss.
 */
export function ExportModal({ request, onClose }: { request: ExportRequest; onClose: () => void }) {
  const { noteId, noteTitle, sectionId } = request;
  const { baseDir, convert } = useAttachmentsBase();
  const browser = isBrowser();

  const [docs, setDocs] = useState<ExportDocs | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("hwpx");
  const [scope, setScope] = useState<ExportScope>(sectionId ? "section" : "note");
  const [paperSize, setPaperSize] = useState<PaperSize>("a4");
  const [orient, setOrient] = useState<PaperOrient>("portrait");
  const [margin, setMargin] = useState<ExportMargin>("normal");
  const paper: ExportPaper = `${paperSize}-${orient}`;
  const [busy, setBusy] = useState(false);
  // iframe 이 지금 srcDoc 을 다 그렸는지(그림 포함 — load 는 하위 자원까지 기다린다). 용지·범위·형식을 바꾸면 iframe 이
  // 새로 읽히는데, 그 사이 [인쇄…] 를 누르면 이전 문서나 빈 문서가 인쇄된다 — 그래서 다 그린 문서만 인쇄한다.
  const [loadedSrc, setLoadedSrc] = useState("");
  const [printFailed, setPrintFailed] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [loadProgress, setLoadProgress] = useState<{ i: number; n: number } | null>(null);
  const [printing, setPrinting] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 열릴 때 한 번 읽는다. 범위·형식을 바꿔도 다시 읽지 않는다(읽어 둔 섹션에서 고른다).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadExportDocs(noteId, {
          onProgress: (i, n) => {
            if (!cancelled) setLoadProgress({ i, n });
          },
          isCancelled: () => cancelled,
        });
        if (!cancelled) setDocs(loaded);
      } catch (e) {
        // note_get 실패는 call() 이 이미 토스트를 띄웠다. 그 밖(문서 열기 실패)은 여기서만 남는다.
        reportFallback("export", "load_failed", safeErrorDetail(e));
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const spec = formatSpec(format);
  const allSections = docs?.sections;
  const section = sectionId ? allSections?.find((s) => s.id === sectionId) ?? null : null;
  // 섹션이 문서에서 사라졌으면(방금 지움 등) "이 섹션"은 고를 수 없다 — 노트 전체로.
  const sectionScopeAvailable = !!sectionId && (docs === null || section !== null);
  const effScope: ExportScope = scope === "section" && !sectionScopeAvailable ? "note" : scope;

  const picked = useMemo(() => {
    if (!allSections) return [];
    return effScope === "section" ? allSections.filter((s) => s.id === sectionId) : allSections;
  }, [allSections, effScope, sectionId]);

  // 시트 칸을 적힌 그대로(수식 포함) 쓰는 형식(Markdown — Rust 가 쓴다)은 계산 값을 그리는 시트 표를 미리보기에서 뺀다 — 파일에
  // 없는 값을 보여 주지 않는다(W6 검증 V3, 달라지는 점 "시트" 줄이 알린다). 각주 적용보다 먼저 빼야 끝 목록이 시트와 함께 사라지지 않는다.
  const shown = useMemo(
    () => (spec.sheetCells === "raw" ? picked.filter((s) => s.kind !== "sheet") : picked),
    [picked, spec.sheetCells],
  );

  // 각주를 편 섹션 — 미리보기·저장·복사가 모두 이것을 쓴다.
  const prepared = useMemo<ExportDocSection[]>(
    () => (docs ? prepareExport(shown, docs, { footnoteHeading: t("export.footnote_heading") }) : []),
    [docs, shown],
  );

  const diffs = useMemo(
    () => (docs ? exportDifferences(picked, format, { excluded: effScope === "note" ? docs.excluded : 0 }) : []),
    [docs, picked, format, effScope],
  );

  const untitled = t("note.untitled_note");
  const docTitle = effScope === "section" ? section?.name || noteTitle || untitled : noteTitle || untitled;
  // 섹션 이름을 제목으로 앞에 두는 건 사용자가 고른 섹션이 둘 이상일 때다(각주 목록은 섹션이 아니다).
  const showTitles = picked.length > 1;

  const imageLabel = t("export.image_label");
  const bodyOpts = { baseDir, convert, showTitles, imageLabel };

  // L-8: 본문 가공은 내용 입력에만 의존한다 — 용지·형식 칩은 아래 래퍼 메모만 다시 돌린다.
  const previewBody = useMemo(
    () => (!docs || picked.length === 0 ? "" : renderPaperBody(prepared, { baseDir, convert, showTitles, imageLabel })),
    [docs, picked.length, prepared, baseDir, convert, showTitles, imageLabel],
  );
  const srcDoc = useMemo(() => {
    // 고른 것이 시트뿐인 Markdown 은 미리보기에 그릴 섹션이 없다 — 빈 종이를 보인다(빈 프레임 대신).
    if (!docs || picked.length === 0) return "";
    const body = previewBody;
    if (spec.preview === "paper") return buildPaperSrcDoc(body, spec.paper ? paper : WEB_VIEW_PAPER, format, docTitle, margin);
    // 서식 복사는 붙여넣을 조각 그대로를 보인다(접기 펼침 · ☐/☑ 글자) — 파일과 달리 접기가 접혀 있지 않다.
    return buildHtmlDocument(spec.preview === "pasted" ? buildClipboardHtml(body) : body, { title: docTitle });
  }, [docs, picked.length, previewBody, paper, format, spec.preview, spec.paper, docTitle, margin]);

  const fileBase = exportFileSlug(docTitle, untitled);
  const fileName = spec.ext ? `${fileBase}.${spec.ext}` : "";
  // 저장·복사는 Rust 커맨드(http:false)라 브라우저 모드에서는 막는다. 인쇄는 Tauri 가 필요 없어 그대로 된다.
  const canRun = !!docs && picked.length > 0 && !busy && !browser;
  const canPrint = !!srcDoc && loadedSrc === srcDoc && !printing;
  // 쪽 설정을 고르지 않는 형식(Markdown 미리보기 · HTML · 복사)은 늘 A4 세로 창 — 숨은 선택값이 미리보기를 바꾸지 않게.
  const viewPaper = spec.paper ? paper : WEB_VIEW_PAPER;

  const onSave = async () => {
    if (!canRun) return;
    setBusy(true);
    let ok = false;
    try {
      if (isOfficeFormat(format)) {
        ok = await saveOfficeDoc(format, {
          noteId,
          title: docTitle,
          fileBase,
          sections: prepared.map((s) => ({ name: s.name, doc: s.doc })),
          paper,
          margin,
        });
      } else if (format === "html") {
        const body = renderPaperBody(prepared, { ...bodyOpts, ...OUTPUT_BODY });
        const lang = useSettingsStore.getState().uiLang || undefined;
        ok = await saveHtmlDoc({ noteId, fileBase, html: buildHtmlDocument(body, { title: docTitle, lang }) });
      } else if (format === "md") {
        ok =
          effScope === "section" && picked[0]
            ? await exportSectionMd(picked[0].id, picked[0].name)
            : await exportNote(noteId, noteTitle);
      }
    } finally {
      if (aliveRef.current) setBusy(false);
    }
    if (ok && aliveRef.current) onClose();
  };

  /** 서식 복사 — 성공하면 토스트(exportSave.copyFormatted)를 남기고 닫는다. 클립보드 실패만 모달에 한 줄로 남긴다
   *  (export_html_inline 실패는 call() 이 이미 토스트를 띄웠다). */
  const onCopy = async () => {
    if (!canRun) return;
    setBusy(true);
    setCopyFailed(false);
    let result: CopyResult = "failed";
    try {
      const body = renderPaperBody(prepared, { ...bodyOpts, ...OUTPUT_BODY });
      result = await copyFormatted({ noteId, html: buildClipboardHtml(body), plain: plainTextOf(body) });
    } finally {
      if (aliveRef.current) setBusy(false);
    }
    if (!aliveRef.current) return;
    if (result === "ok") onClose();
    else if (result === "clipboard_failed") setCopyFailed(true);
  };

  /** 미리보기 문서를 인쇄 창으로. print() 는 창이 닫힐 때까지 돌아오지 않고, 취소해도 afterprint 가 와서 인쇄했는지 알 수
   *  없다 — 그래서 성공 알림도 모달 닫기도 하지 않는다(인쇄 창을 닫으면 모달로 돌아온다). */
  const onPrint = async () => {
    const w = frameRef.current?.contentWindow;
    // readyState 는 겹침 방어 — 이전 문서의 load 가 새 srcDoc 으로 바뀐 직후에 도착하면 loadedSrc 가 앞서 맞을 수 있다.
    // printing 은 두 번째 클릭 무시(버튼도 비활성이지만 같은 렌더 안의 연타를 막는다).
    if (!canPrint || printing || !w || w.document.readyState !== "complete") return;
    setPrintFailed(false);
    setPrinting(true);
    try {
      // 미리보기 그림은 lazy 라 iframe load 가 그림을 기다리지 않는다 — 인쇄 전에 전부 불러온다(E-4). 시간이 넘어도 인쇄는 한다.
      const allLoaded = await loadAllImages(w.document, PRINT_IMAGE_WAIT_MS);
      if (!allLoaded) reportFallback("export", "print_images_timeout", `limit_ms=${PRINT_IMAGE_WAIT_MS}`);
      // 기다리는 사이 모달이 닫혔거나 문서가 바뀌었으면(용지·범위 변경 → 새 iframe) 옛 문서를 인쇄하지 않는다.
      if (!aliveRef.current || frameRef.current?.contentWindow !== w) return;
      w.focus();
      w.print();
    } catch (e) {
      // sandbox 에서 allow-modals 가 빠지는 등 인쇄 창이 막히면 여기로 온다 — 아무 반응 없이 끝나지 않게 알리고 남긴다.
      reportFallback("export", "print_failed", safeErrorDetail(e));
      if (aliveRef.current) setPrintFailed(true);
    } finally {
      if (aliveRef.current) setPrinting(false);
    }
  };

  const stageStatus = loadFailed
    ? t("export.load_failed")
    : !docs
      ? loadProgress
        ? t("export.loading_section", { i: loadProgress.i, n: loadProgress.n })
        : t("export.loading")
      : picked.length === 0
        ? t("export.empty")
        : null;

  // 인쇄는 모든 형식에서 된다(오너 피드백 2026-10-16 "저장뿐 아니라 인쇄도") — 지금 보이는 미리보기를 그대로 인쇄한다.
  // 저장·복사 옆의 보조 버튼이다("PDF·인쇄" 형식은 지웠다 — PDF 는 인쇄 창의 프린터로 만든다는 안내가 버튼 툴팁에 남는다).
  const printButton = (
    <button
      type="button"
      className="btn"
      disabled={!canPrint}
      title={canPrint ? t("export.note_print") : t("export.print_wait")}
      onClick={() => void onPrint()}
      data-testid="export-print"
    >
      {printing ? t("export.print_preparing") : t("export.print")}
    </button>
  );

  const primary =
    spec.action === "copy" ? (
      <button
        type="button"
        className="btn btn-primary"
        disabled={!canRun}
        title={browser ? t("common.desktop_only") : undefined}
        onClick={() => void onCopy()}
        data-testid="export-copy"
      >
        {busy ? t("export.copying") : t("export.copy")}
      </button>
    ) : (
      <button
        type="button"
        className="btn btn-primary"
        disabled={!canRun}
        title={browser ? t("common.desktop_only") : undefined}
        onClick={() => void onSave()}
        data-testid="export-save"
      >
        {busy ? t("export.saving") : t("export.save")}
      </button>
    );

  return (
    <ModalShell
      title={t("export.title")}
      onClose={onClose}
      width={980}
      footer={
        <div className="export-foot">
          <span className="export-foot__file" data-testid="export-file-name" title={fileName}>
            {fileName}
          </span>
          <button type="button" className="btn" onClick={onClose} data-testid="export-cancel">
            {t("common.cancel")}
          </button>
          {printButton}
          {primary}
        </div>
      }
    >
      <div className="export-grid" data-testid="export-modal">
        <div className="export-stage">
          <div className="export-stage__hint">
            <span data-testid="export-hint">{t(spec.hint)}</span>
          </div>
          <div className="export-stage__well">
            {stageStatus ? (
              <div className="export-stage__status" role="status" data-testid="export-stage-status">
                {stageStatus}
              </div>
            ) : (
              <iframe
                key={srcDoc}
                ref={frameRef}
                className="export-paper"
                data-testid="export-preview"
                title={t("export.preview_title")}
                // 스크립트는 없다(allow-scripts 를 주지 않는다). allow-same-origin 은 [인쇄…] 가 iframe 문서의 contentWindow
                // 에 닿으려고, allow-modals 는 그 인쇄 창 때문이다(없으면 print() 가 막힌다) — 문서 안에 실행되는 코드가 없으니
                // 둘 다 무해하다. 미리보기 본문은 링크 href 를 벗겨 프레임이 어디로도 못 간다(renderBody("preview")).
                sandbox="allow-same-origin allow-modals"
                srcDoc={srcDoc}
                onLoad={() => setLoadedSrc(srcDoc)}
                style={{ width: paperViewWidth(viewPaper), height: paperViewHeight(viewPaper) }}
              />
            )}
          </div>
        </div>

        <div className="export-side">
          <div>
            <div className="export-field__label">{t("export.scope")}</div>
            {sectionScopeAvailable ? (
              <div className="export-chips" role="group" aria-label={t("export.scope")}>
                <button
                  type="button"
                  className="chip-btn"
                  data-active={effScope === "section"}
                  aria-pressed={effScope === "section"}
                  data-testid="export-scope-section"
                  onClick={() => setScope("section")}
                >
                  {t("export.scope_section", { name: section?.name || noteTitle || untitled })}
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  data-active={effScope === "note"}
                  aria-pressed={effScope === "note"}
                  data-testid="export-scope-note"
                  onClick={() => setScope("note")}
                >
                  {t("export.scope_note", { n: allSections?.length ?? 0 })}
                </button>
              </div>
            ) : (
              <div className="export-scope-static" data-testid="export-scope-note-only">
                {t("export.scope_note", { n: allSections?.length ?? 0 })}
              </div>
            )}
          </div>

          {/* 오너 피드백(2026-10-16): 오른쪽은 대상 → 출력 형식·옵션 순, 형식은 드롭다운. */}
          <div>
            <div className="export-field__label">{t("export.format")}</div>
            <Select
              value={format}
              onChange={(v) => setFormat(v as ExportFormat)}
              options={EXPORT_FORMATS.map((f) => ({ value: f.id, label: t(f.label) }))}
              ariaLabel={t("export.format")}
              testid="export-format"
              style={{ width: "100%", minWidth: 0 }}
            />
          </div>

          {spec.paper && (
            <div>
              <div className="export-field__label">{t("export.paper")}</div>
              <Select
                value={paperSize}
                onChange={(v) => setPaperSize(v as PaperSize)}
                options={PAPER_SIZES.map((p) => ({ value: p.id, label: t(p.label) }))}
                ariaLabel={t("export.paper")}
                testid="export-paper-size"
                style={{ width: "100%", minWidth: 0 }}
              />
              <div className="export-chips export-chips--below" role="group" aria-label={t("export.orient")}>
                {PAPER_ORIENTS.map((o) => (
                  <button
                    key={o}
                    type="button"
                    className="chip-btn"
                    data-active={orient === o}
                    aria-pressed={orient === o}
                    data-testid={`export-orient-${o}`}
                    onClick={() => setOrient(o)}
                  >
                    {o === "portrait" ? t("export.paper_portrait") : t("export.paper_landscape")}
                  </button>
                ))}
              </div>
            </div>
          )}

          {spec.paper && (
            <div>
              <div className="export-field__label">{t("export.margin")}</div>
              <div className="export-chips" role="group" aria-label={t("export.margin")}>
                {MARGINS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="chip-btn"
                    data-active={margin === m}
                    aria-pressed={margin === m}
                    data-testid={`export-margin-${m}`}
                    onClick={() => setMargin(m)}
                  >
                    {m === "narrow" ? t("export.margin_narrow") : m === "wide" ? t("export.margin_wide") : t("export.margin_normal")}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="export-diffs" data-testid="export-diffs">
            <div className="export-diffs__head">
              <span>{t("export.diff_title")}</span>
              <span>{effScope === "section" ? t("export.diff_basis_section") : t("export.diff_basis_note")}</span>
            </div>
            {docs && diffs.length === 0 ? (
              <div className="export-diff" data-testid="export-diff-none">
                <span className="export-diff__mark" data-kind="ok" aria-hidden="true"><IconCheckMark size={12} /></span>
                <span>{t("export.diff_none")}</span>
              </div>
            ) : (
              diffs.map((d) => (
                <div key={d.id} className="export-diff" data-testid={`export-diff-${d.id}`}>
                  <span className="export-diff__mark" aria-hidden="true">•</span>
                  <span>{diffLabel(d, spec)}</span>
                </div>
              ))
            )}
          </div>

          {spec.note && <div className="export-note" data-testid="export-note">{t(spec.note)}</div>}
          {printFailed && (
            <div className="export-note" role="alert" data-testid="export-print-failed">
              {t("export.print_failed")}
            </div>
          )}
          {spec.action === "copy" && copyFailed && (
            <div className="export-note" role="alert" data-testid="export-copy-failed">
              {t("export.copy_failed")}
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
