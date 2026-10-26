/**
 * 링크를 노트로 들여오는 **유일한 경로**. 진입점은 넷이고 넷 다 이 파일을 지난다:
 *   1. 첨부 바 "링크 추가" 대화상자의 가져오기 버튼(attachments/AttachmentDialogs.tsx)
 *   2. 에디터에 단독 URL 을 붙여넣었을 때 뜨는 넛지(common/LinkNudge.tsx)
 *   3. 에디터 링크 우클릭, 그리고 **링크가 여럿 든 선택 영역** 우클릭(editor/SelectionContextMenu.tsx)
 *   4. 첨부 바의 **링크 타일** 우클릭 — 이미 저장해 둔 링크도 같은 액션에 닿아야 한다
 *
 * 원래 (1) 안에 인라인으로 있었고 나머지가 붙으면서 여기로 올렸다 — 같은 기능은 같은 관문을
 * 지나야 한다(.claude/CLAUDE.md 코드 방침). 새 커맨드는 만들지 않았다: 링크 첨부를 만드는
 * `attachment_add_link` + 그 첨부의 본문을 추출하는 `attachment_fetch_reader` + AI 액션을 임의
 * 텍스트에 돌리는 `runAiAction(preset, ctx)` 가 이미 전부 있다.
 *
 * 부수효과가 하나 있고 의도된 것이다: **링크는 첨부로도 남는다.** (1) 이 원래 그랬고, 추출한
 * 출처가 노트에 안 남으면 나중에 "이 섹션이 어디서 왔나"를 되짚을 수 없다. 같은 URL 의 링크
 * 첨부가 이미 있으면 그것을 재사용해 누를 때마다 행이 쌓이지 않게 한다.
 */
import { call, callSilent, emitNotice } from "./invoke";
import { t } from "../i18n/t";
import { insertAiSection, withSourceLine } from "./aiSectionBridge";
import { useNotesStore } from "../stores/notes";
import { ensureAiAskGate } from "../stores/ai";
import { runAiAction } from "../stores/runAiAction";
import { enginePreset } from "../components/ai/askAiHelpers";
import { reportFallback } from "./diag";
import { linkSiteLabel } from "./urls";
import { runBatch } from "./batchActions";
import { emitProgress } from "./progressToast";
import { showUndoToast } from "./undo";
import { undoImportedSections } from "./noteActions";
import type { Attachment, AttachmentFetchReaderOutput, Section } from "./commands.gen";

/** "정리"(BUILTIN_DEFS) — 사용자가 설정에서 프롬프트를 고쳤다면 그 편집본이 쓰인다. */
const AI_ORGANIZE_PRESET_ID = "organize";

/** 파일 가져오기 배치와 같은 진행 토스트 관례(lib/noteActions.ts) — 키만 다르다. */
const LINK_PROGRESS_KEY = "import_links";

export type LinkImportMode = "raw" | "ai";

/**
 * @param name 첨부 이름. 비면 URL 을 쓴다(대화상자와 같은 규칙).
 * @returns 만들어진 섹션, 실패면 null. 실패는 전부 사용자에게 알린 뒤 null 이다 — 조용히 아무 일도
 *          안 일어나는 상태를 만들지 않는다. 호출자가 섹션을 돌려받는 이유는 배치 되돌리기다
 *          (undoImportedSections 는 "이 가져오기가 만든 id" 만 지운다).
 */
export async function importLinkToSection(
  url: string,
  name: string,
  noteId: string,
  mode: LinkImportMode,
): Promise<Section | null> {
  let att: Attachment;
  try {
    // 같은 URL 의 링크 첨부 재사용 — 넛지를 두 번 눌러도 첨부가 둘이 되지 않는다.
    const existing = useNotesStore
      .getState()
      .activeNote?.attachments.find((a) => a.kind === "link" && a.url === url);
    if (existing) {
      att = existing;
    } else {
      att = await call<Attachment>("attachment_add_link", {
        note_id: noteId,
        name: name.trim() || url,
        url,
      });
      // 첨부를 추가한 뒤의 정석 갱신(selectNote 보다 가볍고 attachmentRevision 도 올린다 —
      // stores/notesActive.ts 의 reloadActive 주석). 섹션을 만들기 **전에** 돌린다: 삽입은
      // switchSection 까지 하므로 그 뒤에 노트를 다시 읽으면 방금 전환한 섹션과 경합한다.
      await useNotesStore.getState().reloadActive();
    }
  } catch {
    return null; /* call() 이 AppError 토스트를 이미 띄웠다 */
  }

  // ponytail: youtube 처럼 본문이 스크립트로만 들어오는 페이지는 추출 결과가 빈다. 그 경우도
  // "읽을 수 없음"과 같은 안내로 끝낸다 — 링크 첨부는 남으므로 브라우저에서 열 길은 있다.
  let reader: AttachmentFetchReaderOutput | null = null;
  try {
    // callSilent: 원격 fetch 실패는 앱 버그가 아니라 "이 페이지는 앱에서 못 읽는다"는 평범한
    // 결과다(LinkReaderPreview 와 같은 판단). 단 callSilent 도 다시 throw 하므로 여기서
    // 붙잡아야 한다(.claude/CLAUDE.md 함정 8).
    reader = await callSilent<AttachmentFetchReaderOutput>("attachment_fetch_reader", { id: att.id });
  } catch {
    reader = null;
  }
  const text = reader?.text?.trim() ?? "";
  if (!text) {
    emitNotice(t("attachments.preview_link_unavailable"));
    return null;
  }

  const title = reader?.title?.trim() || name.trim() || "";
  const sectionName = title || linkSiteLabel(url);

  if (mode === "raw") {
    // aiOrigin 없음 — 모델이 개입하지 않은 추출본이므로 AI 작성 점을 달지 않는다
    // (lib/aiSectionBridge.ts 의 insertAiSection 주석).
    return insertAiSection(sectionName, withSourceLine(text, [{ label: title || linkSiteLabel(url), url }]), noteId);
  }

  if (!(await ensureAiAskGate())) return null;
  // 정리 장문은 AI 프리셋(타일 문장)으로는 은퇴했다 — 바로 실행 목록(BUILTIN_DEFS)에서 가져온다.
  const preset = await enginePreset(AI_ORGANIZE_PRESET_ID);
  if (!preset) {
    reportFallback("link_import", "organize_preset_missing", AI_ORGANIZE_PRESET_ID);
    return null;
  }
  // 캡 초과·프로바이더 실패·빈 결과 안내는 전부 runAiAction 안에 있다(입력 상한 프리플라이트
  // 포함) — 여기서 다시 재지 않는다. insertSection 을 우리가 넘기므로 출처 한 줄을 붙일 자리가
  // 생기고, 만들어진 섹션도 그대로 받는다(runAiAction 자체는 boolean 만 돌려준다).
  // 객체에 담는 이유는 TS 뿐이다 — 콜백 안 대입만 있으면 let 은 계속 null 로 좁혀진다.
  const box: { sec: Section | null } = { sec: null };
  const ok = await runAiAction(preset, {
    contextText: text,
    insertSection: async (n, body, target, kind, opts) => {
      box.sec = await insertAiSection(n, withSourceLine(body, [{ label: title || linkSiteLabel(url), url }]), target, kind, opts);
      return box.sec;
    },
    targetNoteId: noteId,
  });
  return ok ? box.sec : null;
}

/**
 * 링크 여럿을 한 번에(오너 2026-09-10: "여러 링크가 포함된 선택도 가능한가"). 파일 여러 개를
 * 섹션으로 가져오는 배치(lib/noteActions.ts::importFilesAsSections)와 **똑같은 관례**를 쓴다 —
 * `runBatch` 순차 실행 · 진행 토스트 · 부분 실패를 숫자로 보고 · 하나라도 만들어졌으면 되돌리기
 * 토스트. 유사 기능이 다른 경험을 갖지 않게 하는 것이 규칙이고, 문구 키도 그쪽 것을 그대로 쓴다.
 *
 * 순차인 이유도 그쪽과 같다(+ 하나 더): 각 링크가 원격 fetch 라 병렬로 쏘면 같은 호스트에 동시
 * 요청이 되고, 사이에 끼는 `reloadActive`/섹션 삽입이 서로 경합한다.
 *
 * 진행 토스트를 2개부터 띄우는 건 파일(3개)보다 낮은 문턱이다 — 링크 하나가 최대 10초(fetch
 * 타임아웃)라 둘만 돼도 체감이 파일 셋보다 길다.
 */
export async function importLinksToSections(
  urls: string[],
  noteId: string,
  mode: LinkImportMode,
): Promise<Section[]> {
  if (urls.length === 0) return [];
  if (urls.length === 1) {
    const sec = await importLinkToSection(urls[0], "", noteId, mode);
    return sec ? [sec] : [];
  }

  const created: Section[] = [];
  const showProgress = urls.length >= 2;
  // runBatch 의 onProgress 는 **한 건이 끝난 뒤** 처음 불린다 — 첫 fetch 가 10초를 먹는 동안
  // 무반응이 되지 않도록 0/N 을 먼저 띄운다(importFilesAsSections 와 같은 이유).
  if (showProgress) {
    emitProgress(LINK_PROGRESS_KEY, t("editor.section_import_progress", { done: 0, total: urls.length }));
  }
  let res;
  try {
    res = await runBatch(
      urls,
      async (url) => {
        const sec = await importLinkToSection(url, "", noteId, mode);
        // runBatch 는 throw 로만 실패를 센다 — 여기서 던지지 않으면 못 읽은 링크가 성공으로
        // 집계되고 "3개 완료"가 거짓이 된다(안내 토스트는 importLinkToSection 이 이미 띄웠다).
        if (!sec) throw new Error("link import failed");
        created.push(sec);
      },
      showProgress
        ? (done, total) => emitProgress(LINK_PROGRESS_KEY, t("editor.section_import_progress", { done, total }))
        : undefined,
    );
  } finally {
    if (showProgress) emitProgress(LINK_PROGRESS_KEY, null);
  }

  const summary =
    res.failed.length === 0
      ? t("editor.section_import_done", { n: created.length })
      : t("editor.section_import_partial", { ok: res.ok.length, failed: res.failed.length });
  if (created.length > 0) {
    const ids = created.map((s) => s.id);
    showUndoToast(summary, () => {
      void undoImportedSections(noteId, ids);
    });
  } else {
    emitNotice(summary);
  }
  return created;
}
