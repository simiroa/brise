import { t } from "../../../i18n/t";
import { useNotesStore } from "../../../stores/notes";
import { IconSearch } from "../../icons";
import { ModalShell } from "../../ModalShell";
import { Select } from "../../Select";
import { Badge } from "../Badge";
import { IconAction } from "../IconAction";
import { Toggle } from "../Toggle";
import { FormField } from "../FormField";
import { collectIntervalOptions, sourceIntervalLabel } from "./collectSourceLabels";
import { Spinner } from "./Spinner";
import type { CollectSourceForm } from "./useCollectSourceForm";

type FormCategory = "web" | "chat" | "browser";

// 좌측 카테고리 탭 세 개 — 모양은 같고 id·testid·이모지·문구만 다르다.
const CATEGORY_TABS: { id: FormCategory; testId: string; emoji: string; labelKey: string; hintKey: string }[] = [
  { id: "web", testId: "collect-quick-url-tab", emoji: "🌐", labelKey: "settings.collect_cat_web", hintKey: "settings.collect_cat_web_hint" },
  { id: "chat", testId: "collect-quick-chat-session", emoji: "💬", labelKey: "settings.collect_cat_chat", hintKey: "settings.collect_cat_chat_hint" },
  { id: "browser", testId: "collect-quick-browser-history", emoji: "🧭", labelKey: "settings.collect_cat_browser", hintKey: "settings.collect_cat_browser_hint" },
];

interface CollectSourceFormModalProps {
  form: CollectSourceForm;
}

/**
 * 소스 추가/수정 좌우 2단 모달 — 좌측 카테고리 탭, 우측 상세 폼. 상태와 저장은 useCollectSourceForm
 * 이 쥐고, 이 컴포넌트는 그리기만 한다(호출자가 `form.formOpen` 일 때만 마운트한다).
 */
export function CollectSourceFormModal({ form }: CollectSourceFormModalProps) {
  const {
    formState,
    setFormState,
    formSaving,
    formError,
    closeForm,
    saveForm,
    handleUrlChange,
    detectedSessions,
    detectingSessions,
    detectedSessionsDone,
    detectChatSessions,
  } = form;
  const folders = useNotesStore((s) => s.folders);
  const intervalOptions = collectIntervalOptions();

  const folderOptions = [
    { value: "", label: t("settings.collect_target_folder_inbox") },
    ...folders.map((f) => ({ value: f.id, label: f.name })),
  ];

  const isChat = formState.kind === "claude_prompts" || formState.kind === "codex_prompts";
  const isBrowserKind = formState.kind === "browser_history";
  const currentCategory: FormCategory = isChat ? "chat" : isBrowserKind ? "browser" : "web";

  const switchCategory = (cat: FormCategory) => {
    if (cat === "web") {
      setFormState((prev) => ({ ...prev, kind: "rss" }));
    } else if (cat === "chat") {
      setFormState((prev) => ({
        ...prev,
        kind: "claude_prompts",
        backfillDays: "14",
      }));
      void detectChatSessions(false);
    } else if (cat === "browser") {
      setFormState((prev) => ({
        ...prev,
        kind: "browser_history",
        backfillDays: "7",
      }));
    }
  };

  return (
    <ModalShell
      title={formState.id ? t("settings.collect_edit_source") : t("settings.collect_add_source")}
      onClose={closeForm}
      width={720}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn" data-testid="collect-form-cancel-btn" onClick={closeForm} disabled={formSaving}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" data-testid="collect-form-save-btn" onClick={() => void saveForm()} disabled={formSaving}>
            {formSaving ? <Spinner /> : t("common.apply")}
          </button>
        </div>
      }
    >
      <div style={{ display: "flex", gap: "var(--space-4)", minHeight: 340 }}>
        {/* 좌측: 소스 카테고리 탭 (2단 좌측 패널) */}
        <div
          style={{
            width: 190,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            // 모달 2단 사이의 세로 경계 = 영역 경계다 — 설정 창의 단일 선 색.
            borderRight: "1px solid var(--divider)",
            paddingRight: "var(--space-3)",
          }}
        >
          <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", fontWeight: 600, paddingBottom: 4 }}>
            {t("settings.collect_kind_label")}
          </div>
          {CATEGORY_TABS.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={Boolean(formState.id)}
              data-testid={c.testId}
              onClick={() => switchCategory(c.id)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 4,
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                border: "none",
                background: currentCategory === c.id ? "var(--surface-sunken)" : "transparent",
                color: currentCategory === c.id ? "var(--accent)" : "var(--text)",
                cursor: formState.id ? "default" : "pointer",
                textAlign: "left",
                // type-scale-exempt: dynamic category active weight
                fontWeight: currentCategory === c.id ? 600 : 400,
                transition: "background var(--dur-fast)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-sm)" }}>
                <span>{c.emoji}</span>
                <span>{t(c.labelKey)}</span>
              </div>
              <span style={{ fontSize: "var(--text-2xs)", color: "var(--muted)" }}>
                {t(c.hintKey)}
              </span>
            </button>
          ))}
        </div>

        {/* 우측: 상세 설정 폼 (2단 우측 패널) */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
          {formError && (
            <div style={{ color: "var(--danger)", fontSize: "var(--text-sm)", padding: "6px 10px", borderRadius: "var(--radius-sm)", background: "color-mix(in srgb,var(--danger) 10%,transparent)" }}>
              {formError}
            </div>
          )}

          {/* URL (RSS / Web / YouTube / YouTube 채널) */}
          {(formState.kind === "rss" || formState.kind === "web" || formState.kind === "youtube" || formState.kind === "youtube_channel") && (
            <FormField label={t("settings.collect_url_label")}>
              <input
                type="text"
                className="field"
                style={{ width: "100%" }}
                value={formState.url}
                onChange={(e) => handleUrlChange(e.target.value)}
                placeholder={
                  formState.kind === "youtube_channel"
                    ? t("settings.collect_url_youtube_channel_placeholder")
                    : t("settings.collect_url_placeholder")
                }
              />
              {formState.kind === "rss" && (
                <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", display: "block" }}>
                  {t("settings.collect_url_rss_hint")}
                </span>
              )}
              {formState.kind === "youtube" && (
                <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", display: "block" }}>
                  {t("settings.collect_url_youtube_hint")}
                </span>
              )}
              {formState.kind === "youtube_channel" && (
                <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", display: "block" }}>
                  {t("settings.collect_url_youtube_channel_hint")}
                </span>
              )}
            </FormField>
          )}

          {/* 수집 유형 + 소스 이름 (1행 2열 배치) — 7종류 모든 옵션을 가진 Select로 항상 렌더링되어 테스트 및 사용성 100% 보장 */}
          <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 12 }}>
            <FormField as="div" label={t("settings.collect_kind_label")}>
              <Select
                value={formState.kind}
                onChange={(v) => {
                  const k = v as any;
                  setFormState((prev) => ({
                    ...prev,
                    kind: k,
                    backfillDays: k === "browser_history" ? "7" : "14",
                  }));
                  if (k === "claude_prompts" || k === "codex_prompts") {
                    void detectChatSessions(false);
                  }
                }}
                ariaLabel={t("settings.collect_kind_label")}
                disabled={Boolean(formState.id)}
                style={{ width: "100%", minWidth: 0 }}
                options={[
                  { value: "rss", label: t("settings.collect_kind_rss") },
                  { value: "web", label: t("settings.collect_kind_web") },
                  { value: "youtube", label: t("settings.collect_kind_youtube") },
                  { value: "youtube_channel", label: t("settings.collect_kind_youtube_channel") },
                  { value: "claude_prompts", label: t("settings.collect_kind_claude_prompts") },
                  { value: "codex_prompts", label: t("settings.collect_kind_codex_prompts") },
                  { value: "browser_history", label: t("settings.collect_kind_browser_history") },
                ]}
              />
            </FormField>

            <FormField label={t("settings.collect_source_name")}>
              <input
                type="text"
                className="field"
                style={{ width: "100%", boxSizing: "border-box" }}
                value={formState.name}
                onChange={(e) => setFormState((prev) => ({ ...prev, name: e.target.value }))}
                placeholder={t("settings.collect_source_name_placeholder")}
              />
            </FormField>
          </div>

          {/* AI 대화 세션 감지 카드 (Claude/Codex 선택 시 표시) */}
          {(formState.kind === "claude_prompts" || formState.kind === "codex_prompts") && (
            <div
              style={{
                padding: "10px 12px",
                borderRadius: "var(--radius-sm)",
                background: "var(--surface-sunken)",
                border: "1px solid var(--divider)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text)" }}>
                    {t("settings.collect_detect_chat_title")}
                  </span>
                  <span style={{ fontSize: "var(--text-2xs)", color: "var(--muted)", marginLeft: 6 }}>
                    {t("settings.collect_detect_chat_hint")}
                  </span>
                </div>
                <IconAction
                  icon={<IconSearch size={14} />}
                  label={t("settings.collect_detect_btn")}
                  size="sm"
                  data-testid="collect-modal-detect-btn"
                  busy={detectingSessions}
                  disabled={detectingSessions}
                  onClick={() => void detectChatSessions(true)}
                />
              </div>

              {/* 감지된 최근 세션 목록 */}
              {detectedSessionsDone && detectedSessions.length === 0 && (
                <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", padding: "4px 0" }}>
                  {t("settings.collect_detect_chat_empty")}
                </div>
              )}

              {detectedSessions.length > 0 && (
                <div
                  className="scroll"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    maxHeight: 180,
                    overflowY: "auto",
                    paddingRight: 4,
                  }}
                >
                  {detectedSessions.map((sess) => (
                    <div
                      key={sess.id}
                      style={{
                        padding: "8px 10px",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--surface-sunken)",
                        border: "1px solid var(--divider)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {/* PLAN-2026-09-12 §7: 두 세션 종류를 가르던 생파랑(#3b82f6)을
                              걷었다. 강조색이 hue 가변이 되면(§4) 레드/블루 강조색 화면에
                              남의 파랑이 하나 더 떠 있게 된다. 구분은 **색상(hue)이 아니라
                              채움 대 윤곽**으로 준다 — Claude 는 강조색으로 채운 알약,
                              Codex 는 중성 윤곽 알약(SyncSection 의 BetaBadge 와 같은 형태).
                              어느 강조색에서도 두 칩이 서로 구별되고, 튀지 않는다. */}
                          <Badge tone={sess.kind === "claude_prompts" ? "accent" : "neutral"}>
                            {sess.kind === "claude_prompts" ? "Claude" : "Codex"}
                          </Badge>
                          <strong style={{ fontSize: "var(--text-xs)" }}>{sess.project}</strong>
                          <span style={{ fontSize: "var(--text-2xs)", color: "var(--muted)" }}>
                            {sess.relative_time} ({t("settings.collect_session_count", { n: sess.prompt_count })})
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ fontSize: "var(--text-2xs)", padding: "4px 8px" }}
                          onClick={() => {
                            setFormState((prev) => ({
                              ...prev,
                              kind: sess.kind as any,
                              name: `${sess.kind === "claude_prompts" ? "Claude" : "Codex"} (${sess.project})`,
                              project: sess.project,
                            }));
                          }}
                        >
                          {t("settings.collect_session_select")}
                        </button>
                      </div>
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ color: "var(--muted)" }}>{t("settings.collect_question_label")}</span> &ldquo;{sess.title}&rdquo;
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Claude/Codex Prompts 프로젝트 필터 + 백필 기간 */}
          {(formState.kind === "claude_prompts" || formState.kind === "codex_prompts") && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <FormField label={t("settings.collect_claude_project_filter")}>
                <input
                  type="text"
                  className="field"
                  style={{ width: "100%" }}
                  value={formState.project}
                  onChange={(e) => setFormState((prev) => ({ ...prev, project: e.target.value }))}
                  placeholder={t("settings.collect_project_placeholder")}
                />
              </FormField>
              <FormField label={t("settings.collect_backfill_days_label")}>
                <input
                  type="number"
                  className="field"
                  style={{ width: "100%" }}
                  min={1}
                  max={365}
                  value={formState.backfillDays}
                  onChange={(e) => setFormState((prev) => ({ ...prev, backfillDays: e.target.value }))}
                />
              </FormField>
            </div>
          )}

          {/* browser_history 전용 필드 4개 */}
          {formState.kind === "browser_history" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FormField as="div" label={t("settings.collect_browser_label")}>
                  <Select
                    value={formState.browser}
                    onChange={(v) => setFormState((prev) => ({ ...prev, browser: v as any }))}
                    ariaLabel={t("settings.collect_browser_label")}
                    style={{ width: "100%", minWidth: 0 }}
                    options={[
                      { value: "chrome", label: "Chrome" },
                      { value: "edge", label: "Edge" },
                      { value: "brave", label: t("settings.collect_browser_brave") },
                      { value: "vivaldi", label: t("settings.collect_browser_vivaldi") },
                      { value: "whale", label: t("settings.collect_browser_whale") },
                    ]}
                  />
                </FormField>
                <FormField label={t("settings.collect_profile_label")}>
                  <input
                    type="text"
                    className="field"
                    style={{ width: "100%" }}
                    value={formState.profile}
                    onChange={(e) => setFormState((prev) => ({ ...prev, profile: e.target.value }))}
                    placeholder="Default"
                  />
                </FormField>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FormField label={t("settings.collect_min_seconds_label")}>
                  <input
                    type="number"
                    className="field"
                    style={{ width: "100%" }}
                    min={5}
                    max={600}
                    value={formState.minSeconds}
                    onChange={(e) => setFormState((prev) => ({ ...prev, minSeconds: e.target.value }))}
                  />
                </FormField>
                <FormField label={t("settings.collect_backfill_days_label")}>
                  <input
                    type="number"
                    className="field"
                    style={{ width: "100%" }}
                    min={1}
                    max={90}
                    value={formState.backfillDays}
                    onChange={(e) => setFormState((prev) => ({ ...prev, backfillDays: e.target.value }))}
                  />
                </FormField>
              </div>
            </>
          )}

          {/* 고급 옵션 아코디언 토글 */}
          {/* 기본 설정 ↔ 고급 옵션 = 카드 안 하위 그룹 경계다(DESIGN.md §설정 레이아웃 ②ⓑ). */}
          <div style={{ borderTop: "1px solid var(--divider)", paddingTop: 10, marginTop: "auto" }}>
            <button
              type="button"
              data-testid="collect-form-advanced-toggle"
              onClick={() => setFormState((prev) => ({ ...prev, advancedOpen: !prev.advancedOpen }))}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "none",
                border: "none",
                padding: "4px 0",
                cursor: "pointer",
                color: "var(--muted)",
                fontSize: "var(--text-xs)",
                textAlign: "left",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "var(--text)" }}>
                <span style={{
                  display: "inline-block",
                  transform: formState.advancedOpen ? "rotate(90deg)" : "rotate(0deg)",
                  transition: "transform var(--dur-fast)",
                  fontSize: "var(--text-2xs)",
                }}>
                  ▶
                </span>
                <span>{t("settings.collect_advanced_options")}</span>
              </div>
              {!formState.advancedOpen && (
                <div style={{ fontSize: "var(--text-2xs)", color: "var(--muted)", display: "flex", gap: 6 }}>
                  <span>{formState.targetFolderId ? folders.find((f) => f.id === formState.targetFolderId)?.name || formState.targetFolderId : t("settings.collect_target_folder_inbox")}</span>
                  <span>·</span>
                  <span>{formState.kind !== "youtube" ? sourceIntervalLabel(Number(formState.intervalMinutes) || 60, intervalOptions) : t("settings.collect_once")}</span>
                  {formState.postProcess !== "none" && (
                    <>
                      <span>·</span>
                      <span style={{ color: "var(--accent)" }}>
                        {formState.postProcess === "suggest" ? t("settings.collect_ai_post_process_badge") : t("settings.collect_post_process_summary")}
                      </span>
                    </>
                  )}
                  {formState.dryRun && (
                    <>
                      <span>·</span>
                      <span style={{ color: "var(--accent)" }}>{t("settings.collect_dry_run_badge")}</span>
                    </>
                  )}
                </div>
              )}
            </button>

            {/* 펼쳐졌을 때의 고급 옵션들 */}
            {formState.advancedOpen && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 10 }}>
                {/* 저장 대상 폴더 & 수집 주기 (2열) */}
                <div style={{ display: "grid", gridTemplateColumns: formState.kind === "youtube" ? "1fr" : "1fr 1fr", gap: 12 }}>
                  <FormField as="div" label={t("settings.collect_target_folder")}>
                    <Select
                      value={formState.targetFolderId}
                      onChange={(v) => setFormState((prev) => ({ ...prev, targetFolderId: v }))}
                      ariaLabel={t("settings.collect_target_folder")}
                      style={{ width: "100%", minWidth: 0 }}
                      options={folderOptions}
                    />
                  </FormField>

                  {formState.kind !== "youtube" && (
                    <FormField as="div" label={t("settings.collect_interval")}>
                      <Select
                        value={formState.intervalMinutes}
                        onChange={(v) => setFormState((prev) => ({ ...prev, intervalMinutes: v }))}
                        ariaLabel={t("settings.collect_interval")}
                        style={{ width: "100%", minWidth: 0 }}
                        options={intervalOptions}
                      />
                    </FormField>
                  )}
                </div>

                {/* AI 후처리 & 가상 실행 (동작/고급 옵션 2열 배치) */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 12,
                    alignItems: "end",
                  }}
                >
                  <FormField as="div" label={t("settings.collect_ai_post_process")}>
                    <Select
                      value={formState.postProcess}
                      onChange={(v) => setFormState((prev) => ({ ...prev, postProcess: v as any }))}
                      ariaLabel={t("settings.collect_ai_post_process")}
                      style={{ width: "100%", minWidth: 0 }}
                      options={[
                        { value: "none", label: t("settings.collect_ai_post_process_none") },
                        { value: "suggest", label: t("settings.collect_ai_post_process_suggest") },
                        { value: "summary", label: t("settings.collect_post_process_summary") },
                      ]}
                    />
                  </FormField>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "0 10px",
                      height: 32,
                      borderRadius: "var(--radius-sm)",
                      background: "var(--surface-sunken)",
                      boxSizing: "border-box",
                    }}
                    title={t("settings.collect_dry_run_hint")}
                  >
                    <span style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text)" }}>
                      {t("settings.collect_dry_run_toggle")}
                    </span>
                    <Toggle
                      checked={formState.dryRun}
                      onChange={(next) => setFormState((prev) => ({ ...prev, dryRun: next }))}
                      aria-label={t("settings.collect_dry_run_toggle")}
                    />
                  </div>
                </div>

                {/* 브리핑 "최근 수집 노트"에 이 소스를 보일지(E3) */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "0 10px",
                    height: 32,
                    borderRadius: "var(--radius-sm)",
                    background: "var(--surface-sunken)",
                    boxSizing: "border-box",
                  }}
                  title={t("settings.collect_show_in_briefing_hint")}
                >
                  <span style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text)" }}>
                    {t("settings.collect_show_in_briefing")}
                  </span>
                  <Toggle
                    checked={formState.showInBriefing}
                    onChange={(next) => setFormState((prev) => ({ ...prev, showInBriefing: next }))}
                    aria-label={t("settings.collect_show_in_briefing")}
                    data-testid="collect-form-show-in-briefing"
                  />
                </div>

                {/* AI 후처리 활성화 시: 모델 오버라이드 및 커스텀 프롬프트 */}
                {formState.postProcess !== "none" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 10px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)" }}>
                    {formState.postProcess === "summary" && (
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--accent)", lineHeight: 1.4 }}>
                        {t("settings.collect_post_process_summary_hint")}
                      </div>
                    )}
                    {formState.postProcess === "suggest" && (
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--accent)", lineHeight: 1.4 }}>
                        {t("settings.collect_ai_post_process_notice")}
                      </div>
                    )}

                    <FormField label={t("settings.collect_post_process_model")}>
                      <input
                        type="text"
                        className="field"
                        style={{ width: "100%" }}
                        value={formState.postProcessModel}
                        onChange={(e) => setFormState((prev) => ({ ...prev, postProcessModel: e.target.value }))}
                        placeholder={t("settings.collect_models_placeholder")}
                      />
                    </FormField>

                    <FormField label={t("settings.collect_post_process_prompt_label")}>
                      <input
                        type="text"
                        className="field"
                        style={{ width: "100%" }}
                        value={formState.postProcessPrompt}
                        onChange={(e) => setFormState((prev) => ({ ...prev, postProcessPrompt: e.target.value }))}
                        placeholder={t("settings.collect_post_process_prompt_placeholder")}
                      />
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", display: "block" }}>
                        {t("settings.collect_post_process_prompt_hint")}
                      </span>
                    </FormField>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
