import { useState } from "react";
import { t } from "../../../i18n/t";
import { ModalShell } from "../../ModalShell";

/**
 * "이 대화에서 기억 추출" 결과 — 모델이 뽑은 후보를 체크 목록으로 보여 주고, 고른 것만 저장한다(오너 2026-10-28).
 * 자동 추출(설정 › AI › 채팅의 토글)은 확인 없이 저장하지만, 이 수동 경로는 저장 전에 눈으로 보게 한다.
 * `candidates` 가 비어 있으면 "새로 기억할 사실이 없다" 한 줄만 보인다. 저장된 기억 전체 보기는 설정 채팅 페이지가 맡는다.
 */
export function ChatMemoryExtractModal({
  candidates,
  onSave,
  onOpenMemory,
  onClose,
}: {
  candidates: string[];
  onSave: (picked: string[]) => Promise<void> | void;
  /** 없으면 "저장된 기억 보기" 단추를 숨긴다(브라우저/폰 — OS 설정 창이 없다). */
  onOpenMemory?: () => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<number>>(() => new Set(candidates.map((_, i) => i)));
  const [saving, setSaving] = useState(false);

  const toggle = (i: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const save = async () => {
    if (saving || picked.size === 0) return;
    setSaving(true);
    try {
      await onSave(candidates.filter((_, i) => picked.has(i)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title={t("search.chat_memory_extract_title")} onClose={onClose} width={440} busy={saving}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }} data-testid="chat-memory-extract-modal">
        {candidates.length === 0 ? (
          <p data-testid="chat-memory-extract-empty" style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--muted)" }}>
            {t("search.chat_memory_extract_empty")}
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {candidates.map((text, i) => (
              <li key={`${i}-${text}`}>
                <label style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start", fontSize: "var(--text-sm)" }}>
                  <input
                    type="checkbox"
                    checked={picked.has(i)}
                    onChange={() => toggle(i)}
                    data-testid={`chat-memory-extract-item-${i}`}
                  />
                  <span>{text}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: "flex", gap: "var(--space-4)", justifyContent: "space-between", alignItems: "center" }}>
          {onOpenMemory ? (
            <button type="button" className="btn btn--sm" onClick={onOpenMemory} data-testid="chat-memory-extract-open">
              {t("search.chat_memory_extract_open")}
            </button>
          ) : (
            <span />
          )}
          <div style={{ display: "flex", gap: "var(--space-3)" }}>
            <button type="button" className="btn" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </button>
            {candidates.length > 0 && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void save()}
                disabled={saving || picked.size === 0}
                data-testid="chat-memory-extract-save"
              >
                {t("search.chat_memory_extract_save", { n: picked.size })}
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
