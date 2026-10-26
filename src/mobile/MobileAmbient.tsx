import { useEffect, useState } from "react";
import "../styles/mobileAmbient.css";
import { useAiStore } from "../stores/ai";
import { useAiResultGateStore } from "../stores/aiResultGate";
import { useMobileAmbientStore } from "../stores/mobileAmbient";
import { useGenerationBeam } from "../lib/useGenerationBeam";
import { RecEqualizer } from "./RecEqualizer";

/**
 * 폰 화면의 배경 신호 한 장 — AI 가 일하는 동안 가장자리를 도는 빛줄기, 녹음하는 동안 바닥에서 은은하게 출렁이는
 * 따뜻한 이퀄라이저 띠(RecEqualizer). 둘 다 손가락을 가로채지 않고(pointer-events:none) 가운데는 비어 있다.
 *
 * 왜 "배경 뒤"가 아니라 모달 위의 고정 레이어인가: 이 두 신호가 켜지는 거의 모든 순간에 모달이 떠 있다 —
 * 녹음기는 바닥 시트, AI 대기는 MobileAiResultSheet, 입력 화면 AI 시작은 더보기 시트. `.mobile-modal-backdrop`
 * 은 `--overlay`(62%/45%) 스크림이고 시트는 불투명 `.overlay` 라, 화면 뒤에 깔면 스크림 밑에 눌리거나 시트에
 * 가려 안 보인다(데스크톱 AiResultModal 이 같은 이유로 자기 카드에 빛줄기를 둔 것과 같은 교훈). 그래서
 * z-modal 바로 위에 두되 가장자리에만 그린다 — 링 1px + 안쪽 번짐은 AI-GLOW 계약 그대로, 녹음 띠는 화면 높이의
 * 20% 이하 바닥 한 줄이다(시트의 버튼 줄을 바래게 하지 않으려고 얇게·옅게 — 2026-10-07 S22).
 *
 * AI 빛줄기는 데스크톱 계약(tokens.css AI-GLOW › BEAM)을 이 레이어의 호스트 한 곳에 그대로 건다 —
 * `data-ai-glow-beam="true"` 는 항상, `data-ai-glow` 만 useGenerationBeam(active → 300ms fading → 제거)이
 * 켜고 끈다. 둘은 반드시 짝이다: beam 속성 없이 data-ai-glow 만 있으면 INK 규칙이 자손 전부의 글자색을
 * !important 로 덮는다.
 */

/** 녹음 띠 페이드아웃 시간 — mobileAmbient.css 의 `.mobile-rec` opacity 전환과 같아야 한다. */
const REC_FADE_MS = 700;

/**
 * AI 가 지금 일하는가. 데스크톱과 같은 상태를 읽을 뿐 새 플래그를 만들지 않는다:
 *  · 글로우 맵에 "active" 인 키(fading 은 제외 — 세지 않으면 스토어 페이드와 빛줄기 페이드가 두 번 겹친다)
 *  · prompt/cleanup/organize pending — generateFromPrompt 는 활성 노트가 있을 때만 글로우 키를 만든다.
 *    입력 화면의 임시 초안엔 없을 수 있어, AI 시작 프리셋이 키 없이 돌 수 있다.
 *  · 결과 게이트 세션이 pending(MobileAiResultSheet 의 "생성 중"). result/error 는 일이 끝난 뒤라 제외.
 *  · 위 어디에도 안 걸리는 호출만 이 폰 전용 스토어의 aiWork 로 센다(음성 받아쓰기의 audio_transcribe).
 *    채팅 전송은 SidebarChat 의 컴포넌트 지역 상태라 읽을 신호가 없다 — 입력 칸 자체의 빛줄기(ChatComposer)만 켜진다.
 */
export function useAiBusy(): boolean {
  const glowActive = useAiStore((s) => {
    for (const phase of s.aiGlowTargets.values()) if (phase === "active") return true;
    return false;
  });
  const flagPending = useAiStore((s) => s.promptPending || s.cleanupPending || s.organizePending);
  const gatePending = useAiResultGateStore((s) => s.session?.status === "pending");
  const outsideWork = useMobileAmbientStore((s) => s.aiWork > 0);
  return glowActive || flagPending || gatePending || outsideWork;
}

type RecShown = "on" | "paused" | "fading" | null;

/** 녹음 스토어 → 레이어에 그리는 단계. 꺼지면 REC_FADE_MS 동안 "fading" 으로 남겼다가 언마운트한다. */
function useRecShown(): RecShown {
  const rec = useMobileAmbientStore((s) => s.rec);
  const [shown, setShown] = useState<RecShown>(null);
  useEffect(() => {
    if (rec !== "off") {
      setShown(rec);
      return;
    }
    setShown((s) => (s ? "fading" : null));
    const timer = setTimeout(() => setShown(null), REC_FADE_MS);
    return () => clearTimeout(timer);
  }, [rec]);
  return shown;
}

export function MobileAmbient() {
  const beam = useGenerationBeam(useAiBusy());
  const rec = useRecShown();
  return (
    <div className="mobile-ambient" aria-hidden="true" data-testid="mobile-ambient" data-ai={beam ? "on" : undefined}>
      <div className="mobile-ambient-beam" data-testid="mobile-ambient-beam" data-ai-glow-beam="true" data-ai-glow={beam} />
      {rec && (
        <div className="mobile-rec" data-testid="mobile-rec" data-rec={rec}>
          <RecEqualizer frozen={rec === "paused"} />
        </div>
      )}
    </div>
  );
}
