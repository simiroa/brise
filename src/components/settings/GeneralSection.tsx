import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { isEnabled, enable, disable } from "@tauri-apps/plugin-autostart";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { isBrowser } from "../../lib/env";
import { call, callSilent, emitNotice } from "../../lib/invoke";
import { reportFallback } from "../../lib/diag";
import type { DbStatsOutput } from "../../lib/commands.gen";
import { IconAction } from "./IconAction";
import { SettingsRow } from "./SettingsRow";
import { Select } from "../Select";
import {
  IconSettings,
  IconCalendar,
  IconNote,
  IconPaperclip,
  IconFolderOpen,
  IconRepeat,
} from "../icons";
import { ProductUpdateCard } from "./ProductUpdateCard";
import { SwitchGrid } from "./SwitchGrid";
import { MetricTileGroup } from "./MetricTileGroup";
import { NotificationsCard } from "./NotificationsCard";
import { FolderShortcutsCard } from "./FolderShortcutsCard";
import { SettingsCard } from "./SettingsCard";

interface GeneralSectionProps {
  onClose: () => void;
}

/**
 * 설정 > 일반 (PLAN-2026-09-12 §8 W2-ⓓ, 오너 결정 D3·D7·D9. 재편: 설정 리뷰 2026-09-13 / 2026-09-14 M3 디자인 시스템 개편).
 *
 * 1. 맨 위 제품·업데이트 카드(페이지 히어로는 PLAN-2026-10-24 D3 로 없앴다).
 * 2. 페이지 위 통계 띠: 3열 MetricTileGroup — 카드 밖(R1: 통계 띠는 박스에 넣지 않는다).
 * 3. 카드(`settings-app-behavior`): 앱 동작 — 언어 선택, SwitchGrid(시작/트레이/캡처; 한 열),
 *    화면 저장 폴더, 온보딩 다시 시작 행. 그 아래 알림 카드(NotificationsCard, 2026-10-27 이사).
 *    날짜·지역 제안과 원본 처리는 "에디터"(EditorSection)에 있다.
 *
 * PLAN-2026-10-24 D6·D7: 저장 공간 게이지와 "저장 및 백업" 카드는 "데이터 관리"(DataManagementSection)로,
 * AI 마스터 스위치는 "AI 제공자"(AiProviderSection) 첫 줄로 이사했다.
 *
 * 모든 블록은 프래그먼트의 직계 자식이다 — SettingsPanel 본문의 flex gap 이 블록 간격을 맡는다(R3).
 */
export function GeneralSection({ onClose }: GeneralSectionProps) {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const setUiLang = useSettingsStore((s) => s.setUiLang);
  const setOnboardingCompleted = useSettingsStore((s) => s.setOnboardingCompleted);
  const closeToTray = useSettingsStore((s) => s.closeToTray);
  const setCloseToTray = useSettingsStore((s) => s.setCloseToTray);

  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [captureScreenshot, setCaptureScreenshot] = useState(false);
  // 화면 저장 폴더 — "" = 기본(<사진>/Brise). 기본 경로 규칙의 SSOT 는 Rust
  // repo/screenshot.rs::capture_dir(DEFAULT_CAPTURE_SUBDIR) — 여기선 보여 주기만 같은 규칙으로 만든다.
  const [captureDir, setCaptureDir] = useState("");
  const [defaultCaptureDir, setDefaultCaptureDir] = useState<string | null>(null);
  const [stats, setStats] = useState<DbStatsOutput | null>(null);
  const browser = isBrowser();

  useEffect(() => {
    if (!browser) {
      void refreshAutostart();
      void callSilent<{ settings: Record<string, unknown> }>("settings_get_all")
        .then((r) => {
          setCaptureScreenshot((r.settings.capture_screenshot_enabled as string) === "1");
          setCaptureDir((r.settings.capture_screenshot_dir as string | undefined) ?? "");
        })
        .catch(() => {});
      void import("@tauri-apps/api/path")
        .then(async ({ pictureDir, join }) => setDefaultCaptureDir(await join(await pictureDir(), "Brise")))
        .catch((e: unknown) => reportFallback("capture", "picture_dir_unavailable", String(e)));
    }
  }, [browser]);

  useEffect(() => {
    void callSilent<DbStatsOutput>("db_stats")
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  // 화면 저장 토글·폴더는 둘 다 사용자 행동이라 같은 정책이다 — call() 이 실패 토스트를 띄우고,
  // 여기서는 화면만 이전 값으로 되돌린다(함정 9).
  const toggleCapture = async (next: boolean) => {
    const prev = captureScreenshot;
    setCaptureScreenshot(next);
    try {
      await call("settings_set", { entries: { capture_screenshot_enabled: next ? "1" : "0" } });
    } catch {
      setCaptureScreenshot(prev);
    }
  };

  const saveCaptureDir = async (next: string) => {
    const prev = captureDir;
    setCaptureDir(next);
    try {
      await call("settings_set", { entries: { capture_screenshot_dir: next } });
    } catch {
      setCaptureDir(prev); // call() 이 이미 토스트를 띄웠다 — 화면만 되돌린다.
    }
  };

  const pickCaptureDir = async () => {
    if (browser) return;
    let picked: string | string[] | null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      picked = await open({ directory: true, multiple: false, defaultPath: captureDir || defaultCaptureDir || undefined });
    } catch (e) {
      reportFallback("capture", "folder_dialog_failed", String(e));
      return;
    }
    if (!picked || Array.isArray(picked)) return;
    await saveCaptureDir(picked);
  };

  // 자동 실행은 IPC 가 아니라 플러그인이라 call() 의 토스트·진단 기록을 거치지 않는다 — 그 둘을
  // 여기서 직접 한다. 조회 실패는 선택적 표시값이라 기록만 남기고 토글은 꺼짐으로 둔다.
  async function refreshAutostart() {
    try {
      setAutostartEnabled(await isEnabled());
    } catch (e) {
      reportFallback("autostart", "is_enabled_failed", String(e));
    }
  }

  const handleAutostartToggle = async (checked: boolean) => {
    if (browser) return;
    try {
      if (checked) await enable();
      else await disable();
      setAutostartEnabled(checked);
    } catch (e) {
      reportFallback("autostart", checked ? "enable_failed" : "disable_failed", String(e));
      emitNotice(t("settings.autostart_failed"));
      // 실패 뒤의 실제 상태는 OS 에 다시 묻는다(반쯤 바뀌었을 수도 있다).
      void refreshAutostart();
    }
  };

  return (
    <>
      {/* 히어로 — 제품·업데이트 카드(PLAN-2026-10-24 D2): 이름·버전·업데이트·변경 로그·자동 확인. 첫 페이지라 통계 띠보다 위(PLAN-2026-10-27 §1). */}
      <ProductUpdateCard />

      {/* 1. 저장소 통계 — 오너 규칙 R1(2026-09-15 QA): 통계 띠는 카드에 넣지 않고
          페이지 최상위 형제로 세운다. 저장 공간 게이지는 데이터 관리로 갔다(PLAN-2026-10-24 D6). */}
      <MetricTileGroup
        testId="settings-storage-stats"
        tiles={[
          {
            id: "days",
            icon: <IconCalendar size={16} />,
            value: stats?.distinct_note_days ?? 0,
            label: t("settings.stat_days"),
          },
          {
            id: "notes",
            icon: <IconNote size={16} />,
            value: stats?.note_count ?? 0,
            label: t("settings.stat_notes"),
          },
          {
            id: "attachments",
            icon: <IconPaperclip size={16} />,
            value: stats?.attachment_count ?? 0,
            label: t("settings.stat_attachments"),
          },
        ]}
      />

      {/* 앱 동작 — 언어 · 토글 2열 격자(시작/트레이/캡처) · 온보딩. 브라우저(태블릿)에는
          데스크톱 전용 셋의 대응물이 없어 격자가 통째로 빠진다. */}
      <SettingsCard title={t("settings.app_behavior")} icon={<IconSettings size={14} strokeWidth={2} />} testId="settings-app-behavior">

        <SettingsRow
          anchor="ui_language"
          label={t("settings.ui_language")}
          hint={t("settings.general_lang_hint")}
          control={
            <Select
              value={uiLang}
              onChange={(v) => void setUiLang(v)}
              ariaLabel={t("settings.ui_language")}
              options={[
                { value: "en", label: "English" },
                { value: "ko", label: "한국어" },
                { value: "fr", label: "Français" },
              ]}
            />
          }
        />

        {!browser && (
          // 선은 영역 경계(카드·SubGroup)에만 긋는다 — 격자는 다른 행들처럼 여백으로 갈린다(D2).
          <SwitchGrid
            aria-label={t("settings.app_behavior")}
           
            items={[
              {
                id: "autostart",
                anchor: "autostart",
                label: t("settings.autostart"),
                hint: t("settings.autostart_hint"),
                checked: autostartEnabled,
                onChange: (next: boolean) => void handleAutostartToggle(next),
              },
              {
                id: "close-to-tray",
                anchor: "close_to_tray",
                label: t("settings.close_to_tray"),
                hint: t("settings.close_to_tray_hint"),
                checked: closeToTray,
                onChange: (next: boolean) => void setCloseToTray(next),
              },
              {
                id: "capture-screenshot",
                anchor: "capture_screenshot",
                label: t("settings.pet_capture_screenshot"),
                hint: t("settings.pet_capture_screenshot_hint"),
                checked: captureScreenshot,
                onChange: (next: boolean) => void toggleCapture(next),
              },
            ]}
          />
        )}

        {/* 화면 저장 폴더 — 트레이(=펫 우클릭) "화면 저장"은 펫이 꺼져 있어도 여기로 파일을 남긴다
            (docs/CAPTURE.md). 토글이 꺼져 있으면 의미가 없으므로 켰을 때만 보인다. */}
        {!browser && captureScreenshot ? (
          <SettingsRow
            label={t("settings.capture_dir")}
            hint={captureDir || t("settings.capture_dir_default", { path: defaultCaptureDir ?? "Brise" })}
            data-testid="settings-capture-dir"
            control={
              <div style={{ display: "flex", gap: "var(--space-1)" }}>
                {captureDir ? (
                  <IconAction
                    icon={<IconRepeat size={16} />}
                    label={t("settings.capture_dir_reset")}
                    onClick={() => void saveCaptureDir("")}
                    data-testid="settings-capture-dir-reset"
                  />
                ) : null}
                <IconAction
                  icon={<IconFolderOpen size={16} />}
                  label={t("settings.capture_dir_change")}
                  onClick={() => void pickCaptureDir()}
                  data-testid="settings-capture-dir-change"
                />
              </div>
            }
          />
        ) : null}

        {/* 2026-09-20 — 날짜 자동등록(date_nudge_auto)·지역 제안 엄격도(region_nudge_strict)·
            파일 드롭 원본 처리(source_original_policy) 세 행은 오너 요청("일반-에디터 페이지
            신설해서, 날짜 자동등록, 지역 제한, 드롭 정책 등 관련 내용을 모으는 게 좋아 보임")으로
            설정 > 에디터(EditorSection.tsx)로 옮겼다 — 일반 탭엔 더는 없다. */}

        {/* 아이콘만으로는 "무엇을 다시 하는지"가 안 읽혀서 글자 버튼이다. */}
        <SettingsRow
          anchor="onboarding"
          label={t("onboarding.title")}
          data-testid="settings-onboarding"
          control={
            <button
              type="button"
              className="btn"
              data-testid="settings-restart-onboarding"
              onClick={() => {
                onClose();
                void setOnboardingCompleted(false);
                // PLAN-2026-09-28-onboarding-rebuild.md §4 — 설정 창은 별도 OS 웹뷰라 이 창의
                // onboardingCompleted 변화만으로는 본 창의 "이번 실행에서 닫음" 세션 플래그가
                // 안 풀린다(값이 이미 false였던 경우 스토어 리로드로도 재렌더가 안 난다). 본 창이
                // 같은 창(브라우저/태블릿 인앱 오버레이)일 때는 window 이벤트가, 별도 OS 창일 때는
                // Tauri 이벤트 버스가 닿는다 — App.tsx 가 둘 다 듣는다(온보딩 세션 스토어 restart). 둘 다 무해하게
                // 실패할 수 있어(테스트 환경, 해당 안 되는 창) 그냥 둘 다 쏜다.
                window.dispatchEvent(new Event("onboarding-restart-requested"));
                // silent-ok: fails only with no Tauri runtime to ride (tests, or the browser/tablet overlay the window event above already covers).
                void emit("onboarding-restart-requested").catch(() => {});
              }}
            >
              {t("settings.restart_onboarding")}
            </button>
          }
        />
      </SettingsCard>

      {/* 알림 — 앱 동작 아래(PLAN-2026-10-27). 달력 및 일정 페이지에서 이사. */}
      <NotificationsCard />

      {/* 폴더 바로가기 — 데스크톱 전용(열기 커맨드가 http:false). 위치 변경은 데이터 관리 > 저장 및 백업. */}
      {!browser && <FolderShortcutsCard />}
    </>
  );
}
