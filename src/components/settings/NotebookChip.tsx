import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { t } from "../../i18n/t";
import { callSilent, emitNotice } from "../../lib/invoke";
import { useDismiss } from "../../lib/ui";
import { IconCaret, IconWorkspace as WsDefaultIcon } from "../icons";
import { noteIconComp } from "../../lib/noteIcons";
import { FluidHoverHighlight, useFluidHover } from "../common/FluidHover";
import "../../styles/workspace-switcher.css";

type Notebook = { id: string; name: string; icon?: string | null; note_count?: number };

/**
 * 설정 창 헤더의 노트북 칩 — 이름을 보여주고 눌러서 다른 노트북으로 바꾼다. 메인 창 WorkspaceSwitcher 와
 * 같은 모양(.ws-trigger 칩 · .wsitem 행 · 아이콘 · 노트 수 · FluidHover)을 같은 CSS 로 쓴다 — 편집 기능(이름 변경·
 * 배경·복제·삭제)은 스토어에 묶인 메인 창 몫이라 여기엔 없다.
 * 전환은 본 창이 맡는다: 설정 창은 노트북 스토어(트리·탭·노트)를 들이지 않으므로 TestDataSection 과 같은
 * "workspaces-changed" { activate } 한 관문으로 요청하고(두 번째 구현 금지), 본 창의 switchTo 가 flush·탭 리셋·
 * 트리 재로드를 한다. 설정 창은 settings-changed 메아리로 새 노트북의 값을 다시 읽는다.
 */
export function NotebookChip({
  name,
  icon,
  activeId,
  disabled,
  block,
}: {
  name: string;
  /** 활성 노트북의 아이콘 키(useActiveNotebook 이 이미 읽은 값) — 칩을 열기 전에도 트리거 아이콘이 맞게 한다. */
  icon?: string | null;
  activeId: string | null;
  /** 저장 중(settingsBusy)에는 노트북을 바꾸지 않는다 — 쓰는 도중 대상이 바뀌면 안 된다. */
  disabled?: boolean;
  /** 레일 칸을 가득 채운다(사이드바 상단 배치) — 아니면 내용 폭의 칩. */
  block?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Notebook[]>([]);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const hover = useFluidHover(menuRef, { axis: "y" });

  // 열 때마다 목록을 다시 읽는다 — 다른 창에서 만들거나 지운 노트북이 바로 보이게.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void callSilent<{ workspaces: Notebook[] }>("workspace_list") // = 노트북
      .then((r) => alive && r?.workspaces && setList(r.workspaces))
      .catch(() => {
        // silent-ok: 목록을 못 읽으면 빈 드롭다운 — callSilent 가 이미 진단 로그에 남겼다.
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // 바깥 클릭·Escape — 앱 공용 훅(오버레이 스택에 올라 AuxWindowChrome 의 "Escape 로 창 닫기"보다 먼저 이 드롭다운이 닫힌다).
  useDismiss(open, [boxRef], () => setOpen(false));

  const pick = (nb: Notebook) => {
    setOpen(false);
    if (nb.id === activeId) return;
    // emit 은 Tauri 밖(테스트·브라우저)에선 거절한다 — 본 창 전환만 놓친다.
    void emit("workspaces-changed", { activate: nb.id }).catch(() => {
      // silent-ok: 이벤트 버스가 없는 환경 — 알림도 띄우지 않는다.
    });
    emitNotice(t("workspace.scope_switched", { name: nb.name }));
  };

  return (
    <div ref={boxRef} style={{ position: "relative", minWidth: 0, ...(block ? { flex: 1 } : null) }}>
      <button
        type="button"
        className="ws-trigger"
        data-testid="settings-scope-chip"
        data-scope="notebook"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("workspace.scope_label", { name })}
        title={t("workspace.scope_switch_label")}
        onClick={() => setOpen((o) => !o)}
        style={{
          ...(block ? { width: "100%", minWidth: 0 } : { width: "auto", minWidth: 140, maxWidth: 300 }),
          cursor: disabled ? "default" : "pointer",
        }}
      >
        {(() => {
          // 연 적이 있으면 그 목록의 값(다른 창에서 바꾼 아이콘이 반영된다), 아니면 헤더가 이미 읽어 온 값.
          const fromList = list.find((n) => n.id === activeId);
          const WsIcon = noteIconComp(fromList ? fromList.icon : icon, WsDefaultIcon);
          return <WsIcon size={16} strokeWidth={2} style={{ flex: "none" }} />;
        })()}
        <span className="ws-trigger-name" style={{ fontSize: "var(--text-md)" }}>
          {name}
        </span>
        <IconCaret dir={open ? "up" : "down"} size={15} style={{ flex: "none", color: "var(--muted)" }} />
      </button>
      {open && (
        <div
          ref={menuRef}
          className="overlay fh-host"
          role="listbox"
          aria-label={t("workspace.scope_switch_label")}
          {...hover.handlers}
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            minWidth: "100%",
            marginTop: 4,
            zIndex: "var(--z-dropdown)",
            border: "1px solid var(--divider)",
            boxShadow: "var(--shadow-lg)",
            maxHeight: 280,
            overflowY: "auto",
          }}
        >
          <FluidHoverHighlight hover={hover} />
          {list.map((nb) => {
            const isActive = nb.id === activeId;
            const RowIcon = noteIconComp(nb.icon, WsDefaultIcon);
            return (
              <button
                key={nb.id}
                type="button"
                role="option"
                aria-selected={isActive}
                data-testid={`settings-notebook-option-${nb.id}`}
                className="wsitem menu-row menu-item"
                data-selected={isActive}
                onClick={() => pick(nb)}
                style={{ gap: "var(--space-3)", padding: "var(--space-2) var(--space-4)", whiteSpace: "nowrap" }}
              >
                <RowIcon size={16} strokeWidth={1.9} style={{ flex: "none", color: isActive ? "var(--accent)" : "var(--muted)" }} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    fontSize: "var(--text-md)",
                    ...(isActive ? { fontWeight: 600 } : {}),
                    color: isActive ? "var(--accent)" : "var(--text)",
                  }}
                >
                  {nb.name}
                </span>
                {nb.note_count != null && (
                  <span style={{ fontSize: "var(--text-label)", color: "var(--faint)", flex: "none" }}>
                    {t("tree.n_notes", { n: nb.note_count })}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
