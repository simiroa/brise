import { useEffect } from "react";
import { ModalShell } from "./ModalShell";
import { t } from "../i18n/t";
import {
  useAiResultGateStore,
  registerAiResultGateHost,
  installAiResultGateUnloadGuard,
  installAiResultGateFlushGuard,
} from "../stores/aiResultGate";
import { useGenerationBeam } from "../lib/useGenerationBeam";
import { AiResultPanel, finalizeGateDecision } from "./ai/AiResultPanel";

/**
 * 독립 AI 결과 창 — AI 메뉴·어시스트·관계도 버튼 등 AI 모달을 거치지 않은 실행의 게이트 호스트.
 * 몸통(대기/결과/오류와 행동 줄)은 `ai/AiResultPanel.tsx` 가 소유한다(2026-09-27 에 여기서 떼어 냄 —
 * AI 모달도 같은 패널을 제 안에 그린다). AI 모달이 연 세션(`session.embedded`)은 여기서 그리지 않는다.
 */
export function AiResultModal() {
  const session = useAiResultGateStore((s) => s.session);

  // 이 컴포넌트가 살아 있는 동안만 runWithAiResultGate가 게이트를 건다 — GlobalModalsHost가
  // 마운트되지 않는 트리(현재는 MobileApp)에서는 이 effect 자체가 안 돌아서 자동으로 우회된다.
  // WG(2026-09-06) G1 — 같은 마운트 수명에 창 닫기/새로고침 가드도 함께 배선한다(창이 열려
  // 있는 동안만 의미가 있는 정리이므로 별도 mount point를 만들지 않는다). K1 — Tauri 창 닫기
  // (`flushAll` 경유, 새 권한 없음)도 같은 자리에 얹는다. 가드는 AI 모달 안의 세션도 치운다.
  useEffect(() => {
    const unregisterHost = registerAiResultGateHost();
    const uninstallUnloadGuard = installAiResultGateUnloadGuard();
    const uninstallFlushGuard = installAiResultGateFlushGuard();
    return () => {
      uninstallFlushGuard();
      uninstallUnloadGuard();
      unregisterHost();
    };
  }, []);

  // AI 빛줄기(ModalShell aiGlow) — 생성 중에만 돈다. 에디터 빛줄기는 이 창의 스크림 뒤에 가려지므로
  // 보고 있는 이 창이 대신 든다. 훅이라 아래 조기 반환보다 위에 있어야 한다.
  const beam = useGenerationBeam(session?.status === "pending" && !session.embedded);

  if (!session || session.embedded) return null;

  const modalTitle = session.noteTitle
    ? t("aiResult.modal_title", { action: session.title, note: session.noteTitle })
    : t("aiResult.modal_title_untitled", { action: session.title });

  return (
    // 창을 닫는 것(X·Esc·스크림) = [버리기]. 대기 중이면 decide() 가 호출 취소까지 쏜다.
    <ModalShell title={modalTitle} onClose={() => finalizeGateDecision("discard")} width={640} aiGlow={beam}>
      <AiResultPanel session={session} />
    </ModalShell>
  );
}
