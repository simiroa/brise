import { ask } from "@tauri-apps/plugin-dialog";
import { callSilent, emitNotice } from "../../../lib/invoke";
import { t } from "../../../i18n/t";

/**
 * 유튜브 kind 소스의 설치본은 yt-dlp를 동봉하지 않는다(스토어 심사·유튜브 약관 노출 리스크
 * 분리) — 저장/지금 실행/드라이런 전에 이 게이트를 거쳐 미설치면 사용자 동의 후 온디맨드로
 * 내려받는다. false를 돌려주면 호출자는 원래 동작을 중단해야 한다.
 */
export async function ensureYtdlp(): Promise<boolean> {
  let status: { installed: boolean };
  try {
    status = await callSilent<{ installed: boolean }>("collect_ytdlp_status", {});
  } catch {
    return false; // 상태조차 못 물었으면 안전하게 차단
  }
  if (status.installed) return true;

  const accepted = await ask(t("settings.collect_ytdlp_ask_message"), {
    title: t("settings.collect_ytdlp_ask_title"),
    kind: "info",
  });
  if (!accepted) return false;

  emitNotice(t("settings.collect_ytdlp_downloading"));
  try {
    await callSilent("collect_ytdlp_install", {});
    return true;
  } catch (e: any) {
    emitNotice(t("settings.collect_ytdlp_download_failed", { error: String(e?.message ?? e) }));
    return false;
  }
}
