import { t } from "../../i18n/t";

/**
 * 설정 > 모양 하단 미리보기 (오너 지시 2026-09-02).
 *
 * 강조색·글꼴은 행에 붙은 스와치나 드롭다운만 봐서는 "실제로 어떻게 보이는지"를 알 수 없다 —
 * 특히 글자 크기가 제목/본문/인용/코드에서 어떻게 벌어지는지는 실물을 봐야 안다. 그래서
 * **에디터를 중심으로** 간소화한 판을 하나 그린다.
 *
 * 핵심: 목업을 새로 그리지 않고 **에디터가 실제로 쓰는 `.mdbody` 클래스를 그대로 입힌다**
 * (styles/tokens.css). h1/h2/p/ul/blockquote/code 의 크기·간격·굵기·강조색이 전부 그 규칙에서
 * 나오므로, 에디터 타이포가 바뀌면 이 미리보기도 저절로 따라간다 — DashboardMiniPreview 가
 * 실물 탭 스트립을 액자에 넣은 것과 같은 방식(손으로 흉내 낸 목업은 반드시 드리프트한다).
 *
 * `.mdbody` 의 기본 여백(`padding: 8px var(--space-6) 40px`)과 `max-width: 800px` 는 전체 화면
 * 에디터용이라 작은 액자에서는 과하다 — 인라인으로만 덮는다(클래스 규칙은 건드리지 않는다).
 */
export function AppearancePreview() {
  return (
    <div style={{ paddingTop: "var(--space-5)" }}>
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--muted)",
          marginBottom: "var(--space-2)",
        }}
      >
        {t("settings.preview")}
      </div>

      <div
        data-testid="settings-appearance-preview"
        style={{
          border: "1px solid var(--divider)",
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
          // **--app-canvas 가 아니라 --app-sheet-base 다.** 이 액자는 `.content-canvas` 안에
          // 있는데, PLAN-2026-09-12 §3 이후 그 서브트리에서 --app-canvas 는 "틴트가 **이미**
          // 합성된" 바탕을 가리킨다. 그 위에 아래 층이 --content-tint 를 또 얹으면 틴트가 두
          // 번 칠해져 미리보기가 실물보다 어두워진다(실측: 라이트 +40 에서 ΔL* 24.6, 음수
          // 오프셋에서는 부호까지 뒤집혀 더 **밝아진다**). --app-sheet-base 는 틴트 이전의 시트
          // 기준면이라, 여기에 아래 층이 틴트를 한 번 얹으면 실제 본문과 픽셀이 같아진다.
          background: "var(--app-sheet-base, transparent)",
        }}
      >
        {/* PLAN-2026-09-12 §5: 본문 틴트를 **실제와 같은 순서로** 겹친다 — `.content-canvas` 도
            시트 위에 --content-tint 반투명 층을 한 겹 얹는 구조다(tokens.css). 이 층이 없으면
            새 "본문 밝기" 슬라이더를 움직여도 미리보기가 아무 말도 하지 않는다. */}
        <div data-testid="settings-appearance-preview-tint" style={{ background: "var(--content-tint)" }}>
          <div className="mdbody" style={{ padding: "var(--space-5)", maxWidth: "none" }}>
            <h1>{t("settings.preview_h1")}</h1>
            <p>{t("settings.preview_body")}</p>
            <h2>{t("settings.preview_h2")}</h2>
            <ul>
              <li>{t("settings.preview_list_1")}</li>
              <li>
                {t("settings.preview_list_2")} <code>{t("settings.preview_code")}</code>
              </li>
            </ul>
            {/* 인용은 좌측 3px 테두리가 --accent 다 — 강조색이 본문에서 어떻게 보이는지가 여기서 난다. */}
            <blockquote>{t("settings.preview_quote")}</blockquote>
          </div>
        </div>
      </div>
    </div>
  );
}
