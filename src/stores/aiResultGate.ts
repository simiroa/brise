import { create } from "zustand";
import { t } from "../i18n/t";
import { callSilent, emitNotice, registerFlush } from "../lib/invoke";
import type { AiCallsActiveOutput, AiCancelCallOutput } from "../lib/commands.gen";
import { useSettingsStore } from "./settings";
import { uniqueId } from "../lib/ids";
import { isExternalProvider } from "../components/settings/shared";

/**
 * PLAN-2026-09-05 §2 (트랙 B) — 어시스트 AI 실행 가드.
 *
 * 단일 전역 게이트: `runAiAction`/`AskAiModal`이 노트를 실제로 바꾸기(새 섹션 삽입 ·
 * `replaceSection`) **직전에** 이 모듈을 거친다. `AiResultModal.tsx`가 이 스토어를 구독해
 * 대기/결과/실패 3상태를 그린다 — `AiConfirmModal` 과 같은 자세(스토어에 상태가 있으면
 * 모달이 뜨고, 없으면 null)다.
 *
 * 왜 Promise 인데 "재시도"가 있는가: `waitDecision()`은 호출할 때마다 새 결정을 기다리는
 * 새 Promise를 연다. `runWithAiResultGate`가 생성 → 결과 표시 → decide 대기를 한 세션 안에서
 * 반복해서, "다시 생성"이 같은 모달을 대기 상태로 되돌리고 같은 target/kind로 이어간다(계획
 * §2 B-2 "같은 게이트 세션 안에서 다시 대기 상태로 돌아가 재호출").
 *
 * WB(2026-09-05) — B1: [중단]의 취소를 "시각 추정"에서 "request_id 정확 취소"로 바꿨다. 게이트
 * 세션(및 각 "다시 생성" 시도)마다 `uniqueId()`로 request_id를 하나 만들어 `generate`
 * 콜백에 넘긴다 — 관계도 자동 수리 루프(최대 3회) 안의 내부 재시도들은 "다시 생성" 클릭이
 * 아니라 같은 생성 시도의 일부이므로 같은 request_id를 공유한다. [중단]은 그 request_id 하나로
 * `ai_cancel_call({ request_id })`를 쏘고, 응답의 `count`로 실제로 뭔가를 멈췄는지 안다 —
 * 예전의 "ai_calls_active를 시각으로 훑어 그럴듯한 후보를 모으는" 추정 방식(trackedCallIds)은
 * 삭제했다.
 */

export type AiResultGateKind = "text" | "diagram" | "sheet";
export type AiResultGateDecision = "insert" | "discard" | "retry";

export interface AiResultGateSession {
  id: number;
  /** 액션 라벨. 예: "요약", "관계도 수정하기". */
  title: string;
  /** 이 결과가 방금 생성된 노트/섹션 제목(있으면). 모달 헤더의 `— "…"` 부분. */
  noteTitle?: string;
  /** "새 섹션으로 삽입 예정" 류 — §2 B-2 문구. */
  target: string;
  kind: AiResultGateKind;
  /** 이 생성 시도(재시도 포함 각 회차)의 취소 키. `ai_generate_from_prompt` 등의 커맨드 입력과
   * `ai_cancel_call({ request_id })`가 이 값으로 맞물린다. */
  requestId: string;
  provider?: string;
  model?: string;
  status: "pending" | "result" | "error";
  startedAt: number;
  attempt: number;
  maxAttempts?: number;
  resultText?: string;
  errorText?: string;
  durationMs?: number;
  /** AI 모달(AskAiModal)이 자기 안에 그리는 세션 — 열릴 때 AI 모달이 호스트로 떠 있었으면 true.
   *  AiResultModal 은 이런 세션을 그리지 않는다(한 모달에서 작성→생성→검토, 2026-09-27). */
  embedded?: boolean;
  /** 결과의 원본 값(apply 에 넘기는 그것) — AI 모달의 버전 비교가 예전 결과를 생성 없이 다시 삽입할 때 쓴다. */
  resultRaw?: unknown;
}

interface AiResultGateState {
  session: AiResultGateSession | null;
  /** 모달의 버튼이 부르는 유일한 진입점. 대기 중이면 "discard"만 의미가 있다([중단]). */
  decide: (decision: AiResultGateDecision) => void;
}

// ponytail: 한 번에 게이트 세션은 전역 1개뿐이라(§2 B-6 "전역 1개") resolver를 zustand 상태가
// 아니라 모듈 스코프에 둔다 — 함수를 상태에 넣고 매번 새 참조로 set() 하는 것보다 단순하고,
// 리렌더 셀렉터가 함수 동등성을 신경 쓸 필요가 없다. 세션이 동시에 여러 개 필요해지면(현재
// 요구 없음) resolver를 세션 id로 색인하는 Map으로 승격한다.
let pendingResolve: ((decision: AiResultGateDecision) => void) | null = null;
let sessionSeq = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** WE(2026-09-05) E4 — [중단] 경로(decide())와 "세션 교체로 이전 pending 세션을 discard 하는" 경로
 * (openAiResultGate) 둘 다 같은 request_id 취소를 쏜다. 결과는 여기서 무시(catch로 undefined)하고
 * 실패 시 반응(안내 문구를 낼지 말지)은 호출부가 각자 결정한다 — CLAUDE.md 함정 8의 허용된 형태:
 * 토스트가 필요 없는 실패 경로라 callSilent(...).catch(...). */
function dispatchAiCancelCall(requestId: string): Promise<AiCancelCallOutput | undefined> {
  return callSilent<AiCancelCallOutput>("ai_cancel_call", { request_id: requestId }).catch(() => undefined);
}

/** WE(2026-09-05) E2 — 게이트를 열기 전에 "무조건 실패할 게 뻔한" 경우를 걸러 즉시 안내한다.
 * privacy_gate_ok(invariant_ai_privacy_gate.rs)가 어차피 백엔드에서 막지만, 그때는 이미 "생성
 * 중" 화면이 뜬 뒤라 사용자에게는 "돌다가 조용히 실패"로 보인다. API 키 존재 여부는 프런트
 * 스토어에 없다 — ponytail: 여기서 추가 조회를 만들지 않는다, 키 누락은 실제 호출이 나간 뒤
 * classifyAiError(no_key)가 잡아준다(업그레이드 경로: 키 존재를 커맨드로 노출하면 여기서도 선판정
 * 가능). Ollama 로컬은 aiEnabled 없이도 허용되므로(§1 불변식 4) 대상이 아니다 — 연결 실패는
 * classifyAiError(unreachable)이 받는다. */
async function isBlockedByDisabledExternalProvider(): Promise<boolean> {
  if (useSettingsStore.getState().aiEnabled) return false;
  try {
    const res = await callSilent<{ settings: Record<string, unknown> }>("settings_get_all");
    const provider = (res?.settings?.ai_provider as string) || "ollama";
    return isExternalProvider(provider);
  } catch {
    return false; // 조회 실패 시 차단하지 않음 — 실제 호출이 진짜 결과를 알려준다
  }
}

// K2(2026-09-06) — 첫 노출 안내는 `useFeatureBriefTrigger`(src/lib/useFeatureBrief.ts)를 쓰지
// 않는다: 그 훅은 "설정 토글이 OFF→ON 되는 순간"에만 반응하는 계약인데, 이 게이트 모달은 그런
// 토글 전환이 아니라 "AI 액션을 실행할 때마다" 열린다(대상 토글이 없다). 대신 `AiResultModal.tsx`가
// `seenFeatureBriefs` 배열에 직접 `"ai_result_gate"` sentinel을 심는다(useFeatureBrief.ts의 시딩
// 관례와 같은 자리, 별도 설정 키 없음) — 모듈 관문은 이 스토어가 아니라 그 컴포넌트 쪽에 둔다.

// PLAN-2026-09-05 §5 경계 — 트랙 B는 모바일 범위 밖(감사 리포트 W8)이다. MobileApp 트리
// (src/mobile/MobileApp.tsx)는 GlobalModalsHost를 렌더하지 않으므로 AiResultModal이 마운트되지
// 않는다 — 게이트를 걸면 decide()를 부를 사람이 없어 runAiAction이 영원히 멈춘다(실측:
// MobileNote.test.tsx의 diagram_edit이 이 상태로 멈췄다). 뷰포트 폭으로 "모바일인가"를 추측하는
// 대신, 이 코드베이스의 기존 관용구(registerActiveSectionGetter 류 pub-sub)를 그대로 써서 모달이
// 실제로 마운트돼 있는지를 직접 안다 — AiResultModal이 mount 시 등록하고 unmount 시 해제한다.
let gateHostMounted = false;

/** AiResultModal이 mount/unmount 시 부른다. 반환값은 해제 함수(등록 패턴과 동일 모양). */
export function registerAiResultGateHost(): () => void {
  gateHostMounted = true;
  return () => {
    gateHostMounted = false;
  };
}

// AI 모달이 두 번째 호스트다(2026-09-27 — 작성·생성·검토를 한 모달에서). 위 불리언을 같이 쓰지 않는
// 이유: AI 모달이 닫히며 false 로 내리면 AiResultModal 이 떠 있는데도 AI 메뉴·어시스트·관계도 버튼이
// 검토 없이 곧장 적용된다. 그래서 따로 센다 — 호스트 판정은 "둘 중 하나라도".
let embeddedHosts = 0;

/** AskAiModal 이 마운트 동안 부른다. 이 사이에 열린 세션은 `embedded` 로 표시돼 AI 모달 안에 그려진다
 *  (그동안 나머지 화면은 inert 라 다른 곳에서 게이트를 열 수 없다). */
export function registerEmbeddedGateHost(): () => void {
  embeddedHosts += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    embeddedHosts -= 1;
  };
}

export const useAiResultGateStore = create<AiResultGateState>(() => ({
  session: null,
  decide: (decision) => {
    // [중단]이 대기 상태에서 눌렸을 때만 취소를 쏜다 — 결과/실패 화면의 "버리기"/"닫기"는 이미
    // 끝난 호출이라 취소할 게 없다(call_log 에도 이미 outcome 이 찍혀 있다).
    const session = useAiResultGateStore.getState().session;
    if (decision === "discard" && session?.status === "pending") {
      // dispatchAiCancelCall 이 이미 실패를 undefined 로 삼킨다 — 여기서는 count 유무로 안내
      // 문구만 고른다(성공/실패 모두 .then 한 번으로).
      void dispatchAiCancelCall(session.requestId).then((res) => {
        emitNotice((res?.count ?? 0) > 0 ? t("aiResult.abort_cancelled_notice") : t("aiResult.abort_notice"));
      });
    }
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve?.(decision);
  },
}));

/** WG(2026-09-06) G1 — 창 닫기·새로고침 중 pending 세션 정리. pending인 채로 페이지가 닫히면
 * 백엔드 호출은 45s까지 계속 돌지만(§1 불변식 1의 상한), call_log엔 결국 `ok`로 남아 삽입은
 * 안 됐는데 마치 조용히 성공한 것처럼 보인다 — 열려 있던 요청을 여기서 취소해 로그에도
 * cancelled로 남긴다.
 *
 * `pagehide`를 쓴다(`beforeunload` 대신): 둘 다 Tauri 권한이 필요 없는 순수 DOM 이벤트라 이
 * 함수만으로 배선되지만, `beforeunload`는 리스너가 있다는 사실만으로 브라우저가 "정말
 * 나가시겠습니까" 확인 다이얼로그를 붙일 수 있고 WebView2에서 억제가 들쭉날쭉하다고 보고된
 * 반면, `pagehide`는 그런 부작용 없이 탭 닫힘·새로고침·앱 종료(윈도우 close) 모두에서 안정적으로
 * 발화한다.
 *
 * 세션이 pending이면 그 request_id로 취소를 쏘고(fire-and-forget — 페이지가 죽기 전에 응답이
 * 오리라는 보장이 없다), 세션이 뭐든 있으면 즉시 비운다. `openAiResultGate`가 이전 세션을
 * 교체할 때 쓰는 것과 같은 자세 — `pendingResolve`를 "discard"로 풀어준 뒤(이 핸들러 이후에도
 * 페이지가 살아남는 bfcache 같은 극단 상황에서 `runWithAiResultGate` 호출자가 영영 멈추지
 * 않도록) 폴링을 멈추고 세션을 null로 되돌린다.
 *
 * ponytail: 강제 종료(taskkill/전원 차단)는 어떤 브라우저 이벤트로도 못 잡는다 — 그 경우엔
 * 백엔드 45s 데드라인이 상한이다(§1 불변식 1).
 */
function clearSessionOnTeardown(): Promise<AiCancelCallOutput | undefined> | undefined {
  const session = useAiResultGateStore.getState().session;
  if (!session) return undefined;
  const cancelPromise = session.status === "pending" ? dispatchAiCancelCall(session.requestId) : undefined;
  pendingResolve?.("discard");
  pendingResolve = null;
  stopPolling();
  useAiResultGateStore.setState({ session: null });
  return cancelPromise;
}

export function installAiResultGateUnloadGuard(): () => void {
  // fire-and-forget — 페이지가 죽기 전에 취소 응답이 오리라는 보장이 없다.
  const handler = () => void clearSessionOnTeardown();
  window.addEventListener("pagehide", handler);
  return () => window.removeEventListener("pagehide", handler);
}

/** K1(2026-09-06) — Tauri 창 닫기(`onCloseRequested`)는 새 `core:window:allow-*` 권한 없이
 * 이미 존재하는 `flushAll()`(`lib/invoke.ts`)을 부른다 — 그 훅에 `registerFlush`로 얹기만 하면
 * "닫기 확정 전에 pending 세션을 취소"가 된다. `pagehide`(브라우저 탭/새로고침)와 달리 이 경로는
 * `flushAll()`이 각 콜백을 `await`하므로 취소 디스패치가 실제로 나갈 시간을 번다 — 그래서
 * fire-and-forget이 아니라 await한다. 같은 정리 로직(`clearSessionOnTeardown`)을 공유한다. */
export function installAiResultGateFlushGuard(): () => void {
  return registerFlush(async (reason) => {
    // 창이 실제로 닫힐 때만. flushAll 은 주기 스냅샷(lib/noteSnapshots.ts)·노트/섹션 전환에서도 불리는데,
    // 예전엔 그때마다 생성 중이거나 검토 중인 결과를 조용히 지웠다(2026-09-27 실측 — AI 모달에서 결과를
    // 기다리던 중 스냅샷 타이머가 세션을 치워 작성 단계로 튕겼다. 독립 결과 창도 같은 식으로 사라졌다).
    if (reason !== "close") return;
    await clearSessionOnTeardown();
  });
}

export interface AiResultGateHandle {
  setProgress(attempt: number, maxAttempts: number): void;
  setResult(text: string, meta?: { durationMs?: number; raw?: unknown }): void;
  setError(message: string): void;
  /** 재시도 시작 — 대기 상태로 되돌리고(새 시작 시각, 이전 결과/에러 제거) 새 request_id를 뽑는다. */
  setPending(): void;
  /** 이 세션의 "지금" 생성 시도가 커맨드에 실어 보낼 request_id. setPending() 직후에는 새 값을
   * 즉시 반영한다(patchSession이 동기다). */
  requestId(): string;
  /** 이 세션의 다음 decide() 호출을 기다리는 새 Promise. 대기 중 [중단]도 이걸 통해 들어온다. */
  waitDecision(): Promise<AiResultGateDecision>;
  close(): void;
}

function patchSession(id: number, fn: (s: AiResultGateSession) => AiResultGateSession) {
  const current = useAiResultGateStore.getState().session;
  if (!current || current.id !== id) return; // 다른 세션으로 대체됐거나 이미 닫힘
  useAiResultGateStore.setState({ session: fn(current) });
}

/** ai_calls_active를 한 번 조회해 이 게이트 세션의 "지금" request_id와 일치하는 in-flight 호출을
 * 찾아 provider/model 표시를 그 실데이터로 갱신한다. 실패해도 세션은 그대로 진행된다 — 표시용
 * 부가 정보일 뿐 생성·적용·취소 경로에는 영향이 없다(취소는 request_id 자체로 하지 이 폴링
 * 결과에 기대지 않는다). */
function pollActiveCalls(sessionId: number) {
  void (async () => {
    try {
      const session = useAiResultGateStore.getState().session;
      if (!session || session.id !== sessionId) return;
      const res = await callSilent<AiCallsActiveOutput>("ai_calls_active");
      const items = res?.items ?? [];
      const match = items.find((item) => item.request_id === session.requestId);
      if (match) {
        patchSession(sessionId, (s) => ({
          ...s,
          provider: match.provider || s.provider,
          model: match.model || s.model,
        }));
      }
    } catch {
      /* 폴링 실패는 세션 진행에 영향 없음 — 다음 tick에 다시 시도 */
    }
  })();
}

export function openAiResultGate(opts: {
  title: string;
  target: string;
  kind: AiResultGateKind;
  noteTitle?: string;
}): AiResultGateHandle {
  const id = ++sessionSeq;
  // 이전 세션이 아직 결정을 기다리고 있으면(빠른 연속 클릭) 그 호출자를 영원히 멈춰 두지 않고
  // "discard"로 풀어 준다 — 전역 1세션 계약의 짝.
  const previousSession = useAiResultGateStore.getState().session;
  pendingResolve?.("discard");
  pendingResolve = null;
  stopPolling();
  // WE(2026-09-05) E4 — 이전 세션이 아직 생성 중이었다면(pending) 그 실제 호출도 함께 취소한다.
  // 이미 result/error 로 넘어간 세션은 호출이 끝나 있으므로(call_log 에도 이미 outcome 이
  // 찍혀 있다) 취소할 게 없다 — [중단] 경로(decide())와 동일한 조건.
  if (previousSession?.status === "pending" && previousSession.requestId) {
    void dispatchAiCancelCall(previousSession.requestId);
  }
  const startedAt = Date.now();
  useAiResultGateStore.setState({
    session: {
      id,
      title: opts.title,
      noteTitle: opts.noteTitle,
      target: opts.target,
      kind: opts.kind,
      status: "pending",
      startedAt,
      attempt: 1,
      requestId: uniqueId(),
      embedded: embeddedHosts > 0,
    },
  });

  // provider/model은 ai_calls_active 폴링(1초 간격)이 실데이터로 채운다 — 그게 이 세션이 실제
  // 부른 provider/model(폴백이 쓰였으면 그 모델까지) 이다. settings_get_all은 폴링이 아직 첫
  // 값을 못 준 사이의 폴백일 뿐이다: 이미 provider/model이 채워져 있으면 덮어쓰지 않는다(패치
  // 함수 안에서 확인). await(.then 아님)를 쓰는 이유: 테스트 목처럼 callSilent가 Promise 가
  // 아닌 값을 돌려줘도(콜 목 기본 undefined) await 는 그대로 통과시키지만 `.then`은 그 자리에서
  // 동기 TypeError를 던진다 — 그 예외가 openAiResultGate(동기 함수) 밖으로 새면 방금 연 게이트째로
  // 세션이 "pending"에 멈춘다.
  void (async () => {
    try {
      const res = await callSilent<{ settings: Record<string, unknown> }>("settings_get_all");
      patchSession(id, (s) =>
        s.provider || s.model
          ? s
          : {
              ...s,
              provider: (res?.settings?.ai_provider as string) || undefined,
              model: (res?.settings?.ai_model as string) || undefined,
            },
      );
    } catch {
      /* 표시용 부가 정보일 뿐 — 실패해도 게이트 진행에는 영향 없음 */
    }
  })();
  pollActiveCalls(id);
  pollTimer = setInterval(() => pollActiveCalls(id), 1000);

  return {
    setProgress(attempt, maxAttempts) {
      patchSession(id, (s) => ({ ...s, attempt, maxAttempts }));
    },
    setResult(text, meta) {
      patchSession(id, (s) => ({
        ...s,
        status: "result",
        resultText: text,
        durationMs: meta?.durationMs,
        resultRaw: meta?.raw,
      }));
    },
    setError(message) {
      patchSession(id, (s) => ({ ...s, status: "error", errorText: message }));
    },
    setPending() {
      patchSession(id, (s) => ({
        ...s,
        status: "pending",
        startedAt: Date.now(),
        attempt: 1,
        maxAttempts: undefined,
        resultText: undefined,
        errorText: undefined,
        requestId: uniqueId(),
      }));
    },
    requestId() {
      const current = useAiResultGateStore.getState().session;
      return current && current.id === id ? current.requestId : "";
    },
    waitDecision() {
      return new Promise<AiResultGateDecision>((resolve) => {
        pendingResolve = resolve;
      });
    },
    close() {
      // 자기 세션일 때만 치운다. 예전엔 대기자·폴링을 무조건 지웠는데, AI 모달의 "고쳐서 다시"는
      // 새 세션이 열리고 그 실행기가 결정을 기다리기 시작한 **뒤에** 옛 실행기의 finally 가 close() 를
      // 부른다 — 그러면 새 세션의 대기자가 지워져 [삽입]·[버리기]가 허공에 떨어지고 흐름이 멈춘다.
      const current = useAiResultGateStore.getState().session;
      if (current?.id !== id) return;
      useAiResultGateStore.setState({ session: null });
      pendingResolve = null;
      stopPolling();
    },
  };
}

/** §2 B-2 표. 이 문구는 [중단]을 "취소했습니다"라고 거짓말하지 않는다 — 백엔드는 계속 돈다. */
export const aiResultTarget = {
  insertNewSection: () => t("aiResult.target_insert"),
  replaceDiagram: () => t("aiResult.target_replace_diagram"),
  replaceSheet: () => t("aiResult.target_replace_sheet"),
  replaceSelection: () => t("aiResult.target_replace_selection"),
  replaceSection: () => t("aiResult.target_replace_section"),
  newNote: () => t("aiResult.target_new_note"),
};

export interface AiGenerateOutcome<T> {
  ok: boolean;
  /** 사람이 읽는 프리뷰(성공 시). */
  preview?: string;
  /** 성공 시 apply()로 넘길 원본 값(디코드 없이 그대로). */
  raw?: T;
  /** 실패 시 마스킹된 사용자 대면 메시지. */
  error?: string;
}

/** WE(2026-09-05) E3 — 빈 결과는 삽입하지 않는다. 문자열 결과(text/diagram/sheet JSON 원문)만
 * 판정한다 — JSON 파싱 후 "빈 객체/빈 노드"까지는 여기서 안 본다(그건 각 apply()가 이미 알고
 * 있는 도메인 판단이고, 여기는 "빈 문자열"이라는 값 자체만 본다). */
function isEmptyStringResult(raw: unknown): boolean {
  return typeof raw === "string" && raw.trim() === "";
}

/**
 * 어시스트 액션 하나(생성 → 프리뷰 → 사람 결정 → 적용)를 감싼다. `runAiAction.ts`의 6개 실행
 * 분기와 `AskAiModal.tsx`의 선택영역/프롬프트박스 경로가 공유하는 단일 관문(§2 B-5 "관문은
 * 하나만 만든다") — 두 파일 모두 insert()/replaceSection() 호출부에서 직접 이 함수를 부른다.
 *
 * `generate`는 이번 시도(최초 호출 또는 "다시 생성")의 request_id를 첫 인자로 받는다 — 관계도
 * 자동 수리 루프처럼 한 시도 안에서 여러 번 커맨드를 부르는 경우도 전부 같은 request_id를 써서
 * [중단]이 그 시도 전체를 `ai_cancel_call({ request_id })` 하나로 취소할 수 있게 한다.
 *
 * `ai_confirm_before_apply` 설정이 꺼져 있으면 게이트 없이 즉시 generate → apply.
 */
export async function runWithAiResultGate<T>(
  ctx: {
    title: string;
    target: string;
    kind: AiResultGateKind;
    noteTitle?: string;
    /** 원본을 제자리에서 덮어쓰는 경로(replaceSection·선택영역 교체). AUDIT-2026-09-05-ai-guard-friction
     *  §2-7: 이 경로는 undo 가 없어 `ai_confirm_before_apply` 를 꺼도 게이트를 유지한다(docs/AI.md §1 불변식 1). */
    replacesExisting?: boolean;
    /** 사람이 이미 검토한 결과를 다시 적용한다(AI 모달의 이전 버전 삽입) — 게이트를 열지 않는다. 제자리
     *  교체라도 같다: 검토는 이미 그 결과를 보고 [삽입]을 누른 것으로 끝났다. generate 는 캐시를 돌려준다. */
    reviewed?: boolean;
  },
  generate: (
    requestId: string,
    onAttempt?: (attempt: number, maxAttempts: number) => void,
  ) => Promise<AiGenerateOutcome<T>>,
  // `void` (the common case) counts as "applied". `apply` returns `false` only when it decided,
  // on its own, not to write anything (§2 B-2 staleness re-check via runAiAction.ts's
  // applyIfFresh) — runWithAiResultGate then reports that honestly instead of claiming success.
  apply: (raw: T) => Promise<void | boolean>,
): Promise<boolean> {
  // WE(2026-09-05) E2 — 무조건 실패할 경우(외부 프로바이더인데 AI가 꺼져 있음)는 게이트조차
  // 열지 않는다. bypass 경로(아래)와 게이트 경로 둘 다에 적용되도록 진입부 최상단에서 본다.
  if (await isBlockedByDisabledExternalProvider()) {
    emitNotice(t("aiResult.preflight_ai_disabled_notice"));
    // AI 켜기 스위치가 있는 AI 연결 페이지로(2026-09-27 딥링크 — 안내문 "설정 → AI 에서 켜주세요"와 같은 곳).
    void callSilent("settings_window_open", { page: "ai" }).catch(() => {});
    return false;
  }

  // ponytail: 모달을 받아줄 host가 없으면(모바일 — 위 gateHostMounted 주석) 게이트를 걸어봐야
  // 아무도 decide()를 못 부른다. 업그레이드 경로: 모바일에 자체 결과 시트가 생기면 거기서도
  // registerAiResultGateHost()를 부르면 되고, 이 우회 조건은 자연히 없어진다.
  // 킬 스위치는 "새 섹션 삽입"만 건너뛴다 — 제자리 교체는 되돌릴 수 없어 항상 사람 손을 거친다.
  const gateOff = (!useSettingsStore.getState().aiConfirmBeforeApply && !ctx.replacesExisting) || !!ctx.reviewed;
  if (gateOff || !(gateHostMounted || embeddedHosts > 0)) {
    const res = await generate(uniqueId());
    if (!res.ok || res.raw === undefined || isEmptyStringResult(res.raw)) return false;
    return (await apply(res.raw)) !== false;
  }

  const gate = openAiResultGate(ctx);
  try {
    let genPromise = generate(gate.requestId(), (attempt, maxAttempts) => gate.setProgress(attempt, maxAttempts));
    for (;;) {
      const decisionPromise = gate.waitDecision();
      const startedAt = Date.now();
      const settled = genPromise.then((res) => {
        if (res.ok) gate.setResult(res.preview ?? "", { durationMs: Date.now() - startedAt, raw: res.raw });
        else gate.setError(res.error ?? t("aiResult.unknown_error"));
        return res;
      });

      // 대기 중 [중단]과 생성 완료 중 먼저 오는 쪽을 본다 — 대기 화면에서 버튼은 [중단]뿐이라
      // 여기서 decisionPromise가 먼저 풀리면 그건 언제나 "discard"다.
      const race = await Promise.race([
        decisionPromise.then((d) => ({ kind: "decision" as const, d })),
        settled.then((r) => ({ kind: "gen" as const, r })),
      ]);
      if (race.kind === "decision") return false;

      const outcome = race.r;
      const decision = await decisionPromise;
      if (decision === "discard") return false;
      if (decision === "retry") {
        gate.setPending();
        genPromise = generate(gate.requestId(), (attempt, maxAttempts) => gate.setProgress(attempt, maxAttempts));
        continue;
      }
      // insert
      if (!outcome.ok || outcome.raw === undefined || isEmptyStringResult(outcome.raw)) return false;
      return (await apply(outcome.raw)) !== false;
    }
  } finally {
    gate.close();
  }
}

