/**
 * 내보내기 모달의 "내보내는" 쪽 — 저장 대화상자 · export_hwpx / export_docx / export_html 호출 · 서식 복사(클립보드) ·
 * 완료 토스트 · 열기. Markdown 은 기존 lib/noteActions.ts(exportNote · exportSectionMd)가 그대로 맡는다.
 */
import { call, emitNotice } from "../../lib/invoke";
import { showToastOnly } from "../../lib/undo";
import { reportFallback, safeErrorDetail } from "../../lib/diag";
import { t } from "../../i18n/t";
import type {
  DocExportSection,
  ExportDocxOutput,
  ExportHtmlInlineOutput,
  ExportHtmlOutput,
  ExportHwpxOutput,
} from "../../lib/commands.gen";
import type { ExportMargin, ExportPaper, OfficeFormat } from "./exportDoc";

/** 완료 토스트가 남는 시간 — 눌러 볼 시간이 필요해 알림 기본(3초)보다 길다. */
const SAVED_TOAST_TTL_MS = 10_000;

/**
 * 저장 대화상자. 취소는 null. 대화상자 플러그인을 못 불러오면(Tauri 밖·테스트) 조용히 null 이 되지만
 * 기록은 남긴다 — "눌렀는데 아무 일도 없다"의 원인을 진단 탭에서 찾을 수 있게(CLAUDE.md 함정 11).
 */
export async function pickSavePath(defaultName: string, label: string, ext: string): Promise<string | null> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] });
    return dest || null;
  } catch (e) {
    reportFallback("export", "save_dialog_unavailable", safeErrorDetail(e));
    return null;
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * export_open — 기본 앱으로 열기(reveal=false) 또는 탐색기에서 그 파일 선택(reveal=true).
 * 프런트 opener 권한은 $RESOURCE 뿐이라 내보낸 파일은 Rust 가 연다. 실패는 call() 이 토스트로 알린다.
 */
export async function openExported(path: string, reveal: boolean): Promise<void> {
  try {
    await call("export_open", { path, reveal });
  } catch {
    // call() 이 이미 토스트·진단 기록을 남겼다 — 여기서 더 할 일은 없다.
  }
}

/**
 * 저장 완료 토스트 + [기본 앱으로 열기] · [폴더 열기]. showUndoToast 가 아니라 showToastOnly 다 —
 * 앞쪽은 전역 Ctrl+Z 를 이 행동에 묶어서, Ctrl+Z 가 내보낸 파일을 여는 일이 생긴다.
 */
export function announceSaved(writtenPath: string, skippedImages = 0): void {
  const name = baseName(writtenPath);
  showToastOnly(
    skippedImages > 0 ? t("export.saved_skipped", { name, n: skippedImages }) : t("export.saved", { name }),
    () => void openExported(writtenPath, false),
    {
      ttlMs: SAVED_TOAST_TTL_MS,
      actionLabel: t("export.open_file"),
      extraAction: { label: t("export.open_folder"), onAction: () => void openExported(writtenPath, true) },
    },
  );
}

/** 문서 편집기용 형식마다 다른 건 커맨드 이름과 대화상자 필터 이름뿐이다 — 입력·출력 형은 같다(specs/commands/export.yaml). */
const OFFICE_SAVE: Record<OfficeFormat, { command: "export_hwpx" | "export_docx"; label: string }> = {
  hwpx: { command: "export_hwpx", label: "HWPX" },
  docx: { command: "export_docx", label: "DOCX" },
};

/**
 * HWPX · DOCX 로 저장. 저장 대화상자 취소·쓰기 실패는 false(실패는 call() 이 토스트를 이미 띄웠다), 성공은 true.
 * export_hwpx · export_docx 는 노트의 exported_at 을 찍지 않는다(export_note 와 다르다) — 트리를 다시 읽지 않는다.
 */
export async function saveOfficeDoc(
  format: OfficeFormat,
  args: {
    noteId: string;
    title: string;
    fileBase: string;
    sections: DocExportSection[];
    paper: ExportPaper;
    margin: ExportMargin;
  },
): Promise<boolean> {
  const { command, label } = OFFICE_SAVE[format];
  const dest = await pickSavePath(`${args.fileBase}.${format}`, label, format);
  if (!dest) return false;
  try {
    const out = await call<ExportHwpxOutput | ExportDocxOutput>(command, {
      note_id: args.noteId,
      dest_path: dest,
      title: args.title,
      sections: args.sections,
      paper: args.paper,
      margin: args.margin,
    });
    announceSaved(out.written_path || dest, out.skipped_images);
    return true;
  } catch {
    return false;
  }
}

/**
 * 읽히는 단일 HTML 파일로 저장(W6). `html` 은 완성 문서(exportHtml.buildHtmlDocument) — 첨부 그림은
 * `<img data-rel-path>` 로 들어 있고 Rust(export_html)가 첨부 루트 안에서 읽어 data: URI 로 채운 뒤 쓴다.
 * 반환은 saveOfficeDoc 과 같다 — 썼으면 true, 대화상자 취소·쓰기 실패(call() 이 이미 토스트)면 false.
 */
export async function saveHtmlDoc(args: { noteId: string; fileBase: string; html: string }): Promise<boolean> {
  const dest = await pickSavePath(`${args.fileBase}.html`, "HTML", "html");
  if (!dest) return false;
  try {
    const out = await call<ExportHtmlOutput>("export_html", { note_id: args.noteId, dest_path: dest, html: args.html });
    announceSaved(out.written_path || dest, out.skipped_images);
    return true;
  } catch {
    return false;
  }
}

/**
 * 서식 복사의 결과 — ok: 클립보드에 들어갔다(모달을 닫는다) · failed: export_html_inline 실패(call() 이 이미 토스트) ·
 * clipboard_failed: 클립보드가 없거나 거절했다(모달이 한 줄로 알린다 — 토스트를 띄운 곳이 없다).
 */
export type CopyResult = "ok" | "failed" | "clipboard_failed";

/**
 * 서식 복사(W6): 인라인 style 조각(exportHtml.buildClipboardHtml)의 첨부 그림을 Rust 가 data: URI 로 채워 돌려주면
 * 클립보드에 text/html + text/plain 두 벌로 넣는다. 붙여넣는 곳이 서식을 받으면 html, 못 받으면 평문이 들어간다.
 *
 * ponytail: ClipboardItem 을 IPC 를 기다린 **뒤에** 만든다. Chromium(WebView2)은 쓰기에 사용자 활성화를 요구하지 않아
 * 지금은 된다. 거절(NotAllowedError)이 실제로 보이면 클릭 핸들러 안에서 Promise<Blob> 값으로 ClipboardItem 을 바로
 * 만들고(Safari 방식) IPC 결과로 그 Promise 를 푸는 형태로 바꾼다 — clipboard_failed 진단 기록이 그 신호다.
 */
export async function copyFormatted(args: { noteId: string; html: string; plain: string }): Promise<CopyResult> {
  let out: ExportHtmlInlineOutput;
  try {
    out = await call<ExportHtmlInlineOutput>("export_html_inline", { note_id: args.noteId, html: args.html });
  } catch {
    return "failed";
  }
  try {
    if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard?.write !== "function") {
      throw new Error("clipboard_unavailable");
    }
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([out.html], { type: "text/html" }),
        "text/plain": new Blob([args.plain], { type: "text/plain" }),
      }),
    ]);
  } catch (e) {
    reportFallback("export", "copy_failed", safeErrorDetail(e));
    return "clipboard_failed";
  }
  emitNotice(out.skipped_images > 0 ? t("export.copied_skipped", { n: out.skipped_images }) : t("export.copied"));
  return "ok";
}
