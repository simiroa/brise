import { useState } from "react";
import { ModalShell } from "../ModalShell";
import { t } from "../../i18n/t";
import { useFeatureBriefStore } from "../../stores/featureBrief";
import { getFeatureBrief } from "../../lib/featureBriefs";

/**
 * 기능 온보딩 브리핑 모달 (docs/PLAN-2026-08-30-ai-surface-and-clients.md §4 W7).
 *
 * AI 전용이 아니라 범용이다 — "처음 켜는 기능"이면 무엇이든(AI 마스터·후처리·링크 제안·챗
 * 메모리·동기화 서버·캡처 채널) 같은 모양으로 보여준다. ModalShell 위에 얹기만 한다 — 포커스
 * 트랩·ESC·바깥 클릭 닫기는 전부 그쪽 소유.
 *
 * 두 모드, 문구는 공유(lib/featureBriefs.ts 의 같은 titleKey/bodyKey를 읽는다 — 온보딩과 도움말이
 * 어긋나는 건 이 종류 기능의 전형적 부채다):
 *   - onboarding: 토글 OFF→ON 트리거(useFeatureBrief.ts). 액션 = [알겠습니다](주) +
 *     [사용법 자세히보기](부, learnMoreKey 있을 때만 — 외부 링크가 아니라 인라인 확장) + 외부 링크.
 *   - read: 카탈로그 "자세히 ▸"(AiCapabilityCatalog.tsx). 액션 = [닫기]만.
 *
 * 단일 마운트 지점은 SettingsPanel.tsx — useFeatureBriefStore.activeId 가 null 이면 아무 것도
 * 그리지 않는다(이 컴포넌트 자신은 언제 열릴지 모른다, 스토어가 유일한 진실).
 */
export function FeatureBriefModal() {
  const activeId = useFeatureBriefStore((s) => s.activeId);
  const mode = useFeatureBriefStore((s) => s.mode);
  const close = useFeatureBriefStore((s) => s.close);
  const [learnMoreOpen, setLearnMoreOpen] = useState(false);

  const brief = activeId ? getFeatureBrief(activeId) : undefined;

  if (!brief) return null;

  const handleClose = () => {
    setLearnMoreOpen(false);
    close();
  };

  const openExternal = async (url: string) => {
    // 앱 내 웹뷰로 열지 않는다 — 브라우저에(SyncSection.tsx 의 Tailscale 다운로드 링크와 같은
    // opener 패턴: 데스크톱에선 plugin-opener, 실패하거나 브라우저(웹 클라이언트) 모드면 폴백).
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  };

  const title = t(brief.titleKey);
  const body = t(brief.bodyKey);
  const isCaution = brief.tone === "caution";

  const footer = (
    <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
      {mode === "onboarding" && brief.learnMoreKey && (
        <button
          type="button"
          className="btn"
          data-testid="feature-brief-learn-more"
          onClick={() => setLearnMoreOpen((v) => !v)}
        >
          {t("featureBriefs.learn_more_button")}
        </button>
      )}
      {mode === "onboarding" ? (
        <button type="button" className="btn btn-primary" data-testid="feature-brief-ack" onClick={handleClose}>
          {t("featureBriefs.ack_button")}
        </button>
      ) : (
        <button type="button" className="btn" data-testid="feature-brief-close" onClick={handleClose}>
          {t("common.close")}
        </button>
      )}
    </div>
  );

  return (
    <ModalShell title={title} onClose={handleClose} width={480} footer={footer}>
      <div
        data-testid={`feature-brief-modal-${brief.id}`}
        data-feature-brief-mode={mode}
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
      >
        {isCaution && (
          <div className="label-caps" style={{ color: "var(--danger-soft)" }}>
            {t("featureBriefs.caution_badge")}
          </div>
        )}

        <p style={{ margin: 0, fontSize: "var(--text-md)", lineHeight: 1.6, whiteSpace: "pre-line" }}>{body}</p>

        {learnMoreOpen && brief.learnMoreKey && (
          <p
            data-testid="feature-brief-learn-more-body"
            style={{
              margin: 0,
              fontSize: "var(--text-sm)",
              color: "var(--muted)",
              lineHeight: 1.55,
              whiteSpace: "pre-line",
              paddingTop: "var(--space-2)",
              borderTop: "1px solid var(--line)",
            }}
          >
            {t(brief.learnMoreKey)}
          </p>
        )}

        {brief.externalLinks && brief.externalLinks.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", paddingTop: "var(--space-2)" }}>
            {brief.externalLinks.map((link, i) => (
              <button
                key={link.url}
                type="button"
                data-testid={`feature-brief-external-link-${i}`}
                onClick={() => void openExternal(link.url)}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  textAlign: "left",
                  color: "var(--accent)",
                  cursor: "pointer",
                  fontSize: "var(--text-sm)",
                  textDecoration: "underline",
                  width: "fit-content",
                }}
              >
                {t(link.labelKey)}
              </button>
            ))}
          </div>
        )}
      </div>
    </ModalShell>
  );
}
