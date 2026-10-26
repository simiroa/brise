import { useEffect, useState } from "react";

/**
 * AI 빛줄기(tokens.css AI-GLOW › BEAM) 단계 — 생성 중이면 "active", 끝나면 300ms "fading"(CSS 페이드
 * 시간과 같다) 뒤 해제. `data-ai-glow` 에 그대로 넣는다(ModalShell `aiGlow` 등).
 *
 * 빛줄기는 AI 가 일하는 동안의 신호다 — 상시로 켜지 않는다(오너 2026-09-27). AI 결과 창과 AI 모달이
 * 같이 쓴다. `plugins/pet/ChatComposer.tsx` 도 같은 모양을 제 안에 갖고 있다(펫 청크를 작게 두려는
 * 그쪽 사정이라 여기로 모으지 않았다).
 */
export function useGenerationBeam(generating: boolean): "active" | "fading" | undefined {
  const [beam, setBeam] = useState<"active" | "fading" | undefined>(undefined);
  useEffect(() => {
    if (generating) {
      setBeam("active");
      return;
    }
    setBeam((b) => (b ? "fading" : undefined));
    const timer = setTimeout(() => setBeam(undefined), 300);
    return () => clearTimeout(timer);
  }, [generating]);
  return beam;
}
