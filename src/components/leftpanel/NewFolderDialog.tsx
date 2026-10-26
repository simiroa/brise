import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ModalShell } from "../ModalShell";
import { IconGrid } from "../IconPicker";
import { FolderColorPresets } from "./FolderColorPresets";
import { IconFolder } from "../icons";
import { noteIconComp } from "../../lib/noteIcons";
import { folderColorCss } from "../../lib/ui";
import { useDismiss } from "../../lib/ui";
import { beginLongPress, cancelLongPress, consumeLongPress } from "../../lib/longPress";
import { t } from "../../i18n/t";

const FOLDER_RULES_CAP = 4096;

/**
 * 새 폴더 — 이름만이 아니라 트리에 보일 정체성(아이콘·색)을 만들 때 고른다.
 * 한 줄 상단 바: [글리프] [이름 입력] [아이콘 picker 토글]. 아이콘 그리드는 클릭 또는
 * 400ms 롱프레스(트리 NoteIconControl 패턴 차용)로 화면에 떠 있는 anchor 의 오른쪽에
 * 팝오버로 펼쳐진다 — 모달 안에 인라인으로 끼워 넣지 않으므로 한 줄 바가 짧게 유지된다.
 * AI 활성 시 폴더 메모(rules)도 함께 입력 — 백엔드 folder_create 한 번에 저장, AI 정리 시
 * 상속되는 지침(prompts::merge_organize_guidance 참고).
 */
export function NewFolderDialog({
  aiEnabled = false,
  onCancel,
  onSubmit,
}: {
  aiEnabled?: boolean;
  onCancel: () => void;
  onSubmit: (value: {
    name: string;
    icon: string | null;
    colorHue: number | null;
    rules: string | null;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [colorHue, setColorHue] = useState<number | null>(null);
  const [rules, setRules] = useState("");
  const [iconPicker, setIconPicker] = useState<{ top: number; left: number } | null>(null);

  const iconBtnRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const Glyph = noteIconComp(icon, IconFolder);
  const glyphColor = colorHue != null ? folderColorCss(colorHue) : "var(--accent)";
  const previewName = name.trim() || t("tree.new_folder_default");
  const trimmedRules = rules.trim();
  const rulesOver = trimmedRules.length > FOLDER_RULES_CAP;

  const togglePicker = useCallback(() => {
    if (iconPicker) {
      setIconPicker(null);
      return;
    }
    const el = iconBtnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = 312;
    const H = 260;
    const left = Math.min(r.right + 6, window.innerWidth - W - 12);
    const top = Math.max(12, Math.min(r.top, window.innerHeight - H - 12));
    setIconPicker({ top, left });
  }, [iconPicker]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || rulesOver) return;
    onSubmit({
      name: trimmed,
      icon,
      colorHue,
      rules: trimmedRules ? trimmedRules : null,
    });
  };

  useDismiss(iconPicker != null, [pickerRef, iconBtnRef], () => setIconPicker(null));

  return (
    <ModalShell
      title={t("tree.new_folder_title")}
      onClose={onCancel}
      width={400}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button type="button" className="btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="new-folder-submit"
            disabled={!name.trim() || rulesOver}
            onClick={submit}
          >
            {t("tree.new_folder_submit")}
          </button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <div
          data-testid="new-folder-preview"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            padding: "var(--space-2) var(--space-3)",
            border: "1px solid var(--divider)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          <Glyph size={16} strokeWidth={1.8} style={{ color: glyphColor, flex: "none" }} />
          <input
            className="field"
            data-testid="new-folder-name"
            value={name}
            placeholder={previewName}
            autoFocus
            style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", padding: 0 }}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            ref={iconBtnRef}
            type="button"
            className="icon-swatch"
            aria-expanded={iconPicker != null}
            aria-label={t("tree.folder_icon")}
            data-testid="new-folder-icon-toggle"
            onPointerDown={() =>
              beginLongPress(() => {
                const el = iconBtnRef.current;
                if (!el) return;
                const r = el.getBoundingClientRect();
                const W = 312;
                const H = 260;
                const left = Math.min(r.right + 6, window.innerWidth - W - 12);
                const top = Math.max(12, Math.min(r.top, window.innerHeight - H - 12));
                setIconPicker({ top, left });
              })
            }
            onPointerUp={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onPointerLeave={cancelLongPress}
            onPointerMove={cancelLongPress}
            onClick={(e) => {
              if (consumeLongPress()) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              togglePicker();
            }}
            style={{ flex: "none" }}
          >
            <Glyph size={16} strokeWidth={1.8} style={{ color: glyphColor }} />
          </button>
        </div>

        {iconPicker &&
          createPortal(
            <div
              ref={pickerRef}
              // 표면은 `.overlay` 가 소유한다(다른 팝오버 — ContextMenu·NoteIconControl 과 같은
              // 규칙). 예전엔 정의된 적 없는 --bg-elev 를 인라인으로 칠하고 있어서 폴백인 --bg
              // (본문 캔버스 배경)가 그려졌고, 아크릴 프리셋에서 유리가 되지 못했다.
              className="overlay"
              role="dialog"
              aria-label={t("tree.folder_icon")}
              style={{
                position: "fixed",
                top: iconPicker.top,
                left: iconPicker.left,
                width: 312,
                maxHeight: 260,
                zIndex: "var(--z-modal)",
                padding: "10px",
                border: "2px solid var(--divider)",
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-lg)",
              }}
            >
              <IconGrid
                value={icon}
                defaultComp={IconFolder}
                onPick={(key) => {
                  setIcon(key);
                  setIconPicker(null);
                }}
              />
            </div>,
            document.body
          )}

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>
            {t("tree.folder_color")}
          </span>
          <FolderColorPresets value={colorHue} onPick={setColorHue} />
        </div>

        {aiEnabled && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>
              {t("tree.new_folder_rules")}
            </span>
            <textarea
              className="field"
              data-testid="new-folder-rules"
              value={rules}
              placeholder={t("tree.new_folder_rules_ph")}
              rows={3}
              style={{ resize: "vertical", minHeight: 60, fontFamily: "inherit" }}
              onChange={(e) => setRules(e.target.value)}
            />
            <span
              style={{
                fontSize: "var(--text-xs)",
                color: rulesOver ? "var(--danger, #d44)" : "var(--muted)",
              }}
            >
              {t("tree.new_folder_rules_help")} ({trimmedRules.length}/{FOLDER_RULES_CAP})
            </span>
          </div>
        )}
      </div>
    </ModalShell>
  );
}