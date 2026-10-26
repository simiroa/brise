import { useEffect, useRef, useState } from "react";
import { useAiPresetsStore, visiblePresets, isActionSlot } from "../../stores/aiPresets";
import { CUSTOM_KINDS, type AskAiKind, type CustomAiActionKind } from "../../stores/aiPrompts";
import { t } from "../../i18n/t";
import { Select } from "../Select";
import { IconPlus, IconClose, IconArrowUp, IconArrowDown, IconEye } from "../icons";

// PresetList mode="manage" 의 "AI 액션" 탭 (PLAN-2026-08-30 §3 W4) — 원래 설정 > AI 의
// AiActionsSection.tsx 였다. 노트 프리셋 관리 모달로 이동했을 뿐 로직은 그대로다(재작성 금지):
// 오너 요구 "AI 프리셋을 기존 프리셋 관리모달로" 를 잇는 절반 — PresetList.tsx:391 이 이미
// useAiPresetsStore 의 template kind 를 읽고 있었으니 이 편집기가 나머지 절반이다.
//
// SINGLE COLUMN (owner: "드롭다운 UI에 추가/제거를 넣으면 좌변 리스트 없이도 충분하지 않나").
// The preset picker is the app's own <Select> with add (+) and delete (×) inline beside it;
// everything below is the selected preset's editor. The old master–detail (roving-tabindex
// listbox on the left, detail on the right) is gone — it spent a whole column on a list of at
// most a dozen names and forced a wrap rule at narrow widths.
//
// UNSAVED-EDIT RULE — **COMMIT ON SWITCH** (unchanged, still load-bearing here). The name/prompt
// fields are a local buffer (`draft`) written back through updateItem(); every path that changes
// the selection (picking another preset, add, delete) calls commit() first, so a half-typed
// prompt is saved rather than dropped. onBlur commits too (the save-on-blur pattern shared with
// AiProviderSection); commit() diffs against the store, so blur-then-pick committing twice writes
// nothing the second time.
//
// Settings-only chrome (groupCardStyle card wrapper, SectionHeader) was stripped on the move —
// this now renders as a plain block inside PresetList's manage-mode scroll body, which already
// owns the modal's padding. The label-caps + restore-button header row below mirrors the "노트
// 프리셋" tab's own header (PresetList.tsx's note-templates-group), for visual parity across tabs.
//
// Mobile is untouched: MobileSettings.tsx has its own rows→bottom-sheet editor.

/** AI 모달의 "+추가" 타일로 열렸을 때 — 스토어가 로드된 **뒤** 이 종류·대상으로 새 프리셋을 한 번 만든다.
 *  로드 전에 만들면 addCustom 이 builtinDefaults() 를 기반으로 저장해 사용자 목록을 덮는다. */
export interface AiActionAutoAdd {
  kind: CustomAiActionKind;
  targets?: AskAiKind[];
}

export function AiActionEditor({ autoAdd, initialId }: { autoAdd?: AiActionAutoAdd; initialId?: string } = {}) {
  const list = useAiPresetsStore((s) => s.list);
  const loaded = useAiPresetsStore((s) => s.loaded);
  const load = useAiPresetsStore((s) => s.load);
  const addCustom = useAiPresetsStore((s) => s.addCustom);
  const updateItem = useAiPresetsStore((s) => s.updateItem);
  const resetItem = useAiPresetsStore((s) => s.resetItem);
  const deleteItem = useAiPresetsStore((s) => s.deleteItem);
  const setHidden = useAiPresetsStore((s) => s.setHidden);
  const reorder = useAiPresetsStore((s) => s.reorder);
  const restoreHiddenBuiltins = useAiPresetsStore((s) => s.restoreHiddenBuiltins);

  // initialId — AI 모달의 연필이 지금 고른 타일로 연다(없거나 숨겨졌으면 아래 규칙대로 첫 항목).
  const [selectedId, setSelectedId] = useState<string | null>(initialId ?? null);
  // "+" 가 만들 항목의 kind (2026-08-08 Q5: text 하드코딩 해제). metadata 는 출력 스키마가 앱
  // 고정이라 목록에 없다 — CUSTOM_KINDS 가 그 사실의 SSOT다.
  const [newKind, setNewKind] = useState<CustomAiActionKind>("text");
  const [draft, setDraft] = useState<{ id: string; name: string; prompt: string } | null>(null);
  // Bumped instead of calling focus() inline: the focus has to land *after* React has re-rendered
  // the editor for the new selection, otherwise select() highlights the outgoing preset's text.
  const [focusNameSeq, setFocusNameSeq] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);

  // Same `if (!loaded)` gate as PresetList.tsx / AiActionsMenu — this tab can be the first surface
  // opened, or the second (AiActionsMenu/PresetList's own note-tab already loaded it); either way,
  // only fetch once.
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    if (!focusNameSeq) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [focusNameSeq]);

  const visible = visiblePresets(list);
  const hasHidden = list.some((p) => p.isBuiltin && p.hidden);
  // 단일 목록 SSOT: 모든 항목을 드롭다운에서 탐색 가능하게 하되, 숨김 항목은 (숨김) 표시. 바로 실행 액션의 숨김
  // 자리(타일 없는 빌트인 — AI 기능 카탈로그가 켜고 끈다)는 AI 프리셋이 아니라 빠진다(stores/aiPresets isActionSlot).
  const items = list.filter((p) => !isActionSlot(p));
  const selected = items.find((p) => p.id === selectedId) ?? items[0] ?? null;
  const selectedIndex = selected ? items.findIndex((p) => p.id === selected.id) : -1;
  const activeDraft = draft && selected && draft.id === selected.id ? draft : null;

  // Returns the in-flight write so a caller that persists again right after (onAdd) can await it.
  // Both writes target the same settings_set key with the whole list — letting them overlap would
  // race, and the loser silently drops whichever change it didn't see. onBlur ignores the return.
  const commit = (): Promise<void> | undefined => {
    const d = draft;
    setDraft(null);
    if (!d) return;
    const target = list.find((p) => p.id === d.id);
    if (!target) return; // deleted while being edited — nothing to write back to
    const patch: { name?: string; prompt?: string } = {};
    // An emptied name is dropped (not persisted as ""), same as the old onBlur revert.
    if (d.name.trim() && d.name !== target.name) patch.name = d.name;
    if (d.prompt !== target.prompt) patch.prompt = d.prompt;
    if (patch.name !== undefined || patch.prompt !== undefined) return updateItem(d.id, patch);
  };

  const select = (id: string) => {
    commit();
    setSelectedId(id);
  };

  const edit = (patch: { name?: string; prompt?: string }) => {
    if (!selected) return;
    setDraft({
      id: selected.id,
      name: activeDraft?.name ?? selected.name,
      prompt: activeDraft?.prompt ?? selected.prompt,
      ...patch,
    });
  };

  const onAdd = async (kind: CustomAiActionKind = newKind, targets?: AskAiKind[]) => {
    await commit(); // must land before addCustom's own write — same key, whole-list payload
    const prevIds = new Set(useAiPresetsStore.getState().list.map((p) => p.id));
    // template 은 프롬프트가 아니라 노트 본문 스캐폴드라 시작 문구가 다르다 — 프롬프트용 안내문을
    // 그대로 넣으면 그게 새 노트 첫 줄로 들어간다.
    await addCustom(
      t("ai.action_new_name"),
      kind === "template" ? t("ai.template_new_body") : t("ai.action_new_prompt"),
      kind,
      targets,
    );
    // addCustom generates the id internally and withPersist rolls the whole list back if the save
    // fails — so read the id back off the store rather than assuming an append landed.
    const created = useAiPresetsStore.getState().list.find((p) => !prevIds.has(p.id));
    if (!created) return;
    setSelectedId(created.id);
    setFocusNameSeq((n) => n + 1);
  };

  // AI 모달 "+추가"로 열렸으면 로드가 끝난 뒤 정확히 한 번 만든다(ref — StrictMode 의 이펙트 재실행에도 한 번).
  const autoAdded = useRef(false);
  useEffect(() => {
    if (!autoAdd || !loaded || autoAdded.current) return;
    autoAdded.current = true;
    void onAdd(autoAdd.kind, autoAdd.targets);
    // onAdd 는 매 렌더 새로 만들어지지만 이 이펙트는 로드 완료에 한 번만 반응하면 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAdd, loaded]);

  const onDelete = async () => {
    if (!selected) return;
    // Neighbour = the item that takes this one's place (next), else the one above. Only when the
    // list empties out entirely does the editor go away — and then it explains itself.
    const neighbour = items[selectedIndex + 1] ?? items[selectedIndex - 1] ?? null;
    setDraft(null);
    setSelectedId(neighbour ? neighbour.id : null);
    await deleteItem(selected.id);
  };

  const onReset = () => {
    if (!selected) return;
    setDraft(null); // drop the buffer so the restored default shows immediately
    void resetItem(selected.id);
  };

  const nameValue = activeDraft ? activeDraft.name : (selected?.name ?? "");
  const promptValue = activeDraft ? activeDraft.prompt : (selected?.prompt ?? "");
  const isTemplate = selected?.kind === "template";
  const isTool = selected?.kind === "tool";

  // The picker shows the in-progress name for the selected row, with hidden, template, custom badges
  const options = items.map((p) => {
    const hiddenTag = p.hidden ? ` [${t("ai.action_hidden")}]` : "";
    const kindTag = p.kind === "template" ? ` · ${t("ai.action_kind_template")}` : p.kind === "tool" ? ` · ${t("ai.action_kind_tool")}` : "";
    const customTag = p.isBuiltin ? "" : ` · ${t("ai.action_custom_badge")}`;
    const displayName = selected?.id === p.id ? nameValue || p.name : p.name;
    return {
      value: p.id,
      label: `${displayName}${hiddenTag}${kindTag}${customTag}`,
    };
  });

  return (
    <div data-testid="ai-action-editor">
      {/* PresetList의 "노트 프리셋" 탭 헤더 행(label-caps + 복원 버튼)과 같은 문법. */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
        <div className="label-caps" style={{ color: "var(--muted)", flex: 1 }}>
          {t("ai.actions_section")}
        </div>
        {hasHidden && (
          <button
            type="button"
            onClick={() => void restoreHiddenBuiltins()}
            className="btn"
            style={{ padding: "3px 10px", fontSize: "var(--text-sm)" }}
          >
            {t("ai.action_restore_hidden")}
          </button>
        )}
      </div>

      {/* 프리셋 선택 + 추가/삭제가 한 줄. 예전엔 좌측 리스트가 이 역할을 하면서 세로 공간을
          통째로 먹었다. */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
        <Select
          value={selected?.id ?? ""}
          onChange={select}
          options={options}
          ariaLabel={t("ai.actions_section")}
          testid="ai-action-select"
          disabled={visible.length === 0}
          style={{ flex: 1, minWidth: 0 }}
        />
        {/* 새 항목의 종류 — "+" 바로 왼쪽에 둬서 무엇이 만들어질지 누르기 전에 보인다. */}
        <Select
          value={newKind}
          onChange={(v) => setNewKind(v as CustomAiActionKind)}
          options={CUSTOM_KINDS.map((k) => ({ value: k, label: t(`ai.action_kind_${k}`) }))}
          ariaLabel={t("ai.action_kind")}
          testid="ai-action-new-kind"
          // width:auto — Select 의 기본 폭(--settings-ctrl-w, 220px)을 그대로 두면 420px 모달에서 이 칸이
          // 줄을 다 먹고 정작 프리셋 선택 칸이 55px 로 눌렸다(2026-09-27 실측).
          style={{ flex: "none", width: "auto", minWidth: 120 }}
        />
        <button type="button" onClick={() => void onAdd()} title={t("ai.action_add")} aria-label={t("ai.action_add")} className="icon-btn">
          <IconPlus size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => void onDelete()}
          disabled={!selected}
          title={t("ai.action_delete")}
          aria-label={t("ai.action_delete")}
          className="icon-btn icon-btn--danger"
          style={{ opacity: selected ? 1 : 0.4 }}
        >
          <IconClose size={14} strokeWidth={2} />
        </button>
      </div>

      {selected ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
            <input
              ref={nameRef}
              value={nameValue}
              onChange={(e) => edit({ name: e.target.value })}
              onBlur={commit}
              placeholder={t("ai.action_name_placeholder")}
              aria-label={t("ai.action_name_placeholder")}
              className="field"
              style={{ flex: 1, minWidth: 0, fontWeight: 600 }}
            />
            <button
              type="button"
              onClick={() => void setHidden(selected.id, !selected.hidden)}
              title={selected.hidden ? t("ai.action_show") : t("ai.action_hide")}
              aria-label={selected.hidden ? t("ai.action_show") : t("ai.action_hide")}
              className="icon-btn"
              style={{ opacity: selected.hidden ? 0.5 : 1 }}
            >
              <IconEye size={14} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => void reorder(selected.id, "up")}
              disabled={selectedIndex === 0}
              title={t("ai.action_move_up")}
              aria-label={t("ai.action_move_up")}
              className="icon-btn"
              style={{ opacity: selectedIndex === 0 ? 0.4 : 1 }}
            >
              <IconArrowUp size={14} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => void reorder(selected.id, "down")}
              disabled={selectedIndex === items.length - 1}
              title={t("ai.action_move_down")}
              aria-label={t("ai.action_move_down")}
              className="icon-btn"
              style={{ opacity: selectedIndex === items.length - 1 ? 0.4 : 1 }}
            >
              <IconArrowDown size={14} strokeWidth={2} />
            </button>
          </div>

          {/* 대상(targets) 및 시작(blank) 배지 행 */}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", marginBottom: "var(--space-3)", flexWrap: "wrap" }}>
            {selected.blank && (
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  padding: "var(--space-2xs) var(--space-2)",
                  borderRadius: "var(--radius-xs)",
                  backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)",
                  color: "var(--accent)",
                  fontWeight: 600,
                }}
              >
                {t("ai.action_blank_badge")}
              </span>
            )}
            {selected.targets?.map((target) => (
              <span
                key={target}
                style={{
                  fontSize: "var(--text-xs)",
                  padding: "var(--space-2xs) var(--space-2)",
                  borderRadius: "var(--radius-xs)",
                  backgroundColor: "var(--hover)",
                  color: "var(--muted)",
                }}
              >
                {t(`ai.action_target_badge_${target}`)}
              </span>
            ))}
          </div>

          {/* tool 항목은 프롬프트가 아닌 전용 실행기이므로 읽기 전용 안내 상자 표시 */}
          {isTool ? (
            <div
              style={{
                padding: "var(--space-4)",
                borderRadius: "var(--radius-md)",
                backgroundColor: "var(--hover)",
                color: "var(--muted)",
                fontSize: "var(--text-sm)",
                lineHeight: "var(--lh-ui)",
              }}
            >
              {t("ai.action_tool_hint")}
            </div>
          ) : (
            <textarea
              value={promptValue}
              onChange={(e) => edit({ prompt: e.target.value })}
              onBlur={commit}
              rows={8}
              placeholder={isTemplate ? t("ai.template_body_placeholder") : t("ai.action_prompt_placeholder")}
              aria-label={isTemplate ? t("ai.template_body_placeholder") : t("ai.action_prompt_placeholder")}
              className="field"
              style={{ width: "100%", fontSize: "var(--text-sm)", fontFamily: "inherit", resize: "vertical" }}
            />
          )}

          {isTemplate && (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginTop: "var(--space-2)" }} data-testid="ai-action-template-hint">
              {t("ai.template_kind_hint")}
            </div>
          )}
          {selected.kind === "metadata" && (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginTop: "var(--space-2)" }}>
              {t("ai.action_metadata_guidance_hint")}
            </div>
          )}
          {selected.isBuiltin && (
            <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
              <button type="button" onClick={onReset} className="btn" style={{ padding: "3px 10px", fontSize: "var(--text-sm)" }}>
                {t("ai.action_reset_default")}
              </button>
            </div>
          )}
        </>
      ) : (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)", padding: "var(--space-3) 0" }}>
          {t("ai.action_none_selected")}
        </div>
      )}
    </div>
  );
}
