// 온보딩의 비시각 흐름 — 노트북 이름 확정 · 마무리(새 노트 초안 / 저장 위치 이동) · 가져오기 뒤 완료.
// 컴포넌트는 `starting` 같은 화면 상태만 다루고, 스토어·IPC 를 만지는 순서는 여기서만 정한다.
import { useSettingsStore } from "../../stores/settings";
import { useWorkspacesStore } from "../../stores/workspaces";
import { useNotesStore } from "../../stores/notes";
import { runDataMove } from "../../lib/dataMove";

// 첫 실행 시드가 만든 이름들 — 이 이름이면 "사용자가 지은 이름"이 아니므로 그대로 두라는 안내를
// 띄우지 않는다. "Brise" 는 현재 시드(migrations.rs seed), 나머지는 옛 시드명.
export const SEEDED_NOTEBOOK_NAMES = new Set(["Brise", "Histoire de Corée"]);

/**
 * 노트북 이름 칸 기본값(오너 2026-09-29): 시드 이름이면 언어별 재밌는 이름을 제안한다(언어를 바꾸면
 * 제안도 바뀐다). 사용자가 지은 이름이 있으면 그 이름이 기본값이다 — 어느 경로를 타든 조용히 개명되지
 * 않는다(§4). 재밌는 제안은 새로고침(shuffle)을 눌렀을 때만 나타나고, 그때 "지금 이름 그대로 두기"로
 * 돌아올 수 있다.
 */
export function resolveNotebookName(args: {
  ideas: string[];
  ideaIdx: number;
  live: string;
  draft: string | null;
  shuffled: boolean;
}): { notebookName: string; hasOwnName: boolean } {
  const { ideas, ideaIdx, live, draft, shuffled } = args;
  const nameIdea = ideas.length ? ideas[ideaIdx % ideas.length] : live;
  const hasOwnName = !!live && !SEEDED_NOTEBOOK_NAMES.has(live);
  const notebookName = draft ?? (hasOwnName && !shuffled ? live : nameIdea);
  return { notebookName, hasOwnName };
}

// 첫 화면의 노트북 이름은 세 경로 중 무엇을 고르든 그때 확정한다 — 빈 값·변화 없음은 건너뛴다.
// 이름 저장이 실패하면(call() 이 토스트) 경로로 넘어가지 않고 첫 화면에 남는다.
export async function commitNotebookName(rawName: string): Promise<boolean> {
  const w = useWorkspacesStore.getState();
  const activeWs = w.workspaces.find((ws) => ws.id === w.activeId); // = 노트북
  const name = rawName.trim();
  if (!w.activeId || !name || name === activeWs?.name) return true;
  try {
    await useWorkspacesStore.getState().rename(w.activeId, name);
    return true;
  } catch {
    return false;
  }
}

/**
 * 바로 시작하기 / 요약 화면의 마지막 — 기존 새 노트 초안을 성공적으로 연 뒤에만 완료 처리한다(§4).
 * 실패하면 온보딩은 열린 채로 남고 onboarding_completed는 바뀌지 않는다.
 *
 * 데이터 관리 쪽 D4(PLAN §6): 새 저장 위치가 골라져 있으면 노트 초안은 만들지 않는다(어차피
 * 재시작 뒤 사라질 초안이라 저장할 이유가 없다) — onboardingCompleted 를 먼저 참으로 저장해
 * 그 값이 스냅샷에 실려 이동한 뒤(D4), lib/dataMove.ts 의 단일 관문(runDataMove, main 창 전용)
 * 이 복사 + 재시작을 맡는다. 성공하면 Rust 가 프로세스를 재시작하므로 이 아래는 더 돌지 않는다
 * (컴포넌트도 onboardingCompleted 게이트로 이미 언마운트됐다). 실패하면(call() 이 이미 토스트를
 * 띄운다) 완료 플래그는 그대로 두고(노트가 없어도 완료는 이미 확정) pendingDataPath 만 지워
 * 되풀이 재시도를 막은 뒤 — 그래도 사용자가 노트 하나엔 도착하도록 이제야 newNote() 를 연다.
 * 원본 데이터는 손대지 않았으므로 이동은 설정 > 일반의 "위치 변경"(같은 관문)으로 다시 시도할 수 있다.
 *
 * 반환: "restarting" 이면 재시작이 창을 대신하므로 호출자는 로컬 state 를 건드리지 않는다.
 * "settled" 면 어느 갈래로든 끝났으니 호출자가 진행 표시를 내린다.
 */
export async function finishOnboarding(args: {
  pendingDataPath: string | null;
  clearPendingDataPath: () => void;
}): Promise<"restarting" | "settled"> {
  const { pendingDataPath, clearPendingDataPath } = args;

  if (pendingDataPath) {
    const path = pendingDataPath;
    await useSettingsStore.getState().setOnboardingCompleted(true);
    try {
      await runDataMove(path);
      return "restarting"; // 재시작이 이 창을 대신할 것 — 더 이상 로컬 state 를 바꾸지 않는다.
    } catch {
      clearPendingDataPath();
      try {
        await useNotesStore.getState().newNote();
      } catch {
        return "settled";
      }
      return "settled";
    }
  }

  try {
    await useNotesStore.getState().newNote();
  } catch {
    return "settled";
  }
  await useSettingsStore.getState().setOnboardingCompleted(true);
  return "settled";
}

// 가져오기는 실제 가져오기 성공(ImportSourcesPanel의 onImported)에서만 완료 처리한다 — 이미
// 노트가 만들어졌으므로 newNote()로 빈 초안을 더 열지 않는다.
export async function completeAfterImport(): Promise<void> {
  await useSettingsStore.getState().setOnboardingCompleted(true);
}
