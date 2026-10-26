import React, { useEffect, useRef, useState } from "react";
import { ModalShell } from "./ModalShell";
import { AiAgentReviewModal } from "./AiAgentReviewModal";
import { call, callSilent, emitNotice } from "../lib/invoke";


import type { NoteQueryOutput, NoteSummary } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { useNotesStore, displayTitle } from "../stores/notes";
import { useUiStore } from "../stores/ui";
import { useSettingsStore } from "../stores/settings";
import { setFolderColor } from "../lib/noteActions";
import { generateFolderOrganizePlan } from "../stores/aiAgentActions";
import type { AiPlan } from "../lib/aiAgentBridge";
import { folderColorCss, FOLDER_PRESET_HUES } from "../lib/ui";
import { Toggle } from "./settings/Toggle";
import { IconGrid, IconPickerPopover } from "./IconPicker";
import { IconCheckMark, IconFolder, IconHelp } from "./icons";
import { noteIconComp } from "../lib/noteIcons";
import { NoteIcon } from "./leftpanel/NoteIconControl";
import "./FolderOrganizeModal.css";
import { AiBatchOrganizeModal } from "../lazySurfaces";
import { preloadIntentProps } from "../lib/lazyPreload";

/**
 * 설명 한 줄을 "?" 뒤로 숨긴다 — 스위치 세 개 밑에 문단이 깔리면 왼쪽 열이 오른쪽 노트 상자보다
 * 훨씬 길어져 두 단이 어긋나 보인다. 툴팁은 네이티브 `title` 이다(이 코드베이스의 기존 방식 —
 * settings/SmsParseSection · AiCapabilityCatalog 도 같은 IconHelp + title 조합을 쓴다).
 */
function HelpDot({ text }: { text: string }) {
  return (
    <span className="folder-organize-help icon-glow" role="img" aria-label={text} title={text}>
      <IconHelp size={13} strokeWidth={2} aria-hidden />
    </span>
  );
}

/**
 * 폴더 설정 — 2단. 왼쪽은 폴더 자신의 속성(정체성 한 줄 · 제외 · 규칙), 오른쪽은 이 폴더의
 * 노트 목록과 그 목록에 거는 AI 동작. 예전엔 한 단에 세로로 다 쌓여서 노트 목록이 스크롤
 * 바닥에 파묻혔고 AI 버튼은 목록에서 멀리 떨어진 푸터에 있었다 — 고르는 곳과 실행하는 곳이
 * 붙어 있어야 "골라서 정리한다"가 한눈에 읽힌다. 그래서 푸터를 없애고 버튼을 목록 밑으로 옮겼다.
 *
 * 이름·아이콘·색은 세 칸이 아니라 한 줄이다: 셋 다 "이 폴더가 트리에서 어떻게 보이는가" 하나를
 * 말하고, 아이콘 버튼이 이미 현재 색으로 칠해져 미리보기 역할을 한다. 그래서 아이콘 버튼 하나가
 * 색·아이콘 팝오버를 함께 연다(라벨 대신 aria-label — 한 줄에 라벨 세 개를 놓을 자리가 없다).
 */
export function FolderOrganizeModal() {
  const folderId = useUiStore((s) => s.folderFilesOpen);
  const close = useUiStore((s) => s.closeFolderFiles);
  const folders = useNotesStore((s) => s.folders);
  const inboxId = useNotesStore((s) => s.inboxId);
  const loadTree = useNotesStore((s) => s.loadTree);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const folder = folders.find((item) => item.id === folderId) ?? null;
  const isInbox = Boolean(folderId && inboxId && folderId === inboxId);

  const [name, setName] = useState("");
  const [rules, setRules] = useState("");
  const [searchExcluded, setSearchExcluded] = useState(false);
  const [aiExcluded, setAiExcluded] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const iconBtnRef = useRef<HTMLButtonElement>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchIds, setBatchIds] = useState<string[] | null>(null);
  const [plan, setPlan] = useState<AiPlan | null>(null);
  const [planning, setPlanning] = useState(false);

  useEffect(() => {
    if (!folderId) return;
    const current = useNotesStore.getState().folders.find((item) => item.id === folderId);
    if (!current) return;
    setName(current.name);
    setRules(current.rules ?? "");
    setSearchExcluded(current.search_excluded);
    setAiExcluded(current.ai_excluded);
    setIconOpen(false);
    setSelected(new Set());
    void callSilent<NoteQueryOutput>("note_query", { folder_ids: [current.id], sort: "updated_desc", limit: 200 })
      .then((res) => setNotes(res.notes))
      .catch((e) => emitNotice(t("folderOrganize.load_failed", { msg: String(e?.message ?? e) })));
  }, [folderId]);

  if (!folderId || !folder) return null;

  const saveName = async () => {
    if (isInbox) return;
    const next = name.trim();
    if (!next || next === folder.name) return;
    try {
      await call("folder_rename", { id: folder.id, name: next });
      await loadTree();
    } catch (e: unknown) {
      emitNotice(t("folderOrganize.save_failed", { msg: String((e as { message?: string })?.message ?? e) }));
    }
  };

  const saveRules = async () => {
    const next = rules.trim() || null;
    if ((folder.rules ?? "") === (next ?? "")) return;
    try {
      await call("folder_set_rules", { id: folder.id, rules: next });
      await loadTree();
    } catch (e: unknown) {
      emitNotice(t("folderOrganize.save_failed", { msg: String((e as { message?: string })?.message ?? e) }));
    }
  };

  // NewFolderDialog lets you pick a folder icon at creation time, but until this existed there was
  // no way to change it afterwards — folder_set_icon had zero callers. Same IconGrid (lucide keys
  // only, no emoji tab) as the creation dialog, so both entry points offer the identical palette
  // and every folder-glyph render site (tree row, FolderBadge, FolderDotFilter) keeps working off
  // noteIconComp unchanged.
  const saveIcon = async (next: string | null) => {
    setIconOpen(false);
    if ((folder.icon ?? null) === next) return;
    try {
      await call("folder_set_icon", { id: folder.id, icon: next });
      await loadTree();
    } catch (e: unknown) {
      emitNotice(t("folderOrganize.save_failed", { msg: String((e as { message?: string })?.message ?? e) }));
    }
  };

  // Single call carries both booleans — toggling one still sends the other's current value.
  const saveExclusions = async (nextSearchExcluded: boolean, nextAiExcluded: boolean) => {
    if (folder.search_excluded === nextSearchExcluded && folder.ai_excluded === nextAiExcluded) return;
    try {
      await call("folder_set_exclusions", {
        id: folder.id,
        search_excluded: nextSearchExcluded,
        ai_excluded: nextAiExcluded,
      });
      await loadTree();
    } catch (e: unknown) {
      emitNotice(t("folderOrganize.save_failed", { msg: String((e as { message?: string })?.message ?? e) }));
    }
  };

  const toggle = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = notes.length > 0 && notes.every((note) => selected.has(note.id));
  const folderDisplayName = isInbox ? t("tree.inbox") : folder.name;
  const Glyph = noteIconComp(folder.icon, IconFolder);
  const aiBlockedTitle = folder.ai_excluded ? t("folderOrganize.ai_excluded_disabled_tooltip") : undefined;
  // 규칙은 AI 만 읽는 지시문이다 — AI 읽기 금지면 아무도 읽지 않으므로 편집을 잠근다. 값은
  // 건드리지 않는다(disabled 는 입력만 막고 state 는 그대로): 금지를 껐을 때 예전 규칙이
  // 그 자리에 되돌아와야 한다.
  const rulesLocked = !isInbox && aiExcluded;

  return (
    <>
      <ModalShell
        title={isInbox ? `${t("tree.inbox")} — ${t("ctx.folder_organize")}` : t("ctx.folder_organize")}
        onClose={close}
        // 700 = 좌 278(고정) + 간격 18 + 노트 쪽 360 + 카드 좌우 여백 44. 왼쪽은 자기가 담는
        // 것(이름칸·스위치 두 줄·규칙 상자)에 맞춰 278 에서 멈추고, 늘어난 폭은 전부 노트
        // 쪽으로 간다 — 목록과 버튼 두 개가 사는 곳이라 넓을수록 낫다.
        width={700}
      >
        <div className="folder-organize-grid">
          <div className="folder-organize-main">
            <div className="folder-organize-identity">
              <button
                ref={iconBtnRef}
                type="button"
                className="icon-swatch"
                aria-expanded={iconOpen}
                aria-label={t("tree.folder_icon")}
                title={`${t("tree.folder_icon")} · ${t("folderOrganize.color")}`}
                data-testid="folder-icon-toggle"
                onClick={() => setIconOpen((o) => !o)}
                style={{ color: folder.color_hue != null ? folderColorCss(folder.color_hue) : "var(--accent)" }}
              >
                <Glyph size={18} strokeWidth={1.7} />
              </button>
              <input
                className="field"
                aria-label={t("folderOrganize.name")}
                value={isInbox ? t("tree.inbox") : name}
                disabled={isInbox}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void saveName()}
                onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
              />
            </div>

            {/* 노트 한 줄의 아이콘 메뉴와 같은 껍데기(IconPickerPopover) — 같은 종류의 선택은
                같은 모양으로 뜬다. 색은 폴더에만 있으므로 격자 위 한 줄로 얹는다. */}
            {iconOpen && iconBtnRef.current && (
              <IconPickerPopover
                anchorRect={iconBtnRef.current.getBoundingClientRect()}
                onClose={() => setIconOpen(false)}
                ignoreRef={iconBtnRef}
              >
                <div className="folder-organize-swatches">
                  <button
                    type="button"
                    className="folder-organize-swatch"
                    data-on={folder.color_hue == null ? "true" : undefined}
                    aria-label={t("folderOrganize.color_reset")}
                    onClick={() => void setFolderColor(folder.id, null)}
                  />
                  {FOLDER_PRESET_HUES.map((hue) => (
                    <button
                      key={hue}
                      type="button"
                      className="folder-organize-swatch"
                      data-on={folder.color_hue === hue ? "true" : undefined}
                      aria-label={`${hue}`}
                      style={{ background: folderColorCss(hue) }}
                      onClick={() => void setFolderColor(folder.id, hue)}
                    />
                  ))}
                </div>
                <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                  <IconGrid value={folder.icon} defaultComp={IconFolder} onPick={(key) => void saveIcon(key)} />
                </div>
              </IconPickerPopover>
            )}

            {/* 제외 스위치가 규칙보다 위에 온다 — AI 읽기 금지는 바로 아래 규칙 편집기를 잠그는
                스위치라, 잠긴 결과를 보기 전에 원인이 먼저 읽혀야 한다. */}
            {/* 라벨과 스위치를 행마다 space-between 으로 벌리면 열 폭이 커질수록 둘이 멀어져
                어느 스위치가 어느 라벨의 것인지 눈으로 이어야 했다. 두 줄을 한 그리드로 묶어
                라벨 열을 max-content 로 두면, 스위치가 **가장 긴 라벨 바로 뒤**에 서로 맞춰
                선다 — 로케일마다 라벨 길이가 달라도 매직 넘버 없이 성립한다. */}
            {!isInbox && (
              <div className="folder-organize-switches">
                <span className="folder-organize-field-label">
                  {t("folderOrganize.search_excluded")}
                  <HelpDot text={t("folderOrganize.search_excluded_hint")} />
                </span>
                <Toggle
                  checked={searchExcluded}
                  onChange={(next) => {
                    setSearchExcluded(next);
                    void saveExclusions(next, aiExcluded);
                  }}
                  aria-label={t("folderOrganize.search_excluded")}
                  data-testid="folder-search-excluded-toggle"
                />
                <span className="folder-organize-field-label">
                  {t("folderOrganize.ai_excluded")}
                  <HelpDot text={t("folderOrganize.ai_excluded_hint")} />
                </span>
                <Toggle
                  checked={aiExcluded}
                  onChange={(next) => {
                    setAiExcluded(next);
                    void saveExclusions(searchExcluded, next);
                  }}
                  aria-label={t("folderOrganize.ai_excluded")}
                  data-testid="folder-ai-excluded-toggle"
                />
              </div>
            )}

            <label className="folder-organize-label">
              <span className="folder-organize-field-label">
                {t("folderOrganize.rules")}
                <HelpDot text={t("folderOrganize.rules_hint")} />
              </span>
              <textarea
                className="field"
                rows={4}
                value={rules}
                disabled={rulesLocked}
                onChange={(e) => setRules(e.target.value)}
                onBlur={() => void saveRules()}
                placeholder={t("folderOrganize.rules_hint")}
                data-testid="folder-rules"
                style={{
                  resize: "vertical",
                  minHeight: 88,
                  padding: "8px 10px",
                  height: "auto",
                  opacity: rulesLocked ? "var(--dim-disabled)" : undefined,
                }}
              />
              {rulesLocked && <span className="folder-organize-hint">{t("folderOrganize.rules_locked")}</span>}
            </label>
          </div>

          <aside className="folder-organize-notes-pane">
            <div className="folder-organize-pane-head">
              <span>{t("folderOrganize.notes")} {notes.length}</span>
              {notes.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setSelected(allSelected ? new Set() : new Set(notes.map((note) => note.id)))}
                >
                  {allSelected ? t("folderOrganize.select_none") : t("folderOrganize.select_all")}
                </button>
              )}
            </div>
            {notes.length === 0 ? (
              <p className="folder-organize-hint folder-organize-notes">{t("folderOrganize.empty")}</p>
            ) : (
              // 체크박스 대신 앱의 다른 목록과 같은 행 모양(아이콘 + 이름)을 쓴다 — 행을
              // 누르면 선택된다. 선택 표시도 트리와 같은 규칙을 따른다: 아이콘 자리가 체크마크로
              // 바뀌고(형태 축) 행에 `data-selected` 가 붙어 tokens.css 의 선택 배경을 받는다.
              <ul className="folder-organize-notes">
                {notes.map((note) => {
                  const picked = selected.has(note.id);
                  return (
                    <li key={note.id}>
                      <button
                        type="button"
                        className="menu-row menu-item"
                        aria-pressed={picked}
                        data-selected={picked ? "true" : undefined}
                        onClick={() => toggle(note.id)}
                      >
                        {picked ? (
                          <IconCheckMark
                            size={15}
                            strokeWidth={1.8}
                            aria-hidden
                            style={{ color: "var(--accent)", flex: "none" }}
                          />
                        ) : (
                          <NoteIcon icon={note.icon} size={15} />
                        )}
                        <span>{displayTitle(note.title)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="folder-organize-actions">
              <button
                type="button"
                className="btn"
                disabled={selected.size === 0 || !aiEnabled || folder.ai_excluded}
                title={aiBlockedTitle}
                onClick={() => setBatchIds([...selected])}
                {...preloadIntentProps(AiBatchOrganizeModal)}
              >
                {t("folderOrganize.batch_organize")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!aiEnabled || planning || notes.length === 0 || folder.ai_excluded}
                title={aiBlockedTitle}
                onClick={() => {
                  setPlanning(true);
                  void generateFolderOrganizePlan(folder.id, folderDisplayName)
                    .then((next) => {
                      if (next) setPlan(next);
                      else emitNotice(t("ctx.folder_empty"));
                    })
                    // noteQueryCollect 내부 invoke 실패는 lib/invoke 의 call 이 이미 토스트를 띄운 뒤
                    // 재throw 한다 — 여기선 그 rejection 이 미처리로 새지 않게 삼키기만 한다
                    // (finally 는 rejection 을 붙잡지 않으므로 catch 가 따로 필요하다).
                    .catch(() => {})
                    .finally(() => setPlanning(false));
                }}
              >
                {t("folderOrganize.batch_plan")}
              </button>
            </div>
          </aside>
        </div>
      </ModalShell>
      {batchIds && (
        <React.Suspense fallback={null}>
          <AiBatchOrganizeModal noteIds={batchIds} onClose={() => setBatchIds(null)} />
        </React.Suspense>
      )}
      {plan && <AiAgentReviewModal plan={plan} onClose={() => setPlan(null)} />}
    </>
  );
}
