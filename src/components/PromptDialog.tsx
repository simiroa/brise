import React, { useEffect, useRef, useState } from "react";
import { ModalShell } from "./ModalShell";
import { IconCaret } from "./icons";
import { t } from "../i18n/t";

/**
 * Wave 7 (P29): shared replacement for window.prompt/confirm — a themed dialog built on
 * ModalShell so every "ask the user one thing" flow gets the same product-UI chrome
 * (radius, borders, accent) instead of a native browser popup.
 */
export type PromptDialogMode = "input" | "choice" | "confirm";

export interface PromptChoice {
  value: string;
  label: string;
  description?: string;
  /** Optional leading icon so the row reads as an actionable menu item. */
  icon?: React.ReactNode;
}

export interface PromptField {
  key: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
}

/**
 * Optional quick-action slot for "input" mode (e.g. footnote dialog's 번역/설명 buttons) — kept
 * generic so this shared dialog stays free of AI imports; callers own what `run` actually does.
 * The resolved string REPLACES the first field's value; a null/empty/rejected result leaves
 * whatever the user already typed untouched (quiet failure, never data loss).
 */
export interface PromptDialogAssistAction {
  key: string;
  label: string;
  run: (current: string) => Promise<string | null | undefined>;
}

export interface PromptDialogProps {
  title: string;
  description?: string;
  mode: PromptDialogMode;
  /** Convenience for a single-field "input" dialog. Ignored when `fields` is set. */
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  /** Multi-field "input" dialog (e.g. link url + name). */
  fields?: PromptField[];
  /** "choice" dialog options. */
  choices?: PromptChoice[];
  /** Optional "remember this" checkbox shown under choice options. */
  remember?: { label: string; defaultChecked?: boolean };
  confirmLabel?: string;
  cancelLabel?: string;
  /** Use --danger styling for the primary action (delete/replace flows). */
  danger?: boolean;
  /** "input" mode only — see PromptDialogAssistAction. */
  assistActions?: PromptDialogAssistAction[];
  width?: number | string;
  /**
   * "input": called with the single string value, or a field-keyed record when `fields` is used.
   * "choice": called with the chosen value, plus the remember-checkbox state when `remember` is set.
   * "confirm": called with an empty string — only the fact that it fired matters.
   */
  onSubmit: (value: string | Record<string, string>, remember?: boolean) => void;
  onCancel: () => void;
}



function autofocusRef(el: HTMLInputElement | HTMLTextAreaElement | null) {
  if (el) {
    el.focus();
    el.select();
  }
}

export function PromptDialog({
  title,
  description,
  mode,
  defaultValue = "",
  placeholder,
  multiline,
  fields,
  choices,
  remember,
  confirmLabel,
  cancelLabel,
  danger,
  assistActions,
  width = 420,
  onSubmit,
  onCancel,
}: PromptDialogProps) {
  const effectiveFields: PromptField[] =
    fields ?? (mode === "input" ? [{ key: "value", placeholder, defaultValue, multiline }] : []);

  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of effectiveFields) init[f.key] = f.defaultValue ?? "";
    return init;
  });
  const [rememberChecked, setRememberChecked] = useState(!!remember?.defaultChecked);
  // Which assist action (if any) is currently running — disables the others and swaps its label
  // for a busy marker. Only one at a time; the target field is always effectiveFields[0].
  const [assistBusyKey, setAssistBusyKey] = useState<string | null>(null);
  const assistTargetKey = effectiveFields[0]?.key ?? "value";

  const runAssistAction = async (action: PromptDialogAssistAction) => {
    if (assistBusyKey) return;
    setAssistBusyKey(action.key);
    try {
      const result = await action.run(values[assistTargetKey] ?? "");
      if (result != null && result.trim()) {
        setValues((v) => ({ ...v, [assistTargetKey]: result }));
      }
    } finally {
      setAssistBusyKey(null);
    }
  };
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  // Enter-to-confirm for "confirm" mode (no text field to attach a keydown handler to). Bug fix:
  // this used to fire onSubmit unconditionally, so a keyboard user who tabbed to Cancel and hit
  // Enter got BOTH the native button click (onCancel, correct) AND this listener's onSubmit
  // (wrong) — onSubmit racing/overriding the cancel. Skip when Cancel is focused and let its own
  // native Enter-click handle it; every other focus target (default open focus on ModalShell's
  // close X, or the Confirm button) still submits.
  useEffect(() => {
    if (mode !== "confirm") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (document.activeElement === cancelBtnRef.current) return;
      onSubmit("");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, onSubmit]);

  // 파괴적 확인(danger)은 **취소에 포커스를 두고 연다.**
  //
  // 위 keydown 은 "Cancel 이 포커스일 때만" Enter 를 넘긴다. 그런데 ModalShell 은 열릴 때 카드에
  // 포커스를 주므로(ModalShell.tsx: cardRef.current?.focus()), 기본 상태에서는 **아무 것도 치지
  // 않고 클릭도 없이 Enter 한 번**이 곧 확인이다. 네이티브 파일 다이얼로그를 Enter 로 닫은 직후
  // 그 키의 반복/후속 입력만으로 백업 복원(DB 통째 덮어쓰기)과 노트북 교체가 실행되는 것이
  // 2026-09-12 에 실제로 재현됐다.
  //
  // 위험하지 않은 확인은 Enter 로 넘기는 편의가 더 크므로 **danger 일 때만** 바꾼다. 호출부마다
  // 가드를 덧대지 않고 여기 한 곳에서 고치는 이유는, 그 사고가 복원 하나가 아니라 danger 확인
  // 전부에 열려 있었기 때문이다(CLAUDE.md 코드 방침).
  //
  // 자식(ModalShell)의 포커스 effect 가 먼저 돌고 이 effect 가 나중에 돌므로 여기가 이긴다.
  useEffect(() => {
    if (mode !== "confirm" || !danger) return;
    cancelBtnRef.current?.focus();
  }, [mode, danger]);

  const submitInput = () => {
    if (fields && fields.length > 0) onSubmit(values);
    else onSubmit(values["value"] ?? "");
  };

  const primaryBtnClass = danger ? "btn btn-danger" : "btn btn-primary";

  return (
    <ModalShell title={title} onClose={onCancel} width={width}>
      {description && (
        <p style={{ fontSize: "var(--text-md)", color: "var(--muted)", margin: "0 0 16px" }}>{description}</p>
      )}

      {mode === "input" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {effectiveFields.map((f, i) => (
            <div key={f.key}>
              {f.label && <label className="form-label">{f.label}</label>}
              {f.multiline ? (
                <textarea
                  ref={i === 0 ? autofocusRef : undefined}
                  value={values[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  rows={6}
                  className="field"
                  style={{
                    resize: "vertical",
                    fontFamily: "ui-monospace,Menlo,monospace",
                  }}
                />
              ) : (
                <input
                  ref={i === 0 ? autofocusRef : undefined}
                  value={values[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submitInput();
                    }
                  }}
                  className="field"
                />
              )}
            </div>
          ))}
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              justifyContent: assistActions?.length ? "space-between" : "flex-end",
              marginTop: 4,
            }}
          >
            {!!assistActions?.length && (
              <div style={{ display: "flex", gap: 6 }}>
                {assistActions.map((a) => (
                  <button
                    key={a.key}
                    type="button"
                    disabled={!!assistBusyKey}
                    onClick={() => void runAssistAction(a)}
                    className="btn"
                    style={{ padding: "var(--space-1) var(--space-3)", fontSize: "var(--text-md)" }}
                  >
                    {assistBusyKey === a.key ? "…" : a.label}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" onClick={onCancel} className="btn">
                {cancelLabel ?? t("common.cancel")}
              </button>
              <button type="button" onClick={submitInput} className={primaryBtnClass}>
                {confirmLabel ?? t("common.apply")}
              </button>
            </div>
          </div>
        </div>
      )}

      {mode === "choice" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(choices ?? []).map((c) => (
            // 행이 "누를 수 있는 항목"으로 읽히도록: 선행 아이콘 + 우측 chevron + 호버 시 accent 틴트.
            // 단일 표면이라 채움색이 아니라 테두리/틴트로 구분한다.
            // 호버/포커스는 .menu-row 가 CSS 에서 처리한다 (tokens.css 컴포넌트 레이어).
            <div
              key={c.value}
              className="menu-row"
              role="button"
              tabIndex={0}
              onClick={() => onSubmit(c.value, rememberChecked)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSubmit(c.value, rememberChecked);
                }
              }}
            >
              {c.icon && (
                <span
                  style={{
                    flex: "none",
                    width: 30,
                    height: 30,
                    display: "grid",
                    placeItems: "center",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--line)",
                    color: "var(--accent)",
                  }}
                >
                  {c.icon}
                </span>
              )}
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontSize: "var(--text-md)", fontWeight: 600, color: "var(--text)" }}>
                  {c.label}
                </span>
                {c.description && (
                  <span style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--muted)", marginTop: "var(--space-2xs)" }}>
                    {c.description}
                  </span>
                )}
              </span>
              <IconCaret
                dir="right"
                size={13}
                style={{ flex: "none", color: "var(--faint)" }}
              />
            </div>
          ))}
          {remember && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: "var(--text-md)",
                color: "var(--muted)",
                marginTop: 4,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={rememberChecked}
                onChange={(e) => setRememberChecked(e.target.checked)}
                style={{ accentColor: "var(--accent)" }}
              />
              {remember.label}
            </label>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" onClick={onCancel} className="btn">
              {cancelLabel ?? t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {mode === "confirm" && (
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
          <button type="button" ref={cancelBtnRef} onClick={onCancel} className="btn">
            {cancelLabel ?? t("common.cancel")}
          </button>
          <button type="button" onClick={() => onSubmit("")} className={primaryBtnClass}>
            {confirmLabel ?? t("common.apply")}
          </button>
        </div>
      )}
    </ModalShell>
  );
}
