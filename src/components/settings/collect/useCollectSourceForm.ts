import { useCallback, useState } from "react";
import { callSilent, emitNotice } from "../../../lib/invoke";
import { reportFallback } from "../../../lib/diag";
import { t } from "../../../i18n/t";
import type { CollectSource } from "../../../lib/commands.gen";
import { isYoutubeChannelFeedUrl, extractYouTubeVideoId } from "../../../lib/urlKind";
import { ensureYtdlp } from "./ensureYtdlp";

export interface DetectedChatSession {
  id: string;
  kind: string;
  project: string;
  title: string;
  last_prompt: string;
  prompt_count: number;
  last_active_at: string | null;
  relative_time: string;
}

export interface SourceFormState {
  id?: string;
  // "youtube_channel"은 서버 kind가 아니다 — UI 전용 의사 유형(값은 collect_resolve_youtube_channel로
  // 해석해 kind='rss'로 저장). kind Select는 편집 중 disabled라 신규 생성에만 나타난다(saveForm 참고).
  kind: "rss" | "web" | "claude_prompts" | "codex_prompts" | "youtube" | "youtube_channel" | "browser_history";
  name: string;
  url: string;
  project: string;
  // browser_history 전용(§2.3) — 다른 kind 는 무시.
  browser: "chrome" | "edge" | "brave" | "vivaldi" | "whale";
  profile: string;
  minSeconds: string;
  backfillDays: string;
  targetFolderId: string;
  intervalMinutes: string;
  dryRun: boolean;
  showInBriefing: boolean;
  postProcess: "none" | "suggest" | "summary";
  postProcessModel: string;
  postProcessPrompt: string;
  advancedOpen: boolean;
  /** 편집: 저장돼 있던 config 원본 — 폼이 모르는 키를 저장 때 그대로 남기려고 들고 있다. */
  baseConfig?: Record<string, unknown>;
  /** 편집: 저장된 config 를 JSON 으로 읽지 못했다 — 저장 때 config 를 보내지 않는다(덮어쓰지 않는다). */
  configUnreadable?: boolean;
}

/** 폼이 직접 고치는 config 키 — 편집 저장 때 이 키들만 폼 값으로 바꾸고 나머지는 원본 그대로 둔다. */
const FORM_CONFIG_KEYS = ["url", "project", "browser", "profile", "min_seconds", "backfill_days", "interval_minutes", "prompt"];

export const DEFAULT_FORM: SourceFormState = {
  kind: "rss",
  name: "",
  url: "",
  project: "",
  browser: "chrome",
  profile: "Default",
  minSeconds: "15",
  backfillDays: "7",
  targetFolderId: "",
  intervalMinutes: "60",
  dryRun: false,
  showInBriefing: true,
  postProcess: "none",
  postProcessModel: "",
  postProcessPrompt: "",
  advancedOpen: false,
};

/**
 * 소스 추가/수정 폼(모달)의 상태와 핸들러. 모달 JSX 는 CollectSourceFormModal 이 그린다.
 *
 * CollectSection 과의 경계는 `onSaved` 하나다 — 저장에 성공하면 목록을 다시 불러오라고 부를 뿐,
 * 소스 목록·폴더는 이 훅이 읽지 않는다(폴더 선택지는 모달이 스토어에서 직접 읽는다).
 */
export function useCollectSourceForm(onSaved: () => Promise<void>) {
  // AI 대화 세션 감지 (개별 세션 첫 질문/마지막 질문 프리뷰)
  const [detectedSessions, setDetectedSessions] = useState<DetectedChatSession[]>([]);
  const [detectingSessions, setDetectingSessions] = useState(false);
  const [detectedSessionsDone, setDetectedSessionsDone] = useState(false);

  const detectChatSessions = useCallback(async (force = false) => {
    if (detectingSessions) return;
    if (!force && detectedSessionsDone) return;
    setDetectingSessions(true);
    try {
      const res = await callSilent<{ sessions: DetectedChatSession[] }>("collect_detect_chat_sessions", {});
      setDetectedSessions(res?.sessions ?? []);
      setDetectedSessionsDone(true);
    } catch {
      setDetectedSessions([]);
      setDetectedSessionsDone(true);
    } finally {
      setDetectingSessions(false);
    }
  }, [detectingSessions, detectedSessionsDone]);

  // Form modal (create / edit)
  const [formOpen, setFormOpen] = useState(false);
  const [formState, setFormState] = useState<SourceFormState>(DEFAULT_FORM);
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const openCreateForm = (initialKind?: SourceFormState["kind"]) => {
    setDetectedSessionsDone(false);
    setFormState({
      ...DEFAULT_FORM,
      ...(initialKind
        ? {
            kind: initialKind,
            name:
              initialKind === "browser_history"
                ? t("settings.collect_default_name_history")
                : initialKind === "claude_prompts"
                ? t("settings.collect_default_name_claude")
                : initialKind === "codex_prompts"
                ? t("settings.collect_default_name_codex")
                : "",
          }
        : {}),
    });
    setFormError(null);
    setFormOpen(true);
  };

  const handleUrlChange = (newUrl: string) => {
    setFormState((prev) => {
      const trimmed = newUrl.trim();
      let nextKind = prev.kind;
      let nextName = prev.name;

      if (!prev.id) {
        if (extractYouTubeVideoId(trimmed)) {
          nextKind = "youtube";
        } else if (
          isYoutubeChannelFeedUrl(trimmed) ||
          (trimmed.includes("youtube.com") &&
            (trimmed.includes("/@") ||
              trimmed.includes("/channel/") ||
              trimmed.includes("/c/") ||
              trimmed.includes("/user/")))
        ) {
          nextKind = "youtube_channel";
        } else if (/\.(xml|rss|atom)($|\?)/i.test(trimmed) || trimmed.includes("/feed") || trimmed.includes("/rss")) {
          nextKind = "rss";
        } else if (/^https?:\/\//i.test(trimmed) && (prev.kind === "rss" || prev.kind === "web" || prev.kind === "youtube" || prev.kind === "youtube_channel")) {
          if (prev.kind !== "rss") {
            nextKind = "web";
          }
        }

        if (!prev.name.trim() && /^https?:\/\//i.test(trimmed)) {
          try {
            const u = new URL(trimmed);
            const host = u.hostname.replace(/^www\./, "");
            nextName = host;
          } catch {}
        }
      }

      return {
        ...prev,
        url: newUrl,
        kind: nextKind,
        name: nextName,
      };
    });
  };

  const openEditForm = (s: CollectSource) => {
    let url = "";
    let project = "";
    let browser: "chrome" | "edge" | "brave" | "vivaldi" | "whale" = "chrome";
    let profile = "Default";
    let minSeconds = "15";
    // browser_history 기본은 7일, claude/codex prompts 기본은 14일(§2.2 백필 — 서버 기본값과
    // 맞춰둔다. config에 backfill_days가 없는 옛 소스라면 이 기본값이 그대로 보인다).
    let backfillDays = s.kind === "browser_history" ? "7" : "14";
    let postProcessPrompt = "";
    let baseConfig: Record<string, unknown> | undefined;
    let configUnreadable = false;
    try {
      const parsed = JSON.parse(s.config || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) baseConfig = parsed;
      if (parsed.url) url = parsed.url;
      if (parsed.project) project = parsed.project;
      if (
        parsed.browser === "edge" ||
        parsed.browser === "brave" ||
        parsed.browser === "vivaldi" ||
        parsed.browser === "whale"
      ) {
        browser = parsed.browser;
      }
      if (parsed.profile) profile = parsed.profile;
      if (parsed.min_seconds != null) minSeconds = String(parsed.min_seconds);
      if (parsed.backfill_days != null) backfillDays = String(parsed.backfill_days);
      if (parsed.prompt) postProcessPrompt = parsed.prompt;
    } catch (e) {
      // 저장된 config 가 깨졌다 — 폼은 기본값을 보여 주되, 저장할 때 config 를 덮어쓰지 않는다.
      configUnreadable = true;
      reportFallback("collect", "source_config_unparseable", `id=${s.id} ${e instanceof Error ? e.message : String(e)}`);
    }

    const hasAdvanced =
      s.dry_run ||
      s.show_in_briefing === false ||
      Boolean(s.target_folder_id) ||
      (s.interval_minutes != null && s.interval_minutes !== 60) ||
      (s.post_process && s.post_process !== "none") ||
      Boolean(s.post_process_model) ||
      Boolean(postProcessPrompt);

    setFormState({
      id: s.id,
      kind: (s.kind as any) || "rss",
      name: s.name,
      url,
      project,
      browser,
      profile,
      minSeconds,
      backfillDays,
      targetFolderId: s.target_folder_id ?? "",
      intervalMinutes: s.interval_minutes != null ? String(s.interval_minutes) : "60",
      dryRun: Boolean(s.dry_run),
      showInBriefing: s.show_in_briefing !== false,
      postProcess: (s.post_process as any) === "suggest" || (s.post_process as any) === "summary" ? (s.post_process as any) : "none",
      postProcessModel: s.post_process_model ?? "",
      postProcessPrompt,
      advancedOpen: Boolean(hasAdvanced),
      baseConfig,
      configUnreadable,
    });
    setFormError(configUnreadable ? t("settings.collect_config_unreadable") : null);
    setFormOpen(true);
  };

  const saveForm = async () => {
    if (!formState.name.trim()) {
      setFormError(t("settings.collect_required_field", { field: t("settings.collect_source_name") }));
      return;
    }
    if (
      (formState.kind === "rss" || formState.kind === "web" || formState.kind === "youtube" || formState.kind === "youtube_channel") &&
      !formState.url.trim()
    ) {
      setFormError(t("settings.collect_required_field", { field: t("settings.collect_url_label") }));
      return;
    }
    // 드라이런 소스는 저장만으로는 실제로 yt-dlp를 부르지 않는다(테스트 실행 버튼이 별도 게이트를
    // 탄다) — 최소 마찰: 저장 시점엔 실제로 실행될 소스(dryRun=false)에만 동의를 요구한다.
    // youtube_channel도 포함해야 한다 — 저장되는 순간 kind='rss'로 바뀌므로(§ saveForm 아래
    // 분기), 그 뒤로는 "이 rss 소스가 유튜브 채널이라 자막 보강에 yt-dlp가 필요하다"는 신호가
    // 어디에도 남지 않는다. 여기서 놓치면 미설치 상태로 조용히 저장되고, 수집될 때마다
    // enrich_youtube_subtitles의 fetch가 매번 실패해 설명만 있는 노트만 쌓인다(에러는 서버
    // stderr에만 남아 사용자는 원인을 알 길이 없다) — 2026-08-29 실기 검증 중 발견.
    if ((formState.kind === "youtube" || formState.kind === "youtube_channel") && !formState.dryRun) {
      const proceed = await ensureYtdlp();
      if (!proceed) return;
    }

    setFormSaving(true);
    setFormError(null);

    const configObj: Record<string, unknown> = {};
    if (formState.kind === "rss" || formState.kind === "web" || formState.kind === "youtube") {
      configObj.url = formState.url.trim();
    } else if (formState.kind === "claude_prompts" || formState.kind === "codex_prompts") {
      if (formState.project.trim()) configObj.project = formState.project.trim();
      const backfillDaysNum = parseInt(formState.backfillDays, 10);
      configObj.backfill_days = isNaN(backfillDaysNum) ? 14 : backfillDaysNum;
    } else if (formState.kind === "browser_history") {
      configObj.browser = formState.browser;
      configObj.profile = formState.profile.trim() || "Default";
      const minSecondsNum = parseInt(formState.minSeconds, 10);
      configObj.min_seconds = isNaN(minSecondsNum) ? 15 : minSecondsNum;
      const backfillDaysNum = parseInt(formState.backfillDays, 10);
      configObj.backfill_days = isNaN(backfillDaysNum) ? 7 : backfillDaysNum;
    }
    const intervalNum = parseInt(formState.intervalMinutes, 10);
    if (formState.kind !== "youtube" && !isNaN(intervalNum) && intervalNum > 0) {
      configObj.interval_minutes = intervalNum;
    }
    if (formState.postProcessPrompt.trim()) {
      configObj.prompt = formState.postProcessPrompt.trim();
    }

    // 편집은 원본 config 위에 폼이 고치는 키만 덮는다 — 폼이 모르는 키(다른 버전·수동 편집)를 지우지 않는다.
    // 비운 칸(프로젝트·프롬프트 등)은 원본에서도 빠져야 하므로 폼 키를 먼저 걷어 낸다.
    const merged: Record<string, unknown> = { ...(formState.id ? formState.baseConfig ?? {} : {}) };
    for (const k of FORM_CONFIG_KEYS) delete merged[k];
    Object.assign(merged, configObj);
    const configJson = JSON.stringify(merged);
    // 원본을 못 읽었으면 config 를 아예 보내지 않는다(collect_source_update 의 config 는 생략 가능).
    const configArg = formState.id && formState.configUnreadable ? undefined : configJson;
    const targetFolder = formState.targetFolderId.trim() ? formState.targetFolderId.trim() : null;
    const modelOverride = formState.postProcessModel.trim() ? formState.postProcessModel.trim() : null;

    // 실패는 폼 안의 오류 줄(formError) 한 곳에서만 말한다 — call() 이면 토스트까지 겹쳐 두 번 말했다.
    try {
      // 유튜브 채널: 서버 kind가 아니라 UI 전용 지름길 — 채널 URL을 RSS 피드로 해석해 kind='rss'로
      // 저장한다. kind Select는 편집 중 disabled라 이 값은 신규 생성에만 나타나고, 편집 재진입 시엔
      // 실제로 저장된 kind인 "rss"로 보인다(의도된 동작, 버그 아님).
      if (formState.kind === "youtube_channel") {
        const resolved = await callSilent<{ feed_url: string }>("collect_resolve_youtube_channel", {
          url: formState.url.trim(),
        });
        const channelConfig: Record<string, unknown> = { url: resolved.feed_url };
        if (formState.postProcessPrompt.trim()) {
          channelConfig.prompt = formState.postProcessPrompt.trim();
        }
        await callSilent("collect_source_create", {
          kind: "rss",
          name: formState.name.trim(),
          config: JSON.stringify(channelConfig),
          dry_run: formState.dryRun,
          show_in_briefing: formState.showInBriefing,
          target_folder_id: targetFolder,
          post_process: formState.postProcess,
          post_process_model: modelOverride,
          interval_minutes: isNaN(intervalNum) ? null : intervalNum,
        });
        emitNotice(t("settings.collect_add_done"));
        setFormOpen(false);
        await onSaved();
        return;
      }

      if (formState.id) {
        await callSilent("collect_source_update", {
          id: formState.id,
          name: formState.name.trim(),
          config: configArg,
          dry_run: formState.dryRun,
          show_in_briefing: formState.showInBriefing,
          target_folder_id: targetFolder,
          post_process: formState.postProcess,
          post_process_model: modelOverride,
          interval_minutes: isNaN(intervalNum) ? null : intervalNum,
        });
        emitNotice(t("settings.collect_save_done"));
      } else {
        await callSilent("collect_source_create", {
          kind: formState.kind,
          name: formState.name.trim(),
          config: configJson,
          dry_run: formState.dryRun,
          show_in_briefing: formState.showInBriefing,
          target_folder_id: targetFolder,
          post_process: formState.postProcess,
          post_process_model: modelOverride,
          interval_minutes: isNaN(intervalNum) ? null : intervalNum,
        });
        emitNotice(t("settings.collect_add_done"));
      }
      setFormOpen(false);
      await onSaved();
    } catch (e: any) {
      setFormError(String(e?.message ?? e));
    } finally {
      setFormSaving(false);
    }
  };

  return {
    formOpen,
    formState,
    setFormState,
    formSaving,
    formError,
    closeForm: () => setFormOpen(false),
    openCreateForm,
    openEditForm,
    handleUrlChange,
    saveForm,
    detectedSessions,
    detectingSessions,
    detectedSessionsDone,
    detectChatSessions,
  };
}

/** CollectSourceFormModal 이 받는 훅 반환 묶음. */
export type CollectSourceForm = ReturnType<typeof useCollectSourceForm>;
