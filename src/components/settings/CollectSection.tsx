import { useCallback, useEffect, useRef, useState } from "react";
import { call, callSilent, emitNotice } from "../../lib/invoke";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { SectionHeader } from "./SectionHeader";
import { MetricTileGroup } from "./MetricTileGroup";
import { Toggle } from "./Toggle";
import { Badge } from "./Badge";
import { SettingsRow } from "./SettingsRow";
import { groupCardStyle } from "./shared";
import { SettingsTable } from "./SettingsTable";
import { IconActivity, IconCalendar, IconCalendarDays, IconFileImport, IconPlus, IconRefresh, IconSearch } from "../icons";
import { anchorId, useSettingsAnchorOnce } from "./settingsAnchor";
import { IconAction } from "./IconAction";
import { PromptDialog } from "../PromptDialog";
import type {
  CollectSource,
  CollectSourceListOutput,
  CollectSourceRunNowOutput,
  CollectSourceDryRunOutput,
  CollectGetStatsOutput,
} from "../../lib/commands.gen";
import { ensureYtdlp } from "./collect/ensureYtdlp";
import { useLocalImport } from "./collect/useLocalImport";
import { LocalImportPanel } from "./collect/LocalImportPanel";
import { useCollectSourceForm } from "./collect/useCollectSourceForm";
import { CollectSourceFormModal } from "./collect/CollectSourceFormModal";
import { CollectSourceRow } from "./collect/CollectSourceRow";
import { CollectDryRunModal, type DryRunPreview } from "./collect/CollectDryRunModal";
import { ExcludedDomainsSection } from "./ExcludedDomainsSection";

export function CollectSection() {
  // 언어가 바뀌면 이 페이지의 t() 문구를 다시 그리도록 구독만 해 둔다(t() 는 스토어를 반응형으로 읽지 않는다).
  useSettingsStore((s) => s.uiLang);

  const collectPausedUntil = useSettingsStore((s) => s.collectPausedUntil);
  const setCollectPausedUntil = useSettingsStore((s) => s.setCollectPausedUntil);
  const setCollectDetectSeen = useSettingsStore((s) => s.setCollectDetectSeen);
  const setCollectDetectPending = useSettingsStore((s) => s.setCollectDetectPending);
  const paused = collectPausedUntil.trim().length > 0;
  const setCollectEnabled = (enabled: boolean) => {
    if (enabled) {
      void setCollectPausedUntil("");
    } else {
      // far-future timestamp = paused indefinitely (backend collect_paused_until contract, see
      // find_due — anything > now is treated as paused, there is no separate boolean flag).
      void setCollectPausedUntil("2099-12-31T23:59:59+00:00");
    }
  };

  // null = 아직 읽는 중. 읽기 실패(loadFailed)와 진짜 빈 목록을 "소스 없음" 하나로 뭉개지 않는다.
  const [sources, setSources] = useState<CollectSource[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [stats, setStats] = useState<CollectGetStatsOutput | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [dryRunningId, setDryRunningId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CollectSource | null>(null);

  const [confirmBusy, setConfirmBusy] = useState(false);

  // Dry run result modal — confirmSource/confirmKey are set only when opened from the "가져오기"
  // ghost-row flow (§useLocalImport.importCandidate); a plain per-row "테스트 실행" click leaves them
  // null and the footer shows just the close button, same as before W8.
  const [dryRunResult, setDryRunResult] = useState<DryRunPreview | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await call<CollectSourceListOutput>("collect_source_list", {});
      setSources(r.sources ?? []);
      setLoadFailed(false);
    } catch {
      // call() 이 토스트를 띄웠다 — 이미 읽어 둔 목록이 있으면 그대로 두고, 처음 읽기가 실패했으면 표가 그 사실을 말한다.
      setLoadFailed(true);
    }
  }, []);

  // 통계 배지 새로고침 — 마운트 시(useEffect)와 가져오기 확인 직후(confirmImport) 둘 다 쓴다.
  const refreshStats = useCallback(() => {
    // callSilent()는 reject 시 계속 throw 한다(호출자가 붙잡으라는 계약, lib/invoke.ts 참고) —
    // 통계 배지는 있으면 보여주고 없으면 조용히 숨기는 선택적 UI라 실패를 사용자에게 알릴 필요가
    // 없다. .catch() 없이 두면 실제 앱에서도 진짜 unhandled promise rejection이 새는 결함이었다.
    void callSilent<CollectGetStatsOutput>("collect_get_stats", {})
      .then((res) => {
        if (res) setStats(res);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    void load();
    refreshStats();
  }, [load, refreshStats]);


  const form = useCollectSourceForm(load);
  // 딥링크 anchor=add — 브리핑 "수집 소스 추가" 버튼이 곧장 추가 폼으로 온다(1회성, 패널이 앵커를 지운다).
  useSettingsAnchorOnce("add", () => form.openCreateForm());

  const toggleEnabled = async (source: CollectSource, enabled: boolean) => {
    setSources((prev) => prev?.map((x) => (x.id === source.id ? { ...x, enabled } : x)) ?? prev);
    try {
      await call("collect_source_set_enabled", { id: source.id, enabled });
    } catch {
      setSources((prev) => prev?.map((x) => (x.id === source.id ? { ...x, enabled: !enabled } : x)) ?? prev);
    }
  };

  const runNow = async (source: CollectSource) => {
    // 다른 소스가 도는 중이면 조용히 무시하지 않고 말한다 — 이 행의 단추는 잠겨 있지 않다.
    if (runningId) {
      emitNotice(t("settings.collect_run_busy"));
      return;
    }
    if (source.kind === "youtube") {
      const proceed = await ensureYtdlp();
      if (!proceed) return;
    }
    setRunningId(source.id);
    try {
      const result = await call<CollectSourceRunNowOutput>("collect_source_run_now", { id: source.id });
      emitNotice(result.error ?? t("settings.collect_run_done", { n: result.added }));
      await load();
    } catch {
      /* call() handles notice */
    } finally {
      setRunningId(null);
    }
  };

  // confirmKey, when passed, is the ghost candidate's key(§LocalCandidate) that triggered this —
  // it flags "confirm mode" (adds the "이대로 가져오기" footer button) and lets confirmImport drop
  // the right ghost row locally afterward without a second collect_detect_local round trip.
  const runDryRun = async (source: CollectSource, confirmKey?: string) => {
    if (dryRunningId) return;
    if (source.kind === "youtube") {
      const proceed = await ensureYtdlp();
      if (!proceed) return;
    }
    setDryRunningId(source.id);
    try {
      const result = await call<CollectSourceDryRunOutput>("collect_source_dry_run", { id: source.id });
      setDryRunResult({
        sourceName: source.name,
        sourceKind: source.kind,
        outcome: result,
        confirmSource: confirmKey ? source : null,
        confirmKey: confirmKey ?? null,
      });
    } catch {
      /* call() 이 이미 에러 토스트를 띄웠다 — 한 번만 말한다 */
    } finally {
      setDryRunningId(null);
    }
  };

  const deleteSource = async (source: CollectSource) => {
    try {
      await call("collect_source_delete", { id: source.id });
      await load();
    } catch {
      /* call() handles notice */
    }
  };

  // 로컬 소스 감지(§2.5, PLAN-2026-09-04 W8) — 감지·유령 행·가져오기는 훅이, 가져온 소스의
  // 드라이런 확인 모달은 표의 "테스트 실행"과 공용이라 여기서 쥔다.
  const local = useLocalImport(runDryRun);

  // 첫 부팅 자동 감지 뱃지(§3b) — 이 페이지를 열면 "이미 봤음"으로 확정한다(이후 부팅에서 App.tsx 의
  // 무음 자동 감지도 다시는 돌지 않는다). 뱃지(pending>0)가 떠 있으면 **감지를 먼저 돌려 후보를 보여 준 뒤**
  // 뱃지를 지운다 — 열자마자 지우면 뱃지가 가리키던 것이 화면 어디에도 없다. 감지가 실패하면 뱃지를
  // 남긴다(헤더의 감지 단추로 다시 시도할 수 있다). 이미 seen=true·pending=0이면 settings_set 을 쏘지 않는다.
  const autoDetectStarted = useRef(false);
  useEffect(() => {
    if (autoDetectStarted.current) return; // StrictMode 이중 effect 에 감지가 두 번 돌지 않게
    autoDetectStarted.current = true;
    const { collectDetectSeen: seen, collectDetectPending: pending } = useSettingsStore.getState();
    if (!seen) void setCollectDetectSeen(true);
    if (pending === 0) return;
    void local.detectLocal().then((ok) => {
      if (ok) void setCollectDetectPending(0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setCollectDetectSeen, setCollectDetectPending]);

  const confirmImport = async () => {
    if (!dryRunResult?.confirmSource || confirmBusy) return;
    const { confirmSource: source, confirmKey } = dryRunResult;
    setConfirmBusy(true);
    try {
      const result = await call<CollectSourceRunNowOutput>("collect_source_run_now", { id: source.id });
      emitNotice(result.error ?? t("settings.collect_run_done", { n: result.added }));
      setDryRunResult(null);
      // 재감지 대신 로컬 필터로 유령 행을 없앤다(ponytail: 서버 재조회 없이 낙관적으로 지움).
      if (confirmKey) local.dropCandidate(confirmKey);
      await load();
      refreshStats();
    } catch {
      /* call() handles notice */
    } finally {
      setConfirmBusy(false);
    }
  };

  // 통계 서브캡션 — per_action 의 링크 제안·후처리 호출 수(예전 statsStr 의 뒷부분). 둘 다 0 이면 생략.
  const perActionSub = (() => {
    const parts: string[] = [];
    const ls = stats?.per_action?.find((a) => a.action_type === "link_suggest");
    if (ls && ls.calls > 0) parts.push(`${t("settings.collect_stats_links")} ${ls.calls}`);
    const pp = stats?.per_action?.find((a) => a.action_type === "collect_post_process");
    if (pp && pp.calls > 0) parts.push(`${t("settings.collect_stats_post_processed")} ${pp.calls}`);
    return parts.length ? parts.join(" · ") : undefined;
  })();
  const activeSources = (sources ?? []).filter((s) => s.enabled).length;
  // 통계를 못 읽었으면(읽는 중·실패) 0 이 아니라 "—" — 0 은 "오늘 아무것도 안 들어왔다"는 다른 사실이다.
  const statOrDash = (n: number | undefined) => (stats ? (n ?? 0) : "—");

  return (
    <>
      {/* 마스터 스위치 + 일시중지 배지는 페이지 첫 줄 설정 행(PLAN-2026-10-24 D4). */}
      <div className="card" style={groupCardStyle} data-testid="settings-collect-master-card">
        <SettingsRow
          anchor="collect_enabled"
          label={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
              {t("settings.collect_enabled_label")}
              {paused && <Badge tone="neutral">{t("settings.collect_badge_paused")}</Badge>}
            </span>
          }
          hint={t("settings.collect_enabled_hint")}
          control={
            <Toggle
              checked={!paused}
              onChange={(next) => setCollectEnabled(next)}
              aria-label={t("settings.collect_enabled_label")}
              data-testid="settings-collect-enabled-toggle"
            />
          }
        />
      </div>
      {/* 오너 R1(2026-09-15): 통계 타일은 카드 밖, 마스터 행 카드 아래 페이지 최상위. */}
      <MetricTileGroup
        tiles={[
          {
            id: "collect-today",
            icon: <IconCalendar size={16} />,
            value: statOrDash(stats?.total_today),
            label: t("settings.collect_tile_today"),
          },
          {
            id: "collect-week",
            icon: <IconCalendarDays size={16} />,
            value: statOrDash(stats?.total_since),
            label: t("settings.collect_tile_week"),
            subtext: perActionSub,
          },
          {
            id: "collect-active",
            icon: <IconActivity size={16} />,
            value: sources ? `${activeSources} / ${sources.length}` : "—",
            label: t("settings.collect_tile_active"),
          },
        ]}
      />

      <div id={anchorId("sources")} data-testid="collect-sources-block">
      {/* 소스 표 — 카드 밖, 제목 행(제목 + 소스 추가) + 유령 행 + 표 (오너 R1). */}
      <SectionHeader
        title={t("settings.collect_sources_title")}
        icon={<IconFileImport size={14} strokeWidth={2} />}
        actions={
          <>
            {/* design-review 2026-09-14 D10: 표 안 대형 점선 CTA를 걷어내고 여기 소형 버튼으로 —
                표 밖 우상단이라 "표 셀 입력"으로 오인할 여지가 없다. */}
            {/* 로컬 소스(브라우저 기록·AI 대화) 감지 — 읽기만 하고 아무것도 저장하지 않는다. */}
            <IconAction
              id={anchorId("detect")}
              data-testid="collect-detect-btn"
              icon={<IconSearch size={16} />}
              label={t("settings.collect_detect_btn")}
              busy={local.detecting}
              disabled={local.detecting}
              onClick={() => void local.detectLocal()}
            />
            <IconAction
              id={anchorId("add")}
              data-testid="collect-table-add-row"
              label={t("settings.collect_add_source")}
              onClick={() => form.openCreateForm()}
              icon={<IconPlus size={16} />}
            />
          </>
        }
      />

      {/* 로컬 소스 감지 결과 — 유령 행(§2.5, W8). "감지"를 한 번도 안 눌렀으면(detectDone=false)
          아무것도 안 그린다: 빈 결과와 "아직 안 눌러봄"을 구분해야 하기 때문. */}
      {local.detectDone && (
        <LocalImportPanel
          ghostCandidates={local.ghostCandidates}
          importingKey={local.importingKey}
          onImport={(c) => void local.importCandidate(c)}
        />
      )}

      {/* 소스 목록 테이블 (SettingsTable 재사용 컴포넌트 적용, D11) */}
      <SettingsTable
        columns="100px minmax(120px, 1.2fr) minmax(160px, 2fr) 210px"
        maxHeight={430}
        data-testid="collect-table-container"
        scrollTestId="collect-table-scroll"
        style={{ marginTop: 0 }}
        isEmpty={!sources || sources.length === 0}
        emptyText={
          sources === null && loadFailed ? (
            <span data-testid="collect-load-failed" style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
              {t("settings.collect_load_failed")}
              <IconAction
                icon={<IconRefresh size={14} />}
                label={t("common.retry")}
                size="sm"
                data-testid="collect-load-retry"
                onClick={() => void load()}
              />
            </span>
          ) : sources === null ? (
            t("common.loading")
          ) : (
            t("settings.collect_empty")
          )
        }
        header={
          <>
            <div>{t("settings.collect_table_kind")}</div>
            <div>{t("settings.collect_table_name")}</div>
            <div>{t("settings.collect_table_address")}</div>
            <div style={{ textAlign: "right" }}>{t("settings.collect_table_actions")}</div>
          </>
        }
      >
        {(sources ?? []).map((s, i) => (
          <CollectSourceRow
            key={s.id}
            source={s}
            isLast={i === (sources ?? []).length - 1}
            busy={runningId === s.id}
            dryBusy={dryRunningId === s.id}
            onDryRun={() => void runDryRun(s)}
            onRunNow={() => void runNow(s)}
            onEdit={() => form.openEditForm(s)}
            onDelete={() => setPendingDelete(s)}
            onToggle={(next) => void toggleEnabled(s, next)}
          />
        ))}
      </SettingsTable>
      </div>

      {/* 수집 경로가 읽는 제외 도메인 — 이 페이지 맨 아래(오너 결정: 연결 페이지에서 이사). */}
      <ExcludedDomainsSection />

      {/* 소스 생성/수정 좌우 2단 모달 */}
      {form.formOpen && <CollectSourceFormModal form={form} />}

      {/* Dry Run 결과 미리보기 모달 */}
      {dryRunResult && (
        <CollectDryRunModal
          result={dryRunResult}
          confirmBusy={confirmBusy}
          onClose={() => setDryRunResult(null)}
          onConfirm={() => void confirmImport()}
        />
      )}

      {/* 소스 삭제 확인 모달 */}
      {pendingDelete && (
        <PromptDialog
          title={t("settings.collect_delete_title")}
          description={t("settings.collect_delete_confirm", { name: pendingDelete.name })}
          mode="confirm"
          danger
          confirmLabel={t("ctx.remove")}
          onCancel={() => setPendingDelete(null)}
          onSubmit={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            void deleteSource(target);
          }}
        />
      )}
    </>
  );
}

