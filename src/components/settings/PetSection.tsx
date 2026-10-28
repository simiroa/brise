import { useCallback, useEffect, useState } from "react";
import { SegmentedControl } from "../common/SegmentedControl";
import { groupCardStyle } from "./shared";
import { listenMany } from "../../lib/tauriListen";
import { call, callSilent } from "../../lib/invoke";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { SettingsRow } from "./SettingsRow";
import { PageLead } from "./PageLead";
import { Badge } from "./Badge";
import { SegGroup } from "./SegGroup";
import { Banner } from "./Banner";
import { Toggle } from "./Toggle";
import { PetSprite, type PetMood } from "../../plugins/pet/PetSprite";
import type { PetSnapshot } from "../../plugins/pet/petBehavior";
import type { PetPackage, PetPackagesListOutput } from "../../lib/commands.gen";
import { PetReactionSection } from "./pet/PetReactionSection";
import { PetPackageGallery } from "./pet/PetPackageGallery";
import { PetPositionPicker, type PetPos } from "./pet/PetPositionPicker";
import { PetPersonaSection } from "./PetPersonaSection";

/** 펫 페이지의 서브탭(2026-10-28, PLAN-2026-10-27 W6): 위쪽 라이브 미리보기는 탭과 무관하게 늘 보인다. */
type PetTab = "character" | "behavior" | "persona";

/**
 * 설정 > 펫 (PET.md §0.4 경계 · §0.6 재설계, 2026-10-16).
 *
 * 마스터 토글(첫 줄 설정 행) → 꺼져 있으면 한 줄 안내만. 켜져 있으면 트레이 경고(필요할 때) + 그룹 셋:
 * 캐릭터(큰 미리보기 + 갤러리 + 추가 메뉴) · 동작(더블클릭 + 페르소나 링크) · 화면 위치(미니맵).
 * 무드별 파일 표(PetAssetGrid)는 걷었다 — 저장된 `pet_assets` 는 펫 창이 계속 읽는다(휴면, §0.6-4).
 */

const MOODS: PetMood[] = ["idle", "happy", "alert"];

/** 미리보기는 상태 머신 없이 무드만 고른다 — 펫 창과 같은 애니메이션이 나오도록 정적 스냅샷. */
const PREVIEW_SNAPSHOT: Record<PetMood, PetSnapshot> = {
  idle: { activity: "resting", animation: "idle" },
  happy: { activity: "succeeded", animation: "jumping" },
  alert: { activity: "needs-attention", animation: "waiting" },
};

function readPos(settings: Record<string, unknown>): PetPos | null {
  // 부재는 "아직 옮긴 적 없음"(기본 위치) — Number(undefined) 는 NaN 이라 걸러진다.
  if (settings.pet_pos_x == null || settings.pet_pos_y == null) return null;
  const x = Number(settings.pet_pos_x);
  const y = Number(settings.pet_pos_y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function PetSection() {
  const closeToTray = useSettingsStore((s) => s.closeToTray);
  const setCloseToTray = useSettingsStore((s) => s.setCloseToTray);
  const [enabled, setEnabled] = useState(false);
  const [pos, setPos] = useState<PetPos | null>(null);
  const [mood, setMood] = useState<PetMood>("idle");
  const [packages, setPackages] = useState<PetPackage[]>([]);
  const [tab, setTab] = useState<PetTab>("character");

  // settings_get_all 은 여기서 한 번 읽어 내려준다. 펫을 드래그해 옮기는 사건은 이 창에 오지 않으므로
  // 창 포커스가 돌아올 때 다시 읽어 미니맵의 현재 위치를 맞춘다. callSilent 가 실패를 진단 로그에 남긴다.
  const loadSettings = useCallback(() => {
    void callSilent<{ settings: Record<string, unknown> }>("settings_get_all")
      .then((r) => {
        setEnabled(r.settings.pet_enabled === "1");
        setPos(readPos(r.settings));
      })
      .catch(() => {});
  }, []);

  const loadPackages = useCallback(() => {
    void callSilent<PetPackagesListOutput>("pet_packages_list", {})
      .then((r) => setPackages(r.items ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadSettings();
    loadPackages();
    window.addEventListener("focus", loadSettings);
    return () => window.removeEventListener("focus", loadSettings);
  }, [loadSettings, loadPackages]);

  useEffect(
    () =>
      listenMany([
        ["pet-packages-changed", loadPackages],
        ["pet-enabled-changed", (e: { payload: { enabled: boolean } }) => setEnabled(e.payload.enabled)],
      ]),
    [loadPackages],
  );

  const selectPackage = async (id: string) => {
    const previous = packages;
    const isDefault = id === "default" || id === "";
    setPackages((items) => items.map((item) => ({ ...item, selected: !isDefault && item.id === id })));
    try {
      await call("pet_package_select", { id: isDefault ? "default" : id });
      loadPackages();
    } catch {
      setPackages(previous);
    }
  };

  // 사용자가 누른 토글 — 실패하면 토스트가 필요하다(CLAUDE.md 함정 8) + 롤백(함정 9).
  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    try {
      await call("pet_set_enabled", { enabled: next });
    } catch {
      setEnabled(!next);
    }
  };

  const preview = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-3)" }}>
      {/* 실제 펫 창과 같은 컴포넌트 — 선택 패키지 > 휴면 무드 에셋 > 기본 SVG 순서도 그대로다. */}
      <div
        data-testid="settings-pet-preview-frame"
        style={{
          width: 184,
          height: 184,
          border: "1px solid var(--divider)",
          borderRadius: "var(--radius-md)",
          display: "grid",
          placeItems: "center",
          userSelect: "none",
          overflow: "hidden",
        }}
      >
        <PetSprite snapshot={PREVIEW_SNAPSHOT[mood]} />
      </div>
      {/* 표시 전용 — 무엇이 저장되지 않는다. */}
      <SegGroup
        value={mood}
        onChange={setMood}
        ariaLabel={t("settings.pet_mood_preview")}
        options={MOODS.map((m) => ({ value: m, label: t(`settings.pet_motion_${m}`) }))}
      />
    </div>
  );

  return (
    <>
      {/* 마스터 스위치는 페이지 첫 줄 설정 행(PLAN-2026-10-24 D4) — 꺼진 상태에서도 항상 보인다. */}
      <PageLead testId="settings-pet-master-card">
        <SettingsRow
          anchor="pet_enable"
          label={
            <>
              {t("settings.pet_enable")} <Badge>{t("settings.sync_beta_badge")}</Badge>
            </>
          }
          control={
            <Toggle
              checked={enabled}
              onChange={() => void toggle()}
              aria-label={t("settings.pet_enable")}
              data-testid="settings-pet-toggle"
            />
          }
        />
      </PageLead>
      {!enabled ? (
        <p data-testid="settings-pet-off-hint" style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--muted)" }}>
          {t("settings.pet_off_hint")}
        </p>
      ) : (
        <>
          {!closeToTray && (
            <Banner
              tone="danger"
              testId="settings-pet-needs-tray"
              actions={
                // setSimplePref 가 실패를 토스트·롤백한다 — 여기서 붙잡을 rejection 이 없다.
                <button
                  type="button"
                  className="btn"
                  data-testid="settings-pet-needs-tray-enable"
                  onClick={() => void setCloseToTray(true)}
                >
                  {t("settings.pet_enable_close_to_tray")}
                </button>
              }
            >
              {t("settings.pet_needs_tray")}
            </Banner>
          )}
          {/* 라이브 미리보기 — 서브탭 위에 고정. 캐릭터를 고르거나 위치·말투를 만지는 동안 계속 보인다. */}
          <div data-testid="settings-pet-preview-strip" className="settings-strip" style={{ padding: "var(--space-5)", display: "flex", justifyContent: "center" }}>
            {preview}
          </div>
          <SegmentedControl<PetTab>
            fill
            value={tab}
            onChange={setTab}
            ariaLabel={t("settings.pet_tabs_label")}
            options={[
              { value: "character", label: t("settings.pet_tab_character") },
              { value: "behavior", label: t("settings.pet_tab_behavior") },
              { value: "persona", label: t("settings.pet_tab_persona") },
            ]}
          />
          {tab === "character" && (
            <PetPackageGallery packages={packages} onSelect={selectPackage} onChanged={loadPackages} />
          )}
          {tab === "behavior" && (
            <>
              <PetReactionSection />
              <PetPositionPicker current={pos} onCurrentChange={setPos} />
            </>
          )}
          {tab === "persona" && (
            <div className="card" style={groupCardStyle} data-testid="settings-pet-persona-card">
              <PetPersonaSection />
            </div>
          )}
        </>
      )}
    </>
  );
}
