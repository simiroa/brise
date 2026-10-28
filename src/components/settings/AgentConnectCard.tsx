import { useState } from "react";
import { call, emitNotice } from "../../lib/invoke";
import { copyWithNotice } from "../../lib/clipboard";
import type { AgentSkillInstallOutput } from "../../lib/commands.gen";
import { t } from "../../i18n/t";
import { SettingsRow } from "./SettingsRow";
import { IconAction } from "./IconAction";
import { IconCopy, IconSparkles } from "../icons";
import { SettingsCard } from "./SettingsCard";

/**
 * 설정 > 연결 — 외부 에이전트(Claude Code 등) 연결. MCP 서버는 동기화 서버(위 카드)가 켜져 있어야 동작하므로
 * "켜기"는 새 스위치가 아니라 그 서버다(docs/CLI.md §7). 여기서는 스킬 파일을 에이전트 폴더에 깔고,
 * 앱에 번들된 CLI 경로·데이터 폴더가 박힌 MCP 등록 명령을 보여 준다. 노트는 SQLite 안에 있어 에이전트의
 * "작업 폴더"로 지정할 노트북 폴더는 없다 — 노트는 MCP 도구로만 다룬다.
 */
export function AgentConnectCard() {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<AgentSkillInstallOutput | null>(null);

  const install = async () => {
    setBusy(true);
    try {
      const r = await call<AgentSkillInstallOutput>("agent_skill_install");
      setInfo(r);
      emitNotice(t("settings.agent_installed"));
    } catch {
      // call() 이 이미 오류 토스트를 띄웠다 — 설치 결과 표시만 비워 둔다.
      setInfo(null);
    } finally {
      setBusy(false);
    }
  };

  const copy = (value: string) =>
    copyWithNotice(value, t("settings.sync_value_copied", { label: t("settings.agent_command_label") }));

  return (
    <SettingsCard title={t("settings.agent_title")} icon={<IconSparkles size={14} strokeWidth={2} />} testId="agent-connect-card">
      <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)", padding: "var(--space-2) 0", lineHeight: 1.5 }}>
        {t("settings.agent_desc")}
      </div>
      <SettingsRow
        label={t("settings.agent_install_label")}
        hint={t("settings.agent_install_hint")}
        control={
          <button type="button" className="btn" disabled={busy} onClick={() => void install()} data-testid="agent-skill-install">
            {t("settings.agent_install_btn")}
          </button>
        }
      />
      {info && (
        <div data-testid="agent-install-result" style={{ marginTop: "var(--space-3)" }}>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", lineHeight: 1.6 }}>
            {t("settings.agent_register_step")}
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <code
              data-testid="agent-mcp-command"
              style={{ flex: 1, minWidth: 0, fontSize: "var(--text-xs)", wordBreak: "break-all", userSelect: "text" }}
            >
              {info.mcp_command}
            </code>
            <IconAction
              icon={<IconCopy size={14} />}
              label={t("iconActions.copy_value", { label: t("settings.agent_command_label") })}
              size="sm"
              data-testid="agent-mcp-command-copy"
              onClick={() => void copy(info.mcp_command)}
            />
          </div>
        </div>
      )}
    </SettingsCard>
  );
}
