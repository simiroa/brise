import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { IconShield } from "../icons";
import { SettingsCard } from "./SettingsCard";

/** stores/settings.ts::setCollectExcludedDomains 가 자르는 상한과 같은 값 — 넘친 줄은 저장되지 않는다. */
const MAX_DOMAINS = 200;

function normalize(text: string): string[] {
  return text
    .split("\n")
    .map((d) => d.trim().replace(/^\.+/, "").toLowerCase())
    .filter(Boolean);
}

/**
 * 설정 > 수집 > 제외할 도메인 — 크롬 History 가져오기·클리핑·링크 붙여넣기가 읽는
 * `collect_excluded_domains`(collect::urlfilter::host_excluded). PLAN-2026-09-14 D5: 지우지 않는다.
 * 수집 경로의 규칙이라 수집 페이지 맨 아래에 산다(오너 결정).
 *
 * 저장은 blur 에서. 스토어(setSimplePref)가 실패를 토스트하고 값을 되돌리는데, 그 되돌림이 입력 중인
 * 초안을 덮지 않게 **고친 적 있는 초안은 저장이 확인될 때까지 스토어에서 다시 채우지 않는다**.
 */
export function ExcludedDomainsSection() {
  const excludedDomains = useSettingsStore((st) => st.collectExcludedDomains);
  const setExcludedDomains = useSettingsStore((st) => st.setCollectExcludedDomains);
  const [draft, setDraft] = useState(() => excludedDomains.join("\n"));
  const dirty = useRef(false);
  // 상한을 넘어 저장하지 못한 줄 수(0 이면 안내 없음).
  const [dropped, setDropped] = useState(0);
  // 접힘이 기본 — 쓰는 사람이 드물고, 열어 보기 전엔 무엇을 거르는지 요약 한 줄이면 충분하다(PLAN-2026-10-27 §1).
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!dirty.current) setDraft(excludedDomains.join("\n"));
  }, [excludedDomains]);

  const saveExcluded = async () => {
    if (!dirty.current) return;
    const domains = normalize(draft);
    const kept = domains.slice(0, MAX_DOMAINS);
    setDropped(domains.length - kept.length);
    // setSimplePref 는 실패해도 throw 하지 않는다(토스트 + 롤백) — 저장됐는지는 스토어 값으로 확인한다.
    await setExcludedDomains(kept);
    const saved = useSettingsStore.getState().collectExcludedDomains;
    if (saved.join("\n") === kept.join("\n")) {
      dirty.current = false;
      setDraft(kept.join("\n"));
    }
  };

  return (
    <SettingsCard
      title={t("settings.collect_excluded_section")}
      hint={t("settings.collect_excluded_scope_hint")}
      icon={<IconShield size={14} strokeWidth={2} />}
      actions={
        <button
          type="button"
          className="btn"
          aria-expanded={open}
          data-testid="settings-collect-excluded-toggle"
          onClick={() => setOpen((v) => !v)}
        >
            {open ? t("settings.collect_excluded_collapse") : t("settings.collect_excluded_expand")}
          </button>
        }
        anchor="excluded_domains"
        testId="settings-collect-excluded"
      >
      {!open && (
        <div data-testid="settings-collect-excluded-summary" style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>
          {excludedDomains.length
            ? t("settings.collect_excluded_summary", { n: excludedDomains.length })
            : t("settings.collect_excluded_summary_none")}
        </div>
      )}
      {open && (
      <textarea
        value={draft}
        onChange={(e) => {
          dirty.current = true;
          setDraft(e.target.value);
        }}
        onBlur={() => void saveExcluded()}
        rows={3}
        className="field"
        placeholder={t("settings.collect_excluded_placeholder")}
        aria-label={t("settings.collect_excluded_domains_label")}
        style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", resize: "vertical" }}
      />
      )}
      {open && (
      <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginTop: "var(--space-1)" }}>
        {t("settings.collect_excluded_domains_hint")} {t("settings.collect_excluded_cap_hint", { n: MAX_DOMAINS })}
      </div>
      )}
      {open && dropped > 0 && (
        <div
          role="status"
          data-testid="settings-collect-excluded-dropped"
          style={{ fontSize: "var(--text-xs)", color: "var(--warn)", marginTop: "var(--space-1)" }}
        >
          {t("settings.collect_excluded_dropped", { n: dropped, max: MAX_DOMAINS })}
        </div>
      )}
    </SettingsCard>
  );
}
