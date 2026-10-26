import { useAiStore, useAiGlow, AI_GLOW_KEYS } from "../../stores/ai";
import { t } from "../../i18n/t";
import { IconClose } from "../icons";

const TRANSLATE_LANGS: { code: "fr" | "en" | "ko"; label: string }[] = [
  { code: "fr", label: "FR" },
  { code: "en", label: "EN" },
  { code: "ko", label: "KO" },
];

// 번역 결과 뷰 — 툴바 바로 아래, 에디터 본문 위에 삽입되는 별도 패널. 읽기전용(플레인 텍스트
// <div>, contentEditable 아님)이라 원본 섹션 본문과 시각적으로도 명확히 구분되고, 실수로도
// 편집이 안 된다. activeNote/switchSection 등 기존 상태에는 전혀 손대지 않는 순수 추가 UI.
export function TranslatePanel() {
  const translateEnabled = useAiStore((s) => s.translateEnabled);
  const translateTargetLang = useAiStore((s) => s.translateTargetLang);
  const setTranslateTargetLang = useAiStore((s) => s.setTranslateTargetLang);
  const translatedText = useAiStore((s) => s.translatedText);
  const translatePending = useAiStore((s) => s.translatePending);
  // "선택 번역"(에디터 컨텍스트 메뉴)은 toolbar 토글 없이도 이 패널을 보여준다 — ai.ts::
  // translateSelection 참고. 토글이 꺼진 채로 선택-번역만 보고 있을 때만 별도 닫기 버튼이
  // 필요하다(토글이 켜져 있으면 기존 마이크 옆 토글 버튼이 이미 그 역할을 한다).
  const translateSelectionActive = useAiStore((s) => s.translateSelectionActive);
  const isTranslateGlow = useAiGlow(AI_GLOW_KEYS.translate);

  if (!translateEnabled && !translateSelectionActive) return null;

  return (
    <div
      data-ai-glow={isTranslateGlow || undefined} /* "active" | "fading" */
      data-ai-glow-inset="true"
      style={{
        flex: "none",
        maxHeight: "30%",
        overflow: "auto",
        padding: "var(--space-4) var(--space-6)",
        borderBottom: "1px solid var(--divider)",
        background: "var(--sel)",
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-3)" }}>
        <span style={{ fontSize: "var(--text-label)", color: "var(--muted)", textTransform: "uppercase", }}>
          {t("editor.translate_readonly_label") || "Translation — read-only"}
          {translatePending ? ` · ${t("editor.translate_pending") || "Translating…"}` : ""}
        </span>
        <div style={{ display: "flex", gap: "var(--space-2xs)" }}>
          {TRANSLATE_LANGS.map(({ code, label }) => (
            <button
              key={code}
              type="button"
              onClick={() => void setTranslateTargetLang(code)}
              style={{
                border: 0,
                borderRadius: "var(--radius-sm)",
                padding: "var(--space-2xs) 7px",
                fontSize: "var(--text-2xs)",
                fontWeight: 600,
                cursor: "pointer",
                background: translateTargetLang === code ? "var(--accent)" : "transparent",
                color: translateTargetLang === code ? "var(--on-accent)" : "var(--muted)",
              }}
            >
              {label}
            </button>
          ))}
          {!translateEnabled && translateSelectionActive && (
            <button
              type="button"
              onClick={() => useAiStore.setState({ translateSelectionActive: false, translatedText: "" })}
              title={t("common.close")}
              aria-label={t("common.close")}
              className="icon-btn icon-btn--sm"
              style={{ color: "var(--faint)" }}
            >
              <IconClose size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
      <div
        aria-readonly="true"
        style={{
          whiteSpace: "pre-wrap",
          fontSize: "var(--text-md)",
          lineHeight: 1.6,
          color: "var(--text)",
          fontStyle: translatedText ? "normal" : "italic",
          userSelect: "text",
          cursor: "text",
        }}
      >
        {translatedText || (translatePending ? "…" : t("editor.translate_empty") || "Nothing to translate yet.")}
      </div>
    </div>
  );
}
