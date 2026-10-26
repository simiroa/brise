import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { isBrowser } from "../../lib/env";
import { t } from "../../i18n/t";
import { groupCardStyle } from "./shared";
import { SectionHeader } from "./SectionHeader";
import { SettingsRow } from "./SettingsRow";
import { Select } from "../Select";
import { IconFolderOpen, IconPaperclip } from "../icons";
import { IconAction } from "./IconAction";

/**
 * 첨부 저장 방식.
 *
 * 이 설정은 드래그앤드롭 첨부를 포함한 모든 첨부 적재 경로의 정책이고, 수집 경로는 항상 보관소를 쓰므로 수집 탭에 있을 이유가 없다.
 *
 * 카드 하나만 그린다 — 데이터 관리 페이지의 히어로와 카드 순서는 DataManagementSection 이 쥔다.
 */
export function AttachmentStorageSection() {
  const attachmentStorageMode = useSettingsStore((s) => s.attachmentStorageMode);
  const setAttachmentStorageMode = useSettingsStore((s) => s.setAttachmentStorageMode);
  const slidePreview = useSettingsStore((s) => s.slidePreview);
  const setSlidePreview = useSettingsStore((s) => s.setSlidePreview);
  const sofficePath = useSettingsStore((s) => s.sofficePath);
  const setSofficePath = useSettingsStore((s) => s.setSofficePath);
  const [pathDraft, setPathDraft] = useState(sofficePath);
  useEffect(() => setPathDraft(sofficePath), [sofficePath]);
  const browser = isBrowser();

  const pickSoffice = async () => {
    if (browser) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ multiple: false, directory: false });
      if (!picked || Array.isArray(picked)) return;
      setPathDraft(picked);
      void setSofficePath(picked);
    } catch {
      /* dialog unavailable outside Tauri — DataManagementSection 과 같은 관례 */
    }
  };

  return (
    <div className="card" style={groupCardStyle} data-testid="settings-attachment-storage">
      <SectionHeader
        title={t("settings.attachment_storage_section")}
        icon={<IconPaperclip size={14} strokeWidth={2} />}
      />

      <SettingsRow
        anchor="attachment_storage_mode"
        label={t("settings.attachment_storage_mode")}
        hint={
          attachmentStorageMode === "reference"
            ? t("settings.attachment_storage_mode_reference_warn")
            : t("settings.attachment_storage_mode_hint")
        }
        control={
          <Select
            value={attachmentStorageMode}
            onChange={(v) => void setAttachmentStorageMode(v as any)}
            ariaLabel={t("settings.attachment_storage_mode")}
            options={[
              { value: "copy", label: t("settings.attachment_storage_mode_copy") },
              { value: "link", label: t("settings.attachment_storage_mode_link") },
              { value: "reference", label: t("settings.attachment_storage_mode_reference") },
            ]}
          />
        }
      />

      {/* pptx 는 LibreOffice 가 있을 때만 슬라이드 그대로 보인다 — 없으면 조용히 텍스트로 폴백. */}
      <SettingsRow
        anchor="slide_preview"
        label={t("settings.slide_preview")}
        hint={t("settings.slide_preview_hint")}
        control={
          <Select
            value={slidePreview}
            onChange={(v) => void setSlidePreview(v as "auto" | "off")}
            ariaLabel={t("settings.slide_preview")}
            options={[
              { value: "auto", label: t("settings.slide_preview_auto") },
              { value: "off", label: t("settings.slide_preview_off") },
            ]}
          />
        }
      />
      <SettingsRow
        anchor="soffice_path"
        label={t("settings.soffice_path")}
        hint={t("settings.soffice_path_hint")}
        disabled={slidePreview === "off"}
        disabledReason={t("settings.slide_preview_off")}
        control={
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
            <input
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              // 키 입력마다 IPC 를 쏘지 않는다 — SyncSection 의 sync_port 와 같은 형태.
              onBlur={() => { if (pathDraft !== sofficePath) void setSofficePath(pathDraft.trim()); }}
              placeholder={t("settings.soffice_path_placeholder")}
              aria-label={t("settings.soffice_path")}
              className="field"
              style={{ width: 200 }}
            />
            {/* F9(PLAN-2026-09-15): 손 타이핑만이면 오타를 pptx 를 열 때야 안다 — 옆 카드들과
                같은 plugin-dialog 피커를 연다. 브라우저 탭엔 피커가 없다. */}
            <IconAction
              icon={<IconFolderOpen size={16} />}
              label={t("settings.soffice_browse")}
              titleOverride={browser ? t("common.desktop_only") : undefined}
              size="lg"
              disabled={browser}
              onClick={() => void pickSoffice()}
              data-testid="settings-soffice-browse"
            />
          </div>
        }
      />
    </div>
  );
}
