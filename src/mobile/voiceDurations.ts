/**
 * 폰에서 녹음한 음성 첨부의 "진짜 길이" 기억 — attachment id → 밀리초.
 *
 * 왜: 폰 녹음은 조각난 MP4(AAC)라 파일 머리에 전체 길이가 없다. `<audio>` 는 첫 조각(TIMESLICE_MS=5초)만 보고
 * "0:05" 를 보여 준다(12초·54초 녹음 모두, 2026-10-07 실기 QA). 녹음기는 경과 시간을 알고, 그 값은 이미
 * 업로드 직전 손넘김(VoiceResult.durationMs → onVoiceFinished)에 실려 온다. 서버 스키마(Attachment)에는 길이
 * 필드가 없으므로 — 스키마는 바꾸지 않는다 — 업로드가 끝나 첨부 id 가 생기는 순간 이 기억에 적고,
 * MobileAttachmentList 가 id 로 찾아 길이를 직접 그린다.
 *
 * 범위: 이 기기에서 올린 녹음만 안다(메모리 + localStorage 미러). 다른 기기·옛 녹음·사용자가 고른 오디오
 * 파일은 모르는 채로 남고, 그 행은 예전 그대로 기본 `<audio controls>` 다(회귀 없음).
 * ponytail: 천장 — 최근 MAX 개까지만 기억한다(오래된 것부터 잊음). 업그레이드 경로: 서버가 업로드 때 길이를
 * 첨부 메타로 저장하거나(스키마 변경) 업로드 시 조각난 MP4 를 리먹스해 길이를 채운다.
 */
const STORAGE_KEY = "brise_voice_durations";
const MAX_ENTRIES = 200;

const mem = new Map<string, number>(); // 삽입 순서 = 오래된 순
let loaded = false;

const valid = (ms: unknown): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms > 0;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    for (const [id, ms] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
      if (valid(ms)) mem.set(id, ms);
    }
  } catch {
    // silent-ok: 저장소가 막혔거나 값이 깨졌다 — 기억 없이 시작한다(행은 기본 플레이어로 폴백)
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(mem)));
  } catch {
    // silent-ok: 사생활 모드·용량 초과 — 이번 세션 메모리만 쓴다
  }
}

/** 업로드가 돌려준 첨부 id 와 녹음기가 잰 길이를 적는다. 길이가 비정상(0·NaN·음수)이면 적지 않는다. */
export function rememberVoiceDuration(attachmentId: string, durationMs: number): void {
  if (!attachmentId || !valid(durationMs)) return;
  load();
  mem.delete(attachmentId); // 다시 적으면 가장 최근으로
  mem.set(attachmentId, Math.round(durationMs));
  while (mem.size > MAX_ENTRIES) mem.delete(mem.keys().next().value as string);
  persist();
}

/** 이 첨부의 알려진 길이(ms). 모르면 undefined — 호출 쪽이 기본 플레이어로 폴백한다. */
export function getVoiceDuration(attachmentId: string): number | undefined {
  load();
  return mem.get(attachmentId);
}

/** 테스트용: 메모리와 저장소를 비우고 다음 접근에 저장소를 다시 읽게 한다. */
export function resetVoiceDurations(): void {
  mem.clear();
  loaded = false;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // silent-ok: 테스트 정리용
  }
}
