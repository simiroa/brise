/**
 * 모달 타이틀바(ModalShell `title` 노드) — `✦ AI · <제공자>` + 외부전송 배지 + `?` 도움말 버튼 (PLAN-2026-09-27 §3.6).
 *
 * 데이터 목적지는 늘 보이며(✦ AI · Gemini), 툴팁으로 데이터 안내를 띄운다.
 * 외부 제공자일 때만 `외부 전송` 배지가 붙는다.
 * 헤더 오른쪽 `?` 버튼으로 환영·활용·데이터 안내 카드를 언제든 다시 열 수 있다.
 */
import { IconSparkles } from "../icons";
import type { AiDataDest } from "./askAiTypes";
import { t } from "../../i18n/t";

export function AskAiHeader({
  dest,
  onHelp,
}: {
  /** null = 아직 모름 → 외부로 보인다(askAiTypes AiDataDest). */
  dest?: AiDataDest | null;
  onHelp?: () => void;
}) {
  // 배지는 외부로 **확정**됐을 때만(설정을 읽기 전엔 깜빡이지 않게). 안내 문장은 모르면 외부 쪽으로 쓴다.
  const isExternal = dest?.external === true;
  const displayProvider = dest?.name ?? "";
  const dataTooltip = (dest?.external ?? true)
    ? t("ai.welcome_data_external", { provider: displayProvider || t("ai.welcome_provider_unknown") })
    : t("ai.welcome_data_local");

  return (
    <div className="askai-head" data-testid="askai-header">
      <span className="askai-head__brand" title={dataTooltip}>
        <IconSparkles size={17} strokeWidth={1.8} />
        <span>AI</span>
        {displayProvider && <span className="askai-head__provider">· {displayProvider}</span>}
        {isExternal && (
          <span className="badge askai-head__badge" data-tone="accent" data-testid="askai-external-badge">
            {t("ai.external_transfer_badge")}
          </span>
        )}
      </span>
      {onHelp && (
        <button
          type="button"
          className="askai-head__help"
          data-testid="askai-help-btn"
          aria-label={t("ai.welcome_help_label")}
          title={t("ai.welcome_help_label")}
          onClick={onHelp}
        >
          ?
        </button>
      )}
    </div>
  );
}
