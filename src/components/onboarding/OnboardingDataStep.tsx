import React, { useEffect, useState } from "react";
import { t } from "../../i18n/t";
import { call, callSilent } from "../../lib/invoke";
import { useSettingsStore, type AttachmentStorageMode } from "../../stores/settings";
import { useOnboardingSession } from "../../stores/onboardingSession";
import { formatSize } from "../../lib/ui";
import { Select } from "../Select";
import { StorageGauge } from "../settings/StorageGauge";
import { IconFolder, IconFile, IconPaperclip, IconSettings, IconInfo } from "../icons";
import type { DataLocationGetOutput, DataLocationInspectOutput } from "../../lib/commands.gen";

/** 데이터 관리 쪽 + 설정 "저장 위치" 카드가 함께 쓰는 조회 훅 — 중복 구현하지 않는다. */
export function useDataLocation() {
  const [current, setCurrent] = useState<DataLocationGetOutput | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = () => {
    setLoading(true);
    void callSilent<DataLocationGetOutput>("data_location_get")
      .then(setCurrent)
      .catch(() => setCurrent(null))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { current, loading, reload };
}

/** 경로 가운데를 생략 — 앞/뒤 조각은 남기고 중간만 "…"로 접는다(긴 클라우드 경로 대응). */
function ellipsizeMiddle(path: string, max = 42): string {
  if (path.length <= max) return path;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}

/** 드라이브 여유 공간 바 — 온보딩 데이터 쪽과 설정 "저장 위치 변경" 확인창이 같은 부품을 쓴다
 * (재구현하지 않는다, 오너 지시). free/total 조회 실패(권한 없는 경로 등)면 바 없이 숫자만. */
export function DataSpaceBar({
  freeBytes,
  totalBytes,
  currentBytes,
  testId,
}: {
  freeBytes: number | null;
  totalBytes: number | null;
  currentBytes: number;
  testId?: string;
}) {
  return (
    <StorageGauge
      testId={testId ?? "onboarding-data-space-bar"}
      usedBytes={currentBytes}
      totalBytes={totalBytes ?? 0}
      breakdownText={t("onboarding.data_space_label")}
      ratioText={
        totalBytes != null && freeBytes != null
          ? t("onboarding.data_space_caption", {
              free: formatSize(freeBytes),
              total: formatSize(totalBytes),
              current: formatSize(currentBytes),
            })
          : t("onboarding.data_space_unknown")
      }
    />
  );
}

function ContentItem({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="ob-contents-item">
      <span>{icon}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </div>
  );
}

/**
 * 설정 4쪽(테마 다음) "데이터 관리" — PLAN-2026-09-28-onboarding-rebuild.md §6 D1~D5. 여기서는
 * 폴더를 고르고 점검(data_location_inspect)만 한다 — 실제 이동은 요약 화면 "내 노트 시작하기"에서
 * 한 번(D4, OnboardingWizard.finishWithNewNote). 골라 둔 위치는 stores/onboardingSession.ts
 * pendingDataPath 에 초안으로 남는다.
 */
export function OnboardingDataStep() {
  const attachmentStorageMode = useSettingsStore((s) => s.attachmentStorageMode);
  const setAttachmentStorageMode = useSettingsStore((s) => s.setAttachmentStorageMode);
  const pendingDataPath = useOnboardingSession((s) => s.pendingDataPath);
  const setPendingDataPath = useOnboardingSession((s) => s.setPendingDataPath);
  const { current } = useDataLocation();
  // 지금 위치의 드라이브 여유 공간 — 폴더를 고르기 전에도 바가 보여야 한다. 점검은 후보 폴더를
  // 고를 때만 부르던 탓에 처음엔 항상 "확인할 수 없어요"였다(has_existing_data 등은 쓰지 않는다).
  const [baseInspection, setBaseInspection] = useState<DataLocationInspectOutput | null>(null);
  const currentRoot = current?.root;
  useEffect(() => {
    if (!currentRoot) return;
    void callSilent<DataLocationInspectOutput>("data_location_inspect", { path: currentRoot })
      .then(setBaseInspection)
      .catch(() => setBaseInspection(null));
  }, [currentRoot]);

  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<DataLocationInspectOutput | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);

  // 뒤로 갔다 다시 왔을 때 이미 골라 둔 폴더가 있으면 점검 결과를 다시 보여준다.
  useEffect(() => {
    if (pendingDataPath) void inspectPath(pendingDataPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inspectPath = async (path: string) => {
    setInspecting(true);
    setInspectError(null);
    try {
      const insp = await call<DataLocationInspectOutput>("data_location_inspect", { path });
      if (!insp.writable) {
        setInspectError(t("onboarding.data_error_not_writable"));
        setInspection(null);
        setPendingDataPath(null);
        return;
      }
      if (insp.has_existing_data) {
        setInspectError(t("onboarding.data_error_existing_data"));
        setInspection(null);
        setPendingDataPath(null);
        return;
      }
      setInspection(insp);
      setPendingDataPath(path);
    } catch {
      // call() 이 이미 에러 토스트를 띄웠다 — 여기서는 선택을 되돌리기만 한다.
      setInspection(null);
      setPendingDataPath(null);
    } finally {
      setInspecting(false);
    }
  };

  const pickFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false });
      if (!picked || Array.isArray(picked)) return;
      await inspectPath(picked);
    } catch {
      // silent-ok: dialog plugin unavailable outside Tauri (browser/tablet tab) — same
      // convention as AttachmentStorageSection.pickSoffice.
    }
  };

  const displayPath = pendingDataPath ?? current?.root ?? "";
  const cloudProvider = inspection?.cloud_provider ?? null;
  const isSplit = pendingDataPath ? !!cloudProvider : (current?.split ?? false);
  const spaceInsp = inspection ?? baseInspection;
  const currentBytes = spaceInsp?.current_data_bytes ?? 0;

  return (
    <div className="ob-page">
      <div>
        <h2 className="ob-title">{t("onboarding.data_heading")}</h2>
        <p className="ob-sub">{t("onboarding.data_desc")}</p>
      </div>

      <div className="ob-group">
        <label className="ob-label">{t("onboarding.data_location_label")}</label>
        {/* 폴더 · 경로 · "폴더 변경" 이 테두리 하나 안에 — 버튼은 오른쪽 안쪽. */}
        <div className="ob-inline-row">
          <IconFolder size={16} />
          <span className="ob-inline-text" data-testid="onboarding-data-path" title={displayPath}>
            {displayPath ? ellipsizeMiddle(displayPath) : t("common.loading")}
          </span>
          <button
            type="button"
            className="btn ob-btn-inline"
            onClick={() => void pickFolder()}
            disabled={inspecting}
            data-testid="onboarding-data-pick"
          >
            {t("onboarding.data_pick_folder")}
          </button>
        </div>

        {inspectError && (
          <p data-testid="onboarding-data-error" className="ob-hint ob-hint--warn">
            {inspectError}
          </p>
        )}

        <DataSpaceBar
          freeBytes={spaceInsp?.free_bytes ?? null}
          totalBytes={spaceInsp?.total_bytes ?? null}
          currentBytes={currentBytes}
        />

        {isSplit && cloudProvider && (
          <p data-testid="onboarding-data-cloud-note" className="ob-hint">
            {t("onboarding.data_cloud_split_note", { provider: cloudProvider })}
          </p>
        )}
      </div>

      <div className="ob-contents" data-testid="onboarding-data-contents">
        <ContentItem icon={<IconFile size={14} />} label={isSplit ? t("onboarding.data_item_notes_local") : t("onboarding.data_item_notes")} />
        <ContentItem icon={<IconPaperclip size={14} />} label={t("onboarding.data_item_attachments")} />
        <ContentItem icon={<IconSettings size={14} />} label={t("onboarding.data_item_settings")} />
      </div>

      <div className="ob-group">
        <label className="ob-label">{t("settings.attachment_storage_mode")}</label>
        <Select
          value={attachmentStorageMode}
          onChange={(v) => void setAttachmentStorageMode(v as AttachmentStorageMode)}
          ariaLabel={t("settings.attachment_storage_mode")}
          options={[
            { value: "copy", label: t("settings.attachment_storage_mode_copy") },
            { value: "link", label: t("settings.attachment_storage_mode_link") },
            { value: "reference", label: t("settings.attachment_storage_mode_reference") },
          ]}
        />
        <p className={attachmentStorageMode === "reference" ? "ob-hint ob-hint--warn" : "ob-hint"}>
          {attachmentStorageMode === "reference"
            ? t("settings.attachment_storage_mode_reference_warn")
            : t("settings.attachment_storage_mode_hint")}
        </p>
      </div>

      <div className="ob-callout">
        <IconInfo size={16} />
        <span>{t("onboarding.data_change_later_hint")}</span>
      </div>
    </div>
  );
}
