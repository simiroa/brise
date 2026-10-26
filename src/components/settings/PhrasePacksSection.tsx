/**
 * Settings › 브리핑: select / turn off the phrase pack shown in the briefing window header (src/briefing/QuoteLine.tsx).
 * Lived on Settings › 대시보드 until 2026-10-19, when the quote left the dashboard header (GRILL-2026-10-19 R4).
 * Lists bundled packs + user packs from app data dir (phrase_packs/*.json).
 * With AI on, "AI로 생성" writes a new user pack from a topic (PhrasePackAiModal below).
 */
import { anchorId } from "./settingsAnchor";
import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { groupCardStyle } from "./shared";
import { SectionHeader } from "./SectionHeader";
import { SettingsRow } from "./SettingsRow";
import { Badge } from "./Badge";
import { IconAi, IconCode, IconQuote } from "../icons";
import { IconAction } from "./IconAction";
import {
  PHRASE_PACK_OFF,
  loadAllPhrasePacks,
  parseAiPhraseItems,
  type PhraseItem,
  type PhrasePack,
} from "../../lib/phrasePacks";
import { Select } from "../Select";
import { ModalShell } from "../ModalShell";
import { call } from "../../lib/invoke";
import { ensureAiAskGate, useAiStore } from "../../stores/ai";
import { reportFallback } from "../../lib/diag";
import type { PhrasePackSaveOutput } from "../../lib/commands.gen";

/** 팩 목록 — 실패해도 번들 선택지(끄기·노트 명언)로 계속 고를 수 있으니 토스트 없이 진단에만 남긴다. */
function loadPacksOrEmpty(): Promise<PhrasePack[]> {
  return loadAllPhrasePacks().catch((e: unknown) => {
    reportFallback("phrase_packs", "load_failed", String((e as { message?: string })?.message ?? e).slice(0, 120));
    return [];
  });
}

/** `disabled` — 브리핑이 꺼져 있을 때(문구는 브리핑 창 머리줄에만 뜬다). 행이 조작을 막고 이유를 툴팁으로. */
export function PhrasePacksSection({ disabled, disabledReason }: { disabled?: boolean; disabledReason?: string } = {}) {
  const phrasePackId = useSettingsStore((s) => s.phrasePackId);
  const setPhrasePackId = useSettingsStore((s) => s.setPhrasePackId);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const [packs, setPacks] = useState<PhrasePack[]>([]);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadPacksOrEmpty().then((list) => {
      if (!cancelled) setPacks(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const openAiModal = async () => {
    if (await ensureAiAskGate()) setAiOpen(true);
  };

  // Saved pack is already selected by the modal — just refresh the option list so it has a label.
  const handleSaved = async () => {
    setAiOpen(false);
    setPacks(await loadPacksOrEmpty());
  };

  // PLAN-2026-09-15 §4 대시보드: 고른 팩이 사용자 제작이면 Select 옆에 accent 배지.
  const selectedIsUser = packs.find((p) => p.id === phrasePackId)?.origin === "user";

  return (
    <div className="card" style={groupCardStyle} id={anchorId("phrase_packs")} data-testid="settings-phrase-packs">
      <SectionHeader
        title={t("settings.phrase_packs")}
        hint={t("settings.phrase_packs_hint")}
        icon={<IconQuote size={14} strokeWidth={2} />}
      />
      <SettingsRow
        anchor="phrase_pack_active"
        label={t("settings.phrase_pack_active")}
        disabled={disabled}
        disabledReason={disabledReason}
        control={
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          {selectedIsUser && (
            <span data-testid="settings-phrase-pack-user-badge">
              <Badge tone="accent">{t("settings.dashboard_badge_user_pack")}</Badge>
            </span>
          )}
          <Select
            testid="settings-phrase-pack-select"
            value={phrasePackId}
            onChange={(v) => void setPhrasePackId(v)}
            ariaLabel={t("settings.phrase_pack_active")}
            options={[
              { value: PHRASE_PACK_OFF, label: t("settings.phrase_pack_off") },
              { value: "bundled:note-quotes", label: t("settings.phrase_pack_note_quotes") },
              ...packs.map((p) => ({
                value: p.id,
                label: p.origin === "user" ? `${p.name} (${t("settings.phrase_pack_user")})` : p.name,
              })),
            ]}
          />
          {aiEnabled && (
            <IconAction
              icon={<IconAi size={16} />}
              label={t("settings.phrase_pack_ai_btn")}
              titleOverride={t("settings.phrase_pack_ai_row")}
              size="lg"
              data-testid="settings-phrase-pack-ai-btn"
              onClick={() => void openAiModal()}
            />
          )}
          </div>
        }
      />
      {aiOpen && (
        <PhrasePackAiModal onClose={() => setAiOpen(false)} onSaved={() => void handleSaved()} />
      )}
    </div>
  );
}

const AI_LANG_NAMES: Record<string, string> = { ko: "Korean", en: "English", fr: "French" };
const AI_PHRASE_COUNT = 20;

function buildPhrasePrompt(topic: string, uiLang: string): string {
  const lang = AI_LANG_NAMES[uiLang] ?? "English";
  return [
    "You write one-line header phrases shown at the top of the daily briefing window of a note-taking app.",
    `Topic: ${topic}`,
    `Write ${AI_PHRASE_COUNT} distinct phrases in ${lang}. Each must be a single line under 80 characters, with no numbering and no surrounding quotation marks.`,
    'Answer with ONLY a JSON array and nothing else — no prose, no markdown fence:',
    '[{"text":"the phrase","source":"author or work"}]',
    'Omit "source" entirely when there is no real attribution. Never invent one.',
  ].join("\n");
}

/**
 * Topic → AI → preview → save as a user pack.
 * ponytail: preview is read-only in v1. Per-phrase editing/deleting means an items-state editor
 * plus dirty tracking; the escape hatch already exists — the saved file is plain JSON in
 * phrase_packs/, editable by hand. Add in-modal editing when users actually ask to tweak
 * before saving rather than after.
 */
function PhrasePackAiModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const setPhrasePackId = useSettingsStore((s) => s.setPhrasePackId);
  const generateFromPrompt = useAiStore((s) => s.generateFromPrompt);

  const [topic, setTopic] = useState("");
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState<PhraseItem[]>([]);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);

  const trimmedTopic = topic.trim();

  const handleGenerate = async () => {
    if (!trimmedTopic || pending) return;
    setPending(true);
    setError(null);
    setItems([]);
    setRaw("");
    try {
      // purpose "json" — 답이 JSON 배열이어야 한다(프로바이더가 JSON 모드를 켠다).
      const out = await generateFromPrompt(buildPhrasePrompt(trimmedTopic, uiLang), null, { purpose: "json" });
      if (!out || !out.trim()) {
        setError(t("settings.phrase_pack_ai_failed"));
        return;
      }
      setRaw(out);
      const parsed = parseAiPhraseItems(out);
      setItems(parsed);
      if (parsed.length === 0) setError(t("settings.phrase_pack_ai_parse_failed"));
    } finally {
      setPending(false);
    }
  };

  const handleSave = async () => {
    if (items.length === 0 || saving) return;
    setSaving(true);
    try {
      const res = await call<PhrasePackSaveOutput>("phrase_pack_save", {
        // Backend caps the name at 80 chars — clip here so a rambling topic is a save, not a toast.
        name: trimmedTopic.slice(0, 80),
        items,
      });
      await setPhrasePackId(res.id);
      onSaved();
    } catch {
      /* call() already toasted */
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      title={t("settings.phrase_pack_ai_title")}
      onClose={onClose}
      width={520}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            data-testid="settings-phrase-pack-ai-save"
            className="btn btn-primary"
            disabled={items.length === 0 || saving}
            onClick={() => void handleSave()}
          >
            {t("settings.phrase_pack_ai_save")}
          </button>
        </div>
      }
    >
      <p
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--muted)",
          margin: "var(--space-3) 0 var(--space-4)",
          lineHeight: 1.45,
        }}
      >
        {t("settings.phrase_pack_ai_hint", { count: AI_PHRASE_COUNT })}
      </p>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <input
          type="text"
          className="field"
          data-testid="settings-phrase-pack-ai-topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleGenerate();
            }
          }}
          placeholder={t("settings.phrase_pack_ai_topic_placeholder")}
          aria-label={t("settings.phrase_pack_ai_topic_placeholder")}
          disabled={pending}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          data-testid="settings-phrase-pack-ai-generate"
          className="btn btn-primary"
          style={{ minWidth: 84, whiteSpace: "nowrap" }}
          disabled={pending || !trimmedTopic}
          onClick={() => void handleGenerate()}
        >
          {pending
            ? t("settings.phrase_pack_ai_generating")
            : items.length > 0 || raw
              ? t("settings.phrase_pack_ai_regenerate")
              : t("settings.phrase_pack_ai_generate")}
        </button>
      </div>

      {error && (
        <div
          data-testid="settings-phrase-pack-ai-error"
          style={{ color: "var(--danger)", fontSize: "var(--text-sm)", marginTop: "var(--space-3)" }}
        >
          {error}
        </div>
      )}

      {items.length > 0 && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <SectionHeader
            title={t("settings.phrase_pack_ai_preview", { count: items.length })}
            icon={<IconQuote size={14} strokeWidth={2} />}
          />
          <ul
            className="scroll"
            data-testid="settings-phrase-pack-ai-preview"
            style={{
              listStyle: "none",
              margin: 0,
              padding: "var(--space-2) var(--space-3)",
              maxHeight: 260,
              overflowY: "auto",
              border: "1px solid var(--divider)",
              borderRadius: "var(--radius-md)",
            }}
          >
            {items.map((it, i) => (
              <li
                key={`${i}-${it.text}`}
                style={{
                  padding: "var(--space-2) 0",
                  fontSize: "var(--text-sm)",
                  lineHeight: 1.45,
                }}
              >
                {it.text}
                {it.source && (
                  <span style={{ color: "var(--faint)", marginLeft: 6 }}>— {it.source}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Parse failed but the model did answer — show what it said instead of swallowing it. */}
      {items.length === 0 && raw && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <SectionHeader title={t("settings.phrase_pack_ai_raw")} icon={<IconCode size={14} strokeWidth={2} />} />
          <pre
            className="scroll"
            data-testid="settings-phrase-pack-ai-raw"
            style={{
              margin: 0,
              padding: "var(--space-3)",
              maxHeight: 200,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: "var(--text-xs)",
              color: "var(--muted)",
              border: "1px solid var(--divider)",
              borderRadius: "var(--radius-md)",
            }}
          >
            {raw}
          </pre>
        </div>
      )}
    </ModalShell>
  );
}
