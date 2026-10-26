import { useState, type CSSProperties } from "react";
import { ModalShell } from "./ModalShell";
import { t } from "../i18n/t";

/**
 * 새 노트북 만들기 (docs/PLAN-2026-09-19-notebook-settings.md §7 Q4, 오너 결정 2026-09-19).
 *
 * 노트북마다 설정이 따로다 — 모양·언어·달력까지. 그래서 만드는 순간에 **무엇이 노트북을 따라가고
 * 무엇이 앱 전체에 남는지**를 보여 주고, 설정의 출발점을 고르게 한다:
 *   - 기본값으로 시작(기본) — 오너 원칙 "새 노트북은 기본값".
 *   - 현재 노트북의 설정 복사 — 노트는 복사되지 않는다(노트까지 같게 하려면 복제).
 *
 * 두 목록은 Rust `settings_schema::NOTEBOOK_KEYS` 의 묶음을 사람 말로 옮긴 것이다. 키를 옮기면
 * 여기 문구(workspace.new_scope_*)도 맞춘다.
 */
export function NewNotebookModal({
  currentName,
  onCreate,
  onClose,
}: {
  /** 복사 원본으로 보여 줄 현재 노트북 이름. 없으면 복사 선택지를 숨긴다. */
  currentName: string | null;
  onCreate: (name: string, copyCurrentSettings: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [copy, setCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();

  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onCreate(trimmed, copy);
      onClose();
    } catch {
      // call() 이 이미 토스트를 띄웠다 — 창은 열어 두어 다시 시도할 수 있게 한다.
      setBusy(false);
    }
  };

  // 키를 통째로 적는다 — check:i18n 이 문자열 리터럴로 사용처를 찾는다.
  const perNotebook = [
    "workspace.new_scope_appearance",
    "workspace.new_scope_language",
    "workspace.new_scope_calendar",
    "workspace.new_scope_editing",
    "workspace.new_scope_ai",
  ];
  const appWide = [
    "workspace.new_scope_ai_connection",
    "workspace.new_scope_notifications",
    "workspace.new_scope_backup_sync",
    "workspace.new_scope_pet_collect",
    "workspace.new_scope_window",
  ];

  return (
    <ModalShell
      title={t("workspace.new_title")}
      onClose={onClose}
      width={480}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)", width: "100%" }}>
          <button type="button" className="btn" onClick={onClose} data-testid="new-notebook-cancel">
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!trimmed || busy}
            onClick={() => void submit()}
            data-testid="new-notebook-create"
          >
            {t("workspace.new_create")}
          </button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
        <input
          autoFocus
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder={t("workspace.new_workspace_placeholder")}
          aria-label={t("workspace.new_workspace_placeholder")}
          data-testid="new-notebook-name"
        />

        <fieldset style={fieldset}>
          <legend style={legend}>{t("workspace.new_settings_start")}</legend>
          <label style={radioRow}>
            <input
              type="radio"
              name="new-notebook-settings"
              checked={!copy}
              onChange={() => setCopy(false)}
              data-testid="new-notebook-defaults"
            />
            <span>
              {t("workspace.new_start_defaults")}
              <span style={hint}>{t("workspace.new_start_defaults_hint")}</span>
            </span>
          </label>
          {currentName !== null && (
            <label style={radioRow}>
              <input
                type="radio"
                name="new-notebook-settings"
                checked={copy}
                onChange={() => setCopy(true)}
                data-testid="new-notebook-copy"
              />
              <span>
                {t("workspace.new_start_copy", { name: currentName })}
                <span style={hint}>{t("workspace.new_start_copy_hint")}</span>
              </span>
            </label>
          )}
        </fieldset>

        <div style={scopeGrid} data-testid="new-notebook-scope">
          <ScopeList title={t("workspace.new_scope_notebook")} items={perNotebook.map((k) => t(k))} />
          <ScopeList title={t("workspace.new_scope_app")} items={appWide.map((k) => t(k))} />
        </div>
      </div>
    </ModalShell>
  );
}

function ScopeList({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={legend}>{title}</div>
      <ul style={scopeList}>
        {items.map((it) => (
          <li key={it}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

const fieldset: CSSProperties = {
  border: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const legend: CSSProperties = {
  padding: 0,
  marginBottom: "var(--space-2)",
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  color: "var(--text)",
};

const radioRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--space-2)",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
  cursor: "pointer",
};

const hint: CSSProperties = {
  display: "block",
  marginTop: "var(--space-1)",
  fontSize: "var(--text-xs)",
  color: "var(--muted)",
};

const scopeGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: "var(--space-4)",
  paddingTop: "var(--space-4)",
  borderTop: "1px solid var(--divider)",
};

const scopeList: CSSProperties = {
  margin: 0,
  paddingLeft: "var(--space-5)",
  fontSize: "var(--text-xs)",
  color: "var(--muted)",
  lineHeight: "var(--lh-ui)",
};
