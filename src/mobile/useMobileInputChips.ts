/**
 * 폰 노트 화면의 제안 칩(S2) — 날짜 후보(전사문)·현재 위치(새 노트 첫 저장)·사진/음성 메타(서버 이벤트).
 * 칩 상태와 "누르면 반영" 배선만 여기 있다. 노트에 쓰는 IPC 는 mobileNoteInputActions.ts 의 순수 조각이고,
 * 본문을 치는 도중 감지하는 칩은 useMobileNudgeChips 가 따로 한다(입력 감지 줄 = 다른 UI).
 *
 * docs/PLAN-2026-10-06-s2-input.md.
 */
import { useEffect, useRef, useState } from "react";
import type { NoteDetail } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { listenMany } from "../lib/tauriListen";
import { CLIENT_ID } from "../lib/env";
import { useNotesStore } from "../stores/notes";
import { onAttachmentMetaApplied, type AttachmentMetaApplied } from "../lib/attachmentMetaToast";
import type { DateCandidate } from "./mobileInputFlows";
import type { InputChip } from "./MobileInputChips";
import { getLocMode } from "./mobilePrefs";
import { isLocationDenied } from "./useCurrentLocationApply";
import { addDateRow, applyCurrentLocation, applyDateCandidate, applyRegionToNote, removeDateRow } from "./mobileNoteInputActions";

type MetaSuggestedPayload = {
  note_id: string;
  client?: string;
  date?: { year: number; month: number; day: number; time?: string | null };
  region?: { name: string; lat: number; lng: number };
};

export type ChipData =
  | { key: string; noteId: string; kind: "date"; cand: DateCandidate }
  | { key: string; noteId: string; kind: "loc" }
  | {
      key: string;
      noteId: string;
      kind: "meta";
      summary: string;
      date?: MetaSuggestedPayload["date"];
      region?: MetaSuggestedPayload["region"];
    };

const fmtSuggestedDate = (d: NonNullable<MetaSuggestedPayload["date"]>) =>
  `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}${d.time ? ` ${d.time}` : ""}`;

export function useMobileInputChips({ capture, activeNote }: { capture: boolean; activeNote: NoteDetail | null }) {
  const [chips, setChips] = useState<ChipData[]>([]);
  const addChip = (c: ChipData) => setChips((p) => (p.some((x) => x.key === c.key) ? p : [...p, c]));
  const dropChip = (key: string) => setChips((p) => p.filter((x) => x.key !== key));

  // ---- S2 위치: 새 노트 첫 저장 시점에 지역이 비어 있으면 위치 모드(기기별)대로 ----------------------
  const locTriedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!capture || !activeNote) return;
    const id = activeNote.note.id;
    if (id === "__draft__" || locTriedRef.current.has(id) || activeNote.note.region) return;
    locTriedRef.current.add(id);
    const mode = getLocMode();
    if (mode === "off" || isLocationDenied()) return;
    if (mode === "ask") addChip({ key: `loc:${id}`, noteId: id, kind: "loc" });
    else void applyCurrentLocation(id, true);
  }, [capture, activeNote]);

  // ---- S2 서버 이벤트(사진/오디오 메타) — 내가 올린 것(또는 보낸 이를 모르는 것)만, 지금 열린 노트에 한해 ----
  useEffect(() => {
    const mine = (p?: { note_id?: string; client?: string } | null): boolean =>
      !!p?.note_id &&
      p.note_id === useNotesStore.getState().activeNote?.note.id &&
      (!p.client || p.client === CLIENT_ID);
    return listenMany([
      [
        "attachment-meta-suggested",
        (e: { payload?: MetaSuggestedPayload }) => {
          const p = e.payload;
          if (!p || !mine(p) || (!p.date && !p.region)) return;
          const summary = [p.date ? fmtSuggestedDate(p.date) : null, p.region?.name].filter(Boolean).join(" · ");
          addChip({ key: `meta:${p.note_id}:${summary}`, noteId: p.note_id, kind: "meta", summary, date: p.date, region: p.region });
        },
      ],
      [
        "attachment-meta-applied",
        (e: { payload?: AttachmentMetaApplied & { client?: string } }) => {
          if (e.payload && mine(e.payload)) onAttachmentMetaApplied(e.payload);
        },
      ],
    ]);
  }, []);

  const applyMetaChip = async (c: Extract<ChipData, { kind: "meta" }>) => {
    let addedDateId: string | null = null;
    if (c.date) {
      const d = c.date;
      addedDateId = await addDateRow(
        c.noteId,
        { payload: { year: d.year, month: d.month, day: d.day, ...(d.time ? { start_time: d.time } : {}) }, label: fmtSuggestedDate(d) },
        false,
      );
      if (!addedDateId) return;
    }
    if (c.region) {
      try {
        await applyRegionToNote(c.noteId, c.region);
      } catch {
        // call() 이 토스트. 칩은 남겨 다시 누를 수 있게 하므로, 이미 넣은 날짜 행은 되돌려 재탭이 중복 행을 만들지 않게 한다.
        if (addedDateId) await removeDateRow(addedDateId);
        return;
      }
    }
    dropChip(c.key);
  };

  const inputChips: InputChip[] = chips
    .filter((c) => c.noteId === activeNote?.note.id)
    .map((c): InputChip => {
      if (c.kind === "date") {
        return {
          key: c.key,
          text: t("mobileInput.date_suggest", { date: c.cand.label }),
          onApply: async () => {
            if (await applyDateCandidate(c.noteId, c.cand, false)) dropChip(c.key);
          },
          onDismiss: () => dropChip(c.key),
        };
      }
      if (c.kind === "loc") {
        return {
          key: c.key,
          text: t("mobileInput.loc_suggest"),
          onApply: async () => {
            if (await applyCurrentLocation(c.noteId, false)) dropChip(c.key);
          },
          onDismiss: () => dropChip(c.key),
        };
      }
      return {
        key: c.key,
        text: t("mobileInput.meta_suggest", { summary: c.summary }),
        onApply: () => applyMetaChip(c),
        onDismiss: () => dropChip(c.key),
      };
    });

  return { inputChips, addChip };
}
