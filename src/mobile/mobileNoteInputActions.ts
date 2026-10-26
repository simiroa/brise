/**
 * 폰 노트 화면이 노트에 날짜·지역을 다는 쓰기 조각 — 화면 상태가 없는 비동기 함수들(훅 아님).
 *
 * 제안 칩(useMobileInputChips)·음성 전사(useMobileVoiceTranscript)·입력 감지 칩(useMobileNudgeChips)이
 * 같은 쓰기를 쓴다. 한 곳에 둬서 세 경로가 서로 다른 모양으로 갈라지지 않게 한다 — 대표 지역은 비었을 때만,
 * 날짜 행은 추가 뒤 되돌리기 토스트, 실패는 call() 이 이미 토스트(여기서 한 번 더 알리지 않는다).
 */
import type { DateCandidate } from "./mobileInputFlows";
import type { VoicePositionAnswer, VoicePositionPhase } from "./voiceHandOff";
import { noteLocationDenied, noteLocationGranted, planVoicePosition } from "./voicePositionPolicy";
import { call, emitNotice } from "../lib/invoke";
import { reportFallback } from "../lib/diag";
import { showToastOnly } from "../lib/undo";
import { bumpNoteQueryVersion } from "../lib/noteQuery";
import { getCurrentPosition, CurrentPositionError } from "../lib/currentPosition";
import { nextWaypointPosition } from "../components/attachments/regionDisplay";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { t } from "../i18n/t";
import { getLocMode } from "./mobilePrefs";
import { isLocationDenied, resolveCurrentLocation } from "./useCurrentLocationApply";

/** 위치 실패 → 사용자 말(문구는 MobileRegionSheet 와 같은 mobileLoc 키). */
function locErrorText(e: unknown): string {
  switch (e instanceof CurrentPositionError ? e.code : "unavailable") {
    case "no_permission":
      return t("mobileLoc.err_no_permission");
    case "no_provider":
      return t("mobileLoc.err_no_provider");
    case "timeout":
      return t("mobileLoc.err_timeout");
    case "security":
      return t("mobileLoc.err_security");
    default:
      return t("mobileLoc.err_unavailable");
  }
}

/**
 * 녹음기가 위치를 물을 때(녹음 구간 시작 · 정지 직후). 녹음 중인 화면 위에 위치 권한 대화상자를 띄우지 않는 것이
 * 이 함수의 일이다 — 위치 모드·허용 기억별 표는 `voicePositionPolicy.ts`.
 *  - "start": 허용을 아는 경우에만 읽는다. auto 인데 허용을 모르면 `"later"`(정지 뒤에 다시 물어 달라).
 *  - "stop": 녹음이 멈춘 뒤라 대화상자가 떠도 녹음을 끊지 않는다(auto 이고 허용을 모를 때만 의미가 있다).
 * 실패는 null(녹음·저장은 계속). no_permission 은 이번 세션 동안 음성 경로가 다시 묻지 않게 기억한다.
 */
export async function getVoicePosition(phase: VoicePositionPhase = "start"): Promise<VoicePositionAnswer> {
  const plan = planVoicePosition(getLocMode(), phase, isLocationDenied());
  if (plan === "skip") return null;
  if (plan === "later") return "later";
  try {
    const p = await getCurrentPosition();
    noteLocationGranted();
    return { lat: p.lat, lng: p.lng };
  } catch (e) {
    const code = e instanceof CurrentPositionError ? e.code : "unavailable";
    if (code === "no_permission") noteLocationDenied();
    reportFallback("location", `voice_position_${code}`);
    return null;
  }
}

/** 날짜 행 되돌리기. 실패는 call() 이 토스트했다. */
export async function removeDateRow(id: string): Promise<void> {
  try {
    await call("note_date_remove", { id });
    bumpNoteQueryVersion();
    useNotesStore.getState().bumpAttachmentRevision();
  } catch {
    // silent-ok: call() 이 토스트를 띄웠다 — 되돌리기 실패는 사용자가 날짜 목록에서 직접 지운다.
  }
}

/** @returns 새로 만든 날짜 행의 id, 실패하면 null */
export async function addDateRow(noteId: string, cand: DateCandidate, announce: boolean): Promise<string | null> {
  let id: string;
  try {
    ({ id } = await call<{ id: string }>("note_date_add", { note_id: noteId, ...cand.payload }));
  } catch {
    return null; // call() 이 토스트
  }
  bumpNoteQueryVersion();
  useNotesStore.getState().bumpAttachmentRevision();
  if (announce) {
    showToastOnly(
      t("attachmentMeta.applied", { summary: cand.label }),
      () => void removeDateRow(id),
      { actionLabel: t("attachmentMeta.undo") },
    );
  }
  return id;
}

export async function applyDateCandidate(noteId: string, cand: DateCandidate, announce: boolean): Promise<boolean> {
  return (await addDateRow(noteId, cand, announce)) !== null;
}

/**
 * 지역 하나를 노트에 단다 — 대표 지역이 비었으면 대표로(+좌표), 있으면 다음 순번 경유지로.
 * 메타 칩과 입력 감지 칩이 같은 쓰기를 쓴다. 실패는 던진다(call() 이 이미 토스트).
 * @returns 경유지로 넣었으면 그 행 id(되돌리기용), 대표로 넣었으면 null
 */
export async function applyRegionToNote(
  noteId: string,
  r: { name: string; lat: number; lng: number },
): Promise<{ waypointId: string | null }> {
  const store = useNotesStore.getState();
  if (!store.activeNote?.note.region) {
    await store.setRegion(r.name);
    await store.setLocation(r.lat, r.lng);
    return { waypointId: null };
  }
  const list = await call<{ regions: { position: number }[] }>("note_regions_list", { note_id: noteId });
  const added = await call<{ id: string }>("note_region_add", {
    note_id: noteId,
    name: r.name,
    lat: r.lat,
    lng: r.lng,
    position: nextWaypointPosition(list?.regions ?? []),
  });
  store.bumpAttachmentRevision();
  return { waypointId: added?.id ?? null };
}

/**
 * 지금 위치를 대표 지역으로. 위치 모드(기기별) off·권한 거부는 여기서 보지 않는다 — 부르는 쪽이 거른다
 * (새 노트 첫 저장 효과가 먼저 보고, 칩은 ask 모드에서만 생긴다).
 * @returns 반영됐으면(또는 이미 누가 채웠으면) true, 실패면 false
 */
export async function applyCurrentLocation(noteId: string, announce: boolean): Promise<boolean> {
  let loc;
  try {
    loc = await resolveCurrentLocation(useSettingsStore.getState().uiLang);
    noteLocationGranted(); // 음성 녹음기가 "이미 허용됨" 을 알도록(voicePositionPolicy)
  } catch (e) {
    if (e instanceof CurrentPositionError && e.code === "no_permission") noteLocationDenied();
    if (!announce) return false; // 자동은 조용히(진단은 resolveCurrentLocation 이 남겼다) — 수동 탭만 사용자 말로 알린다
    emitNotice(locErrorText(e));
    return false;
  }
  const store = useNotesStore.getState();
  // 오는 사이 다른 노트로 갔거나 누가 지역을 채웠으면 덮지 않는다(대표 지역은 비었을 때만).
  if (store.activeNote?.note.id !== noteId || store.activeNote.note.region) return true;
  await store.setRegion(loc.region);
  await store.setLocation(loc.lat, loc.lng);
  if (useNotesStore.getState().activeNote?.note.region !== loc.region) return false; // 저장 실패 — 스토어가 되돌렸다
  if (announce) {
    showToastOnly(
      t("mobileInput.loc_applied", { region: loc.region }),
      () => {
        void (async () => {
          await useNotesStore.getState().setRegion(null);
          await useNotesStore.getState().setLocation(null, null);
        })();
      },
      { actionLabel: t("attachmentMeta.undo") },
    );
  }
  return true;
}
