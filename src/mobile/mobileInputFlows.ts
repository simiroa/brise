// S2 입력(음성·위치·메타 제안) 중 MobileNote 가 쓰는 순수 조각 — docs/PLAN-2026-10-06-s2-input.md §5.3.
// 화면 상태는 MobileNote 가 쥐고, 여기엔 입력→출력만 있다(테스트가 쉽게).
import { t } from "../i18n/t";
import { parseNlDate, type NlDateLocale } from "../lib/nlDate";
import { formatEventDate } from "../components/titlebar/eventDate";
import type { NoteDateAddInput } from "../lib/commands.gen";
import { buildNoteDateAddPayload } from "../lib/noteDatePayload";

/** 전사 실패의 안정 분류 — 서버(commands/audio_transcribe.rs)의 메시지 접두 코드를 칩 문구로 가른다. */
export type VoiceErrCode = "ai_required" | "too_long" | "key" | "format" | "in_progress" | "deadline" | "failed";

/** 다시 시도해도 절대 달라지지 않는 실패 — 설정을 고쳐야 한다(재시도 버튼을 숨긴다). */
export const isSettingsFix = (c: VoiceErrCode): boolean => c === "ai_required" || c === "key" || c === "format";

export function classifyTranscribeError(e: unknown): VoiceErrCode {
  const msg = String((e as { message?: unknown } | null)?.message ?? e);
  // audio_unsupported_provider: Gemini 외 제공자 — 사용자에게는 "AI 연결이 필요" 와 같은 말(고칠 길이 같다).
  if (msg.includes("ai_required") || msg.includes("audio_unsupported_provider")) return "ai_required";
  if (msg.includes("audio_too_large")) return "too_long";
  // 이미 다른 곳(PC·다른 기기)에서 같은 첨부를 받아쓰는 중 — 실패가 아니다.
  if (msg.includes("transcribe_in_progress")) return "in_progress";
  // transport::check_ai_status 문구: "<provider> request failed with status 401 Unauthorized — check your API key".
  if (/status 40[13]\b/.test(msg)) return "key";
  if (/status 400\b/.test(msg)) return "format";
  if (msg.includes("AI operation deadline exceeded")) return "deadline";
  return "failed";
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function formatVoiceDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  return m > 0
    ? t("mobileInput.dur_min_sec", { m, s: total % 60 })
    : t("mobileInput.dur_sec", { s: total });
}

export interface VoiceInfo {
  recordedAt?: string;
  durationMs?: number;
}

function transcriptParts(text: string, info?: VoiceInfo): { head: string; lines: string[] } {
  const parts: string[] = [];
  if (info?.recordedAt) {
    const d = new Date(info.recordedAt);
    if (!Number.isNaN(d.getTime())) parts.push(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
  }
  if (typeof info?.durationMs === "number") parts.push(formatVoiceDuration(info.durationMs));
  const head = parts.length ? `🎙 ${parts.join(" · ")}` : `🎙 ${t("mobileInput.voice_head_plain")}`;
  return { head, lines: text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) };
}

/**
 * 인용 블록(마크다운): 머리말 한 줄("🎙 14:32 · 1분 24초") + 본문. 시각·길이를 몰라도(다시 연 노트의
 * 보관 전사) 머리말은 항상 있어 "말로 넣은 글" 임이 보인다. 에디터가 못 받는 섹션 종류일 때 새 섹션 본문으로 쓴다.
 */
export function buildTranscriptBlock(text: string, info?: VoiceInfo): string {
  const { head, lines } = transcriptParts(text, info);
  return [`> ${head}`, ">", ...lines.map((l) => `> ${l}`)].join("\n");
}

/** 같은 블록의 ProseMirror JSON — 커서/끝 삽입은 마크다운 파싱 경로(contentType)에 기대지 않고 노드로 넣는다. */
export function buildTranscriptNode(text: string, info?: VoiceInfo) {
  const { head, lines } = transcriptParts(text, info);
  const para = (s: string) => ({ type: "paragraph", content: [{ type: "text", text: s }] });
  return { type: "blockquote", content: [para(head), ...lines.map(para)] };
}

/** uiLang → nlDate 로케일. SelectionContextMenu.uiLangToNlDateLocale 와 같은 한 줄(그 모듈은 크다 — dateNudge.ts 도 복사본을 쓴다). */
function nlLocale(uiLang: string): NlDateLocale {
  return uiLang === "ko" || uiLang === "fr" ? uiLang : "en";
}

export interface DateCandidate {
  payload: Omit<NoteDateAddInput, "note_id">;
  /** 칩 문구용 "2026.10.07 15:00". */
  label: string;
}

/**
 * 전사문에서 날짜 후보 하나. 확신이 높을 때만(`confidence:"high"`) 낸다 — 시각만 말하면 파서가 오늘로
 * 채우므로, 긴 산문 전체를 훑는 자리에서 낮은 확신까지 받으면 자동 모드가 엉뚱한 날을 만든다.
 * ponytail: 후보는 첫 매치 하나. 여러 일정이 섞인 긴 녹음은 첫 일정만 제안한다.
 * 페이로드는 lib/noteDatePayload.ts::buildNoteDateAddPayload — 데스크톱 날짜 넛지와 같은 코드.
 */
export function dateCandidateFromText(text: string, uiLang: string): DateCandidate | null {
  const parsed = parseNlDate(text, nlLocale(uiLang));
  if (!parsed || parsed.confidence !== "high") return null;
  const { start } = parsed;
  const payload = buildNoteDateAddPayload(parsed);
  const label = `${formatEventDate(start.year, start.month, start.day)}${parsed.startTime ? ` ${parsed.startTime}` : ""}`;
  return { payload, label };
}
