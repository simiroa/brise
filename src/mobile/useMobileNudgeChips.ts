/**
 * 폰 에디터 입력 감지 제안(날짜·지역·링크·#태그) — 감지는 useMobileTypingNudges(읽기 전용 훅), 여기는 그 결과를
 * 눌러서 반영하는 UI 모델로 만들고 "누르면 반영"(IPC·본문 마크·되돌리기 토스트)을 배선한다. 자동 모드(date_nudge_auto)는
 * 제안 없이 바로 반영하고 토스트만 띄운다.
 *
 * 두 곳으로 갈린다(오너 2026-10-07):
 *  - `chips`  — 링크·#태그. 키보드 위 칩 줄(MobileInputChips variant="nudge").
 *  - `bubble` — 날짜·지역. 감지된 문장 위 말풍선(MobileNudgeBubble). 같은 apply/dismiss/되돌리기 클로저를 쓴다.
 *
 * docs/PLAN-2026-10-07-mobile-typing-nudges.md. 제안 칩(전사문 날짜·위치·메타)은 useMobileInputChips 가 따로 한다.
 */
import { useEffect } from "react";
import type { NoteDetail } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { call } from "../lib/invoke";
import { reportFallback } from "../lib/diag";
import { showToastOnly } from "../lib/undo";
import { bumpNoteQueryVersion } from "../lib/noteQuery";
import { importLinksToSections } from "../lib/linkImport";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore, dateNudgeModeOf } from "../stores/settings";
import type { InputChip } from "./MobileInputChips";
import type { NudgeBubbleAction, NudgeBubbleModel } from "./MobileNudgeBubble";
import { useMobileTypingNudges, type DateNudgeState, type NudgeKind } from "./useMobileTypingNudges";
import { applyDateMark, stripDateMark, replaceTagToken } from "./mobileNudgeApply";
import { applyRegionToNote, removeDateRow } from "./mobileNoteInputActions";
import type { MobileBodyEditor } from "./useMobileBodyEditor";

export interface MobileNudges {
  /** 링크·#태그 — 키보드 위 칩 줄. */
  chips: InputChip[];
  /** 날짜·지역 — 문장 위 말풍선. 둘 다 없으면 null. */
  bubble: NudgeBubbleModel | null;
}

/** 말풍선용 짧은 날짜 — 올해면 연도를 뺀다("10.09 10:00"), 아니면 "2027.01.05". 월이 없으면 연도만. */
export function shortBubbleDate(p: { year: number; month?: number | null; day?: number | null; start_time?: string | null }, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  let date: string;
  if (p.month == null) date = String(p.year);
  else {
    const md = `${pad(p.month)}${p.day != null ? `.${pad(p.day)}` : ""}`;
    date = p.year === now.getFullYear() ? md : `${p.year}.${md}`;
  }
  return p.start_time ? `${date} ${p.start_time}` : date;
}

export function useMobileNudgeChips({ ed, activeNote }: { ed: MobileBodyEditor; activeNote: NoteDetail | null }): MobileNudges {
  const { editor, readOnly, diagramSection, sheetSection, activeSectionId } = ed;
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);

  // 읽기 전용·관계도·시트 섹션은 편집기가 비어 있다 — 감지하지 않는다. 이 훅은 MobileNote 의 조기 반환
  // (`if (!activeNote || !editor) return null`) 위에서 불러야 한다(함정 1).
  const dateNudgeEnabled = useSettingsStore((s) => s.dateNudgeEnabled);
  const dateNudgeAuto = useSettingsStore((s) => s.dateNudgeAuto);
  const nudgesOn = !readOnly && !diagramSection && !sheetSection;
  const { state: nudges, dismiss: dismissNudge } = useMobileTypingNudges(
    editor,
    activeNote?.note.id ?? null,
    nudgesOn,
    activeSectionId,
  );

  /** 노트 id — 초안이면 먼저 실체화한다(데스크톱 넛지·링크 칩과 같은 규약). */
  const nudgeNoteId = async (): Promise<string | null> => {
    const id = useNotesStore.getState().activeNote?.note.id ?? null;
    if (id === "__draft__") return useNotesStore.getState().ensureMaterialized();
    return id;
  };

  /** 날짜: note_date_add → 글자에 마크 → 되돌리기 토스트(마크 걷기 + note_date_remove). 자동 모드도 토스트는 띄운다. */
  const applyDateNudge = async (n: DateNudgeState): Promise<boolean> => {
    const noteId = await nudgeNoteId();
    if (!noteId) return false;
    let id: string;
    try {
      ({ id } = await call<{ id: string }>("note_date_add", { note_id: noteId, ...n.payload }));
    } catch {
      return false; // call() 이 토스트
    }
    bumpNoteQueryVersion();
    useNotesStore.getState().bumpAttachmentRevision();
    // 칩을 누르는 사이 글자가 바뀌었으면 마크는 건너뛴다(날짜 행은 이미 생겼고 되돌리기로 지울 수 있다).
    // 기다리는 사이 다른 노트로 옮겼으면 그 노트 본문에 마크를 걸면 안 된다(같은 에디터 인스턴스를 재사용한다).
    if (editor && !editor.isDestroyed && useNotesStore.getState().activeNote?.note.id === noteId) {
      applyDateMark(editor, { paraStart: n.paraStart, paraText: n.paraText, from: n.matchFrom, to: n.matchTo }, id);
    }
    showToastOnly(
      t("attachmentMeta.applied", { summary: n.label }),
      () => {
        if (editor && !editor.isDestroyed) stripDateMark(editor, id);
        void removeDateRow(id);
      },
      { actionLabel: t("attachmentMeta.undo") },
    );
    return true;
  };

  const applyRegionNudge = async (r: { name: string; lat: number; lng: number }): Promise<boolean> => {
    const noteId = await nudgeNoteId();
    if (!noteId) return false;
    let res: { waypointId: string | null };
    try {
      res = await applyRegionToNote(noteId, r);
    } catch {
      return false; // call() 이 토스트
    }
    const wp = res.waypointId;
    showToastOnly(
      t(wp ? "mobileInput.nudge_waypoint_applied" : "mobileInput.loc_applied", { region: r.name }),
      () => {
        void (async () => {
          if (wp) {
            try {
              await call("note_region_remove", { id: wp });
              useNotesStore.getState().bumpAttachmentRevision();
            } catch {
              // silent-ok: call() 이 토스트를 띄웠다 — 경유지는 지역 목록에서 직접 지운다.
            }
          } else {
            await useNotesStore.getState().setRegion(null);
            await useNotesStore.getState().setLocation(null, null);
          }
        })();
      },
      { actionLabel: t("attachmentMeta.undo") },
    );
    return true;
  };

  const applyUrlNudge = async (url: string): Promise<boolean> => {
    const noteId = await nudgeNoteId();
    if (!noteId) return false;
    // 실패 안내는 linkImport.ts 가 이미 한다. AI 가 켜져 있으면 정리, 아니면 원문(T2).
    await importLinksToSections([url], noteId, aiEnabled ? "ai" : "raw");
    return true;
  };

  // 자동 모드(date_nudge_auto): 칩 없이 바로 반영하고 토스트만. 같은 매치를 두 번 보내지 않게 먼저 무시 기억에 올린다.
  useEffect(() => {
    const d = nudges.date;
    if (!d) return;
    const ss = useSettingsStore.getState();
    if (dateNudgeModeOf(ss.dateNudgeEnabled, ss.dateNudgeAuto) !== "auto") return;
    dismissNudge("date", nudges);
    void applyDateNudge(d);
    // applyDateNudge 는 매 렌더 새로 만들어지는 클로저라 의존성에 넣지 않는다 — 감지 결과가 바뀔 때만 돈다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudges.date]);

  /** 눌러서 반영 / 무시 — 칩과 말풍선이 같은 클로저를 쓴다. 반영이 성공했을 때만 제안을 닫는다. */
  const nudgeHandlers = (kind: NudgeKind, run: () => Promise<boolean>) => ({
    onApply: async () => {
      if (await run()) dismissNudge(kind, nudges);
    },
    onDismiss: () => dismissNudge(kind, nudges),
  });
  const nudgeChip = (kind: NudgeKind, text: string, run: () => Promise<boolean>): InputChip => ({
    key: `nudge:${kind}`,
    text,
    nudge: true,
    ...nudgeHandlers(kind, run),
  });

  // 날짜·지역 → 말풍선. 날짜는 "제안" 모드일 때만(자동 모드는 위 이펙트가 바로 반영한다).
  const bubbleActions: NudgeBubbleAction[] = [];
  if (nudges.date && dateNudgeModeOf(dateNudgeEnabled, dateNudgeAuto) === "suggest") {
    const d = nudges.date;
    bubbleActions.push({
      key: "date",
      // 알약은 달력 아이콘 + 짧은 날짜만(2026-10-07 S22: "일정 등록 · 2026.10.09 10:00" + 지역이 390px 에서 두 줄이 돼
      // 윗줄 두 개를 덮었다). 전체 문구는 스크린리더용.
      text: shortBubbleDate(d.payload),
      ariaLabel: t("mobileInput.nudge_date", { date: d.label }),
      ...nudgeHandlers("date", () => applyDateNudge(d)),
    });
  }
  if (nudges.region) {
    const r = nudges.region;
    const label = t(activeNote?.note.region ? "mobileInput.nudge_waypoint" : "mobileInput.nudge_region", { region: r.name });
    bubbleActions.push({
      key: "region",
      // 알약에는 핀 아이콘 + 이름뿐(짧게, 대표/경유지 구분은 스크린리더 문구와 반영 토스트가 말한다).
      text: r.name,
      ariaLabel: label,
      ...nudgeHandlers("region", () => applyRegionNudge(r)),
    });
  }
  // 앵커 = 감지한 문단의 시작. 날짜는 자기 paraStart 가 있고, 지역은 스캔이 남긴 restParaStart 를 쓴다.
  const bubble: NudgeBubbleModel | null = bubbleActions.length
    ? { anchorPos: nudges.date?.paraStart ?? nudges.restParaStart ?? null, actions: bubbleActions }
    : null;

  // 링크·#태그 → 키보드 위 칩 줄.
  const nudgeChips: InputChip[] = [];
  if (nudges.url) {
    const u = nudges.url;
    nudgeChips.push(nudgeChip("url", t("mobileInput.nudge_link"), () => applyUrlNudge(u)));
  }
  if (nudges.tag) {
    const tg = nudges.tag;
    for (const item of tg.items) {
      nudgeChips.push({
        key: `nudge:tag:${item.isNew ? "new:" : ""}${item.name}`,
        text: item.isNew ? t("mobileInput.nudge_tag_new", { tag: item.name }) : `#${item.name}`,
        nudge: true,
        noDismiss: true,
        onApply: async () => {
          if (!editor || editor.isDestroyed) return;
          const at = { paraStart: tg.paraStart, paraText: tg.paraText, from: tg.query.from, to: tg.query.to };
          if (!replaceTagToken(editor, at, item.name)) return;
          // 전량 교체 계약 — 읽고 덧붙인다(hashTag.tsx::insertHashTagSelection 과 같다). 초안도 setTags 가 처리한다.
          const current = useNotesStore.getState().activeNote?.note.tag_names ?? [];
          if (current.includes(item.name)) return;
          try {
            await useNotesStore.getState().setTags([...current, item.name]);
          } catch {
            reportFallback("mobile-typing-nudge", "set_tags_failed"); // 글자는 이미 바뀌었다 — 태그만 못 달았다
          }
        },
        onDismiss: () => {},
      });
    }
  }
  return { chips: nudgeChips, bubble };
}
