// 시트 차트 → 첨부 등록/해제 — **하나의 함수**를 세 진입점(편집기 토글·카드 버튼·어시스트/W5)이
// 부른다(PLAN-2026-09-20 D6). 진실은 DB 행(kind='chart', url="<section_id>#<chart_id>")이고
// 시트 JSON 에는 플래그를 두지 않는다(두 진실 금지). 낙관적 갱신 없음 — 왕복이 짧고 실패 시
// 되돌릴 화면 상태가 없다. 성공하면 reloadActive 로 activeNote.attachments 를 다시 읽는다.
import { call, flushAll } from "../invoke";
import { useNotesStore } from "../../stores/notes";
import type { Attachment } from "../commands.gen";

export function chartAttachmentUrl(sectionId: string, chartId: string): string {
  return `${sectionId}#${chartId}`;
}

/** 이 차트를 가리키는 chart 첨부 행 — 없으면 undefined. 토글 초기값과 해제할 행 id 가 여기서 나온다. */
export function findChartAttachment(
  attachments: readonly Attachment[] | undefined,
  sectionId: string,
  chartId: string,
): Attachment | undefined {
  const url = chartAttachmentUrl(sectionId, chartId);
  return attachments?.find((a) => a.kind === "chart" && a.url === url);
}

export function isChartRegistered(
  attachments: readonly Attachment[] | undefined,
  sectionId: string,
  chartId: string,
): boolean {
  return findChartAttachment(attachments, sectionId, chartId) !== undefined;
}

export interface SetChartRegisteredArgs {
  noteId: string;
  sectionId: string;
  chartId: string;
  /** 첨부 이름(차트 제목 or 폴백) — 켤 때만 쓰인다. */
  name: string;
  on: boolean;
}

/**
 * 켜기 = `attachment_add_chart`(멱등 — 이미 있으면 같은 행), 끄기 = `attachment_remove`(그 행 id).
 * `call()` 은 토스트를 띄운 뒤 다시 throw 한다(CLAUDE.md 함정 8) — 호출자는 `try { await } catch {}`.
 * 켜기 전에 `flushAll()` 을 부르는 이유: 방금 만든 차트는 useSheetState 의 700ms 디바운스 안에
 * 있어 DB 의 시트 본문에 아직 없고, Rust 검증(`charts[]` 에 id 존재)이 NOT_FOUND 를 낸다.
 * ponytail: flushAll 은 등록된 flush 콜백을 돌릴 뿐 그 안의 `void updateSectionBody` 완료를
 * 기다리지 않는다 — IPC 메시지는 같은 웹뷰에서 순서대로 처리되므로 section_update 가
 * attachment_add_chart 보다 먼저 DB 에 닿는다. 순서 보장이 깨지는 날 useSheetState.saveNow 를
 * awaitable 로 바꿔 여기서 기다린다.
 */
export async function setChartRegistered(args: SetChartRegisteredArgs): Promise<void> {
  const { noteId, sectionId, chartId, name, on } = args;
  const store = useNotesStore.getState();
  if (on) {
    await flushAll();
    await call<Attachment>("attachment_add_chart", {
      note_id: noteId,
      section_id: sectionId,
      chart_id: chartId,
      name,
    });
  } else {
    const existing = findChartAttachment(store.activeNote?.attachments, sectionId, chartId);
    if (!existing) return;
    await call("attachment_remove", { id: existing.id });
  }
  await useNotesStore.getState().reloadActive();
}
