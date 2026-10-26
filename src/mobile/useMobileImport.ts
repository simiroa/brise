/**
 * "가져오기"(다른 앱 → Brise, 오너 결정 Q-S3 (b)) 의 페이지 쪽 흐름.
 *
 * 규칙(오너, D1 2026-10-10 — 저장하기 버튼이 없어지며 바뀌었다. 예전엔 "저장하기를 눌러야 노트, 손대지 않고 나가면 버림"):
 *  - 가져오기 도착 → 입력 화면을 새 초안으로 열고 제목·본문을 초안에 채운다(아직 노트 아님, 서버 쓰기 0).
 *  - 입력 화면을 떠나면(뒤로·탭·하드웨어 뒤로·링크로 다른 노트 열기·다시 가져오기) → "가져온 내용도 내용"이라 노트를 만들고
 *    (ensureMaterialized) **바로 나간다.** 노트 만들기가 실패하면 화면에 머문다(내용은 그대로).
 *  - 이미지는 어느 경우든(O-2) 나가기를 막지 않고 그 노트에 백그라운드로 올린다. 못 올린 사진은 지우지도 ack 하지도 않고
 *    importId→노트 매핑을 내구 기록(mobileImportLedger)에 남긴다. 노트 화면 표시줄의 [다시 올리기]·[버리기]가 이어받는다.
 *    ack 는 전부 올라갔거나 사용자가 버렸을 때만.
 *  - 버리려면 가져오기 띠의 [버리기](`discard`) — 아직 초안일 때만 보인다. [그래도 나가기](V5) 뒤의 나가기도 버린다.
 * 이 규칙은 MobileApp 의 모든 입력 화면 출구가 `settle` 한 곳을 지나서 지킨다.
 *
 * 전달: 셸이 가져오기를 ack 전까지 쥐고 있고(읽기만 한다), 페이지가 (a) 부팅 (b) 앞으로 돌아옴(visibilitychange)
 * (c) 셸의 `brise-import-ready` 알림 때 당겨 온다. 같은 importId 는 한 번만 채운다.
 * ack 가 배치 단위라 사진이 덜 올라간 배치도 다시 온다. 장부(ledger)에 있는 importId 는 입력 화면을 새로 열지 않고
 * "그 노트에 못 올린 사진 다시 올리기"로 보낸다(중복 노트 방지).
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/t";
import { emitNotice } from "../lib/invoke";
import { reportFallback } from "../lib/diag";
import { useNotesStore } from "../stores/notes";
import { buildImportPlan, type ImportFile, type ImportPlan } from "./mobileImport";
import { ackImport, hasImportBridge, pullPendingImport } from "./mobileImportBridge";
import { defaultImportSessionDeps, fillCaptureDraft, ImportSession } from "./mobileImportSession";
import { getLedgerEntry, recordLedger, removeLedger, setLedgerBusy, updateLedgerFiles, type LedgerEntry } from "./mobileImportLedger";

/** 셸이 앱이 이미 떠 있는 페이지에 새 가져오기를 알릴 때 window 로 보내는 이벤트(데이터 없음 — 내용은 당겨 온다). */
export const IMPORT_READY_EVENT = "brise-import-ready";

export type ImportSettle =
  /** 가져오기 세션이 없다 — 평소 흐름. */
  | "none"
  /** 초안을 노트로 만들고 나간다(이미지는 백그라운드로 올린다). */
  | "saved"
  /** 초안을 노트로 만들지 않고 버렸다(commit=false — [그래도 나가기] 뒤. 저장된 게 없다 — "저장되었습니다" 안내를 띄우면 안 된다). */
  | "discarded"
  /** 이미 노트가 된 뒤 나간다 — 이미지는 백그라운드로 올린다. */
  | "background"
  /** 노트 만들기나 이미지 올리기가 실패했다 — 화면에 머문다. */
  | "stay";

export interface UseMobileImportOptions {
  /**
   * 입력 화면을 여는 화면 절차(MobileApp): flush → 저장 실패 관문 → 이전 가져오기 정리 → 새 초안 → `fill` → 화면 전환.
   * 관문에 막히면 false(`proceed` 는 사용자가 [그래도 나가기]를 골랐을 때 다시 부를 함수).
   */
  openCapture: (fill: () => Promise<void>, proceed: () => void, force: boolean) => Promise<boolean>;
}

// 페이지 수명 동안의 중복 방지. 페이지를 새로 읽으면 사라지지만 그때는 셸이 ack 전 배치를 다시 준다(=다시 채운다).
const seen = new Set<string>();
const claiming = new Set<string>();
// 화면을 떠난 뒤에도 백그라운드로 이미지를 올리는 중인 가져오기 — 셸의 임시 파일을 아직 지우면 안 된다(다시 당겨 온
// 배치를 "이미 채움 → ack 만" 으로 처리하는 길이 이걸 보고 건너뛴다). 못 올린 몫은 장부(mobileImportLedger)가 쥔다.
const uploadingInBackground = new Map<string, ImportSession>();

const newSession = (importId: string, files: ImportFile[]) =>
  new ImportSession(importId, files, defaultImportSessionDeps, (rest) => updateLedgerFiles(importId, rest));

/**
 * 노트가 된 가져오기의 사진을 그 노트에 백그라운드로 올린다. 호출자는 기다리지 않는다. 던지지 않는다.
 * 전부 올라갔거나 올릴 수 없어 버려졌으면 장부를 지우고 ack(셸이 임시 파일 삭제). 못 올린 사진이 남으면 ack 하지 않고 장부에 둔다.
 */
function uploadInBackground(s: ImportSession, noteId: string, silent: boolean): void {
  if (uploadingInBackground.has(s.importId)) return;
  if (s.pending === 0) {
    removeLedger(s.importId);
    void s.finish();
    return;
  }
  recordLedger(s.importId, noteId, s.files);
  uploadingInBackground.set(s.importId, s);
  setLedgerBusy(s.importId, true);
  void s
    .uploadAll(noteId)
    .then((r) => {
      if (r.dropped > 0 && !silent) emitNotice(t("mobileImport.upload_dropped", { count: r.dropped }));
      if (r.failed > 0) {
        if (!silent) emitNotice(t("mobileImport.upload_failed_bg", { count: r.failed }));
        return; // 장부에 남는다. ack 하지 않는다
      }
      removeLedger(s.importId);
      return s.finish();
    })
    .catch((e) => reportFallback("mobile-import", "background_finish_failed", e instanceof Error ? e.message.slice(0, 60) : "error"))
    .finally(() => {
      uploadingInBackground.delete(s.importId);
      setLedgerBusy(s.importId, false);
    });
}

/** 장부의 못 올린 사진을 다시 올린다. 노트 화면 표시줄의 [다시 올리기]와 다시 당겨 온 배치가 같은 길이다. */
export function retryImportUploads(entry: LedgerEntry, silent = false): void {
  if (uploadingInBackground.has(entry.importId)) return;
  uploadInBackground(newSession(entry.importId, entry.files), entry.noteId, silent);
}

/** 못 올린 사진을 버린다(표시줄의 [버리기]). 올리는 중이면 멈추고, 장부를 지우고, ack. */
export async function discardImportUploads(importId: string): Promise<void> {
  uploadingInBackground.get(importId)?.dropFiles();
  removeLedger(importId);
  await ackImport(importId);
}

export function useMobileImport({ openCapture }: UseMobileImportOptions) {
  const sessionRef = useRef<ImportSession | null>(null);
  const settlingRef = useRef<Promise<ImportSettle> | null>(null);
  const [pending, setPending] = useState(0);
  // 세션이 있는가(렌더용) — sessionRef 는 다시 그리게 하지 않으므로 띠의 [버리기] 표시는 이 값을 본다.
  const [active, setActive] = useState(false);
  const openRef = useRef(openCapture);
  openRef.current = openCapture;

  const fill = async (plan: ImportPlan) => {
    let bodyMd = "";
    if (plan.text.trim()) {
      // 동적 import — 에디터(Tiptap)를 끌고 오는 모듈이라 가져오기가 실제로 왔을 때만 로드한다.
      const { canonicalImportBody } = await import("./mobileImportBody");
      const c = canonicalImportBody(plan.text);
      bodyMd = c.bodyMd;
      // 사실만 기록한다 — 본문·URL 은 싣지 않는다.
      if (!c.stable) reportFallback("mobile-import", "body_unstable", "no fixed point");
      if (!c.editable) reportFallback("mobile-import", "body_readonly", "unsupported markdown shape");
    }
    if (!fillCaptureDraft(bodyMd, plan.title)) throw new Error("capture draft not open");
    const s = newSession(plan.importId, plan.files);
    sessionRef.current = s;
    seen.add(plan.importId);
    setPending(s.pending);
    setActive(true);
  };

  const runPlan = async (plan: ImportPlan, force: boolean): Promise<void> => {
    if (seen.has(plan.importId) || claiming.has(plan.importId)) return;
    claiming.add(plan.importId);
    try {
      if (!plan.hasContent) {
        seen.add(plan.importId);
        emitNotice(t("mobileImport.nothing"));
        await ackImport(plan.importId);
        return;
      }
      let opened: boolean;
      try {
        opened = await openRef.current(() => fill(plan), () => void runPlan(plan, true), force);
      } catch (e) {
        reportFallback("mobile-import", "open_failed", e instanceof Error ? e.message.slice(0, 60) : "error");
        emitNotice(t("mobileImport.failed"));
        return;
      }
      if (!opened) return; // 저장 실패 관문 — ack 하지 않는다. 사용자가 고르거나 다음 트리거가 다시 시도한다.
      emitNotice(plan.skipped > 0 ? t("mobileImport.filled_skipped", { count: plan.skipped }) : t("mobileImport.filled"));
    } finally {
      claiming.delete(plan.importId);
    }
  };

  useEffect(() => {
    if (!hasImportBridge()) return;
    let busy = false;
    const pull = async () => {
      if (busy) return;
      busy = true;
      try {
        const batch = await pullPendingImport();
        if (!batch) return;
        // 이미 노트가 된 가져오기(사진이 덜 올라가 ack 를 미뤘다). 입력 화면을 새로 열면 중복 노트가 되니 그 노트에 이어 올린다.
        const done = getLedgerEntry(batch.importId);
        if (done) {
          seen.add(batch.importId);
          if (!claiming.has(batch.importId) && sessionRef.current?.importId !== batch.importId) retryImportUploads(done, true);
          return;
        }
        if (seen.has(batch.importId)) {
          // 이미 채웠다. 세션이 이 배치를 쥐고 있지 않으면(끝났는데 ack 가 유실) 다시 ack 만 한다.
          const live = sessionRef.current?.importId === batch.importId || claiming.has(batch.importId) || uploadingInBackground.has(batch.importId);
          if (!live) await ackImport(batch.importId);
          return;
        }
        await runPlan(buildImportPlan(batch), false);
      } catch (e) {
        reportFallback("mobile-import", "pull_error", e instanceof Error ? e.message.slice(0, 60) : "error");
      } finally {
        busy = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void pull();
    };
    const onReady = () => void pull();
    window.addEventListener(IMPORT_READY_EVENT, onReady);
    document.addEventListener("visibilitychange", onVisible);
    void pull();
    return () => {
      window.removeEventListener(IMPORT_READY_EVENT, onReady);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // runPlan/fill 은 ref 만 읽는 클로저라 마운트 1회 등록으로 충분하다(openRef 가 최신 콜백을 가리킨다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** "사진 빼기" — 이미지만 버린다(텍스트 초안과 세션은 그대로). */
  const dropFiles = () => {
    sessionRef.current?.dropFiles();
    setPending(0);
  };

  const doSettle = async (commit: boolean): Promise<ImportSettle> => {
    const s = sessionRef.current;
    if (!s) return "none";
    const store = useNotesStore.getState();
    // 이 정리에서 초안을 노트로 만드는가: 반환값("saved" / "background")만 가른다. 사진은 어느 쪽이든 기다리지 않는다.
    const wasDraft = store.activeDraft;
    if (store.activeDraft) {
      if (!commit) {
        sessionRef.current = null;
        setPending(0);
        setActive(false);
        // newNote() 는 이미 열린 초안이 있으면 아무것도 안 한다(입력 중인 글을 지키려는 규칙) — 버린 초안을 남겨 두면
        // 다음에 입력 화면을 열 때 방금 버린 내용이 되살아난다. 그래서 초안 자체를 치운다.
        store.discardDraft();
        await s.finish();
        return "discarded";
      }
      try {
        await store.ensureMaterialized();
      } catch {
        // call() 이 이미 오류를 알렸다. 초안은 화면에 그대로 있다.
        emitNotice(t("mobileImport.commit_failed"));
        return "stay";
      }
    }
    const noteId = useNotesStore.getState().activeNote?.note.id ?? null;
    if (!noteId || noteId === "__draft__") {
      if (commit) {
        emitNotice(t("mobileImport.commit_failed"));
        return "stay";
      }
      sessionRef.current = null; // 열린 노트가 없다 — 올릴 곳이 없으니 세션만 끝낸다
      setPending(0);
      setActive(false);
      await s.finish();
      return "discarded";
    }
    // 노트가 있다. 사진은 기다리지 않고 올린다(O-2). 초안을 방금 노트로 만들었든 이미 노트였든 같다.
    sessionRef.current = null;
    setPending(0);
    setActive(false);
    uploadInBackground(s, noteId, false);
    return commit && wasDraft ? "saved" : "background";
  };

  /**
   * 입력 화면을 떠나기 전의 정리 — 모든 출구(뒤로·탭·하드웨어 뒤로·노트 열기·다시 가져오기)가 이걸 지난다.
   * @param commit true(평소 나가기) = 초안이면 노트로 만들고 이미지를 올린다. false([그래도 나가기]) = 초안이면 버린다.
   *               노트 만들기가 실패하면 "stay". 사진 업로드는 어느 경우든 기다리지 않는다(실패분은 장부에 남아 노트 화면에서 다시 올린다).
   */
  const settle = (commit: boolean): Promise<ImportSettle> => {
    if (settlingRef.current) return settlingRef.current;
    const p = doSettle(commit).finally(() => {
      settlingRef.current = null;
    });
    settlingRef.current = p;
    return p;
  };

  /**
   * 가져오기 띠의 [버리기](D1) — 아직 초안인 가져온 내용을 노트로 만들지 않고 치운다(이미지도). 입력 화면은 그대로 남고, 비게 된
   * 화면은 MobileApp 의 "열려 있던 노트가 사라짐" 효과가 새 초안으로 채운다. 이미 노트가 됐으면(자동 저장) 아무것도 안 한다 —
   * 그때 버리기는 노트 삭제라 이 띠의 일이 아니다(띠도 [버리기]를 숨긴다).
   */
  const discard = async (): Promise<void> => {
    if (settlingRef.current || !sessionRef.current || !useNotesStore.getState().activeDraft) return;
    await settle(false);
  };

  return { pending, active, settle, discard, dropFiles, hasSession: () => sessionRef.current !== null };
}
