/**
 * 모양(테마) 초기화·내보내기·불러오기 — docs/PLAN-2026-09-19-theme-presets.md.
 *
 * 모양 페이지와 데이터 관리 › "스타일만 가져오기" 가 같이 쓴다. Rust 는 읽기·기본값만 주고
 * (theme_read / theme_defaults / theme_export), 쓰기는 스토어 `applyAppearance` 한 곳이다.
 *
 * 반환값 규칙: 적용됐으면 적용 **직전**의 모양 스냅샷(되돌리기용), 취소·실패면 null.
 * 실패 알림은 여기서 다 띄운다 — 호출부는 null 이면 그냥 끝내면 된다.
 */
import { call, callSilent, emitNotice } from "./invoke";
import { appearanceEntries, useSettingsStore } from "../stores/settings";
import { t } from "../i18n/t";

type Entries = Record<string, unknown>;
type Snapshot = Entries;

interface ThemeRead {
  entries: Entries;
  skipped_unknown: number;
  source: "theme" | "bundle";
}

async function apply(entries: Entries): Promise<{ prev: Snapshot; blockedAcrylic: boolean } | null> {
  const prev = appearanceEntries(useSettingsStore.getState());
  try {
    const { blockedAcrylic } = await useSettingsStore.getState().applyAppearance(entries);
    return { prev, blockedAcrylic };
  } catch {
    return null; // settings_set 은 call() 이라 이미 토스트가 떴다
  }
}

/** 파일을 골라 모양만 적용한다. 테마 파일과 전체 내보내기 번들(brise-bundle.json)을 둘 다 받는다. */
export async function importThemeFromPicker(): Promise<Snapshot | null> {
  let path: string | null = null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: t("settings.theme_file_filter"), extensions: ["json"] }],
    });
    if (typeof picked === "string") path = picked;
  } catch {
    return null; // 다이얼로그를 쓸 수 없는 환경
  }
  if (!path) return null;

  let read: ThemeRead;
  try {
    // callSilent: 백엔드의 영어 원문 대신 번역된 이유를 보여 준다(DataManagementSection 의 번들 가져오기와 같은 이유).
    read = await callSilent<ThemeRead>("theme_read", { path });
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? String(e);
    emitNotice(
      msg.includes("newer version of Brise") ? t("settings.import_version_newer") : t("settings.theme_import_invalid"),
    );
    return null;
  }

  const res = await apply(read.entries);
  if (!res) return null;
  const parts = [t("settings.theme_import_done", { n: Object.keys(read.entries).length })];
  if (read.skipped_unknown > 0) parts.push(t("settings.theme_import_skipped", { n: read.skipped_unknown }));
  if (res.blockedAcrylic) parts.push(t("settings.theme_acrylic_blocked"));
  emitNotice(parts.join(" "));
  return res.prev;
}

/** 모양 10개 키를 기본값으로. 기본값은 Rust default_settings 에서 온다(사본을 두지 않는다). */
export async function resetAppearance(): Promise<Snapshot | null> {
  let entries: Entries;
  try {
    entries = (await call<{ entries: Entries }>("theme_defaults")).entries;
  } catch {
    return null;
  }
  const res = await apply(entries);
  if (!res) return null;
  emitNotice(t("settings.theme_reset_done"));
  return res.prev;
}

/** 되돌리기 — 스냅샷도 모양 키 묶음이라 같은 경로로 적용한다. */
export async function restoreAppearance(snapshot: Snapshot): Promise<boolean> {
  const res = await apply(snapshot);
  if (res) emitNotice(t("settings.theme_undo_done"));
  return res !== null;
}

export async function exportThemeToPicker(): Promise<void> {
  let path: string | null = null;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    path = await save({
      defaultPath: "brise-theme.json",
      filters: [{ name: t("settings.theme_file_filter"), extensions: ["json"] }],
    });
  } catch {
    return;
  }
  if (!path) return;
  try {
    await call("theme_export", { path });
    emitNotice(t("settings.theme_export_done"));
  } catch {
    /* call() 이 토스트를 띄웠다 */
  }
}
