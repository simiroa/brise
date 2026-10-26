import { call, emitNotice } from "../invoke";
import { t } from "../../i18n/t";
import { toCsv } from "./csv";
import type { SheetDoc } from "./types";
import type { ExportSheetCsvOutput } from "../commands.gen";

/**
 * exportSheetAsCsv: SheetDoc → 저장 다이얼로그 → export_sheet_csv → 알림. SheetSection.tsx의
 * 툴바 "CSV로 내보내기"와 SectionTabBar.tsx 섹션 탭 우클릭 "내보내기…"(kind==='sheet')가
 * 공유한다 — 같은 로직을 두 곳에 복제하지 않는다(.claude/CLAUDE.md 코드 방침).
 */
export async function exportSheetAsCsv(doc: SheetDoc, defaultName: string): Promise<void> {
  try {
    const csvStr = toCsv(doc);
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({
      defaultPath: defaultName,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!dest) return;
    await call<ExportSheetCsvOutput>("export_sheet_csv", { dest_path: dest, csv: csvStr });
    emitNotice(t("editor.sheet_export_success"));
  } catch {
    emitNotice(t("editor.sheet_export_failed"));
  }
}
