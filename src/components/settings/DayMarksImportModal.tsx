import { useState } from "react";
import { call, callSilent, emitNotice, isErrorHandled } from "../../lib/invoke";
import { reportFallback } from "../../lib/diag";
import { t } from "../../i18n/t";
import { icsEventsToDayMarks, parseIcsToEvents, pickIcsFile } from "../../lib/ical";
import { ModalShell } from "../ModalShell";
import { SegGroup } from "./SegGroup";
import { IconAction } from "./IconAction";
import { FormError, FormField, FormStack, FormToggleRow } from "./FormField";
import { IconFolderOpen } from "../icons";
import type { CalendarFetchIcsOutput, CalendarSourceSaveOutput } from "../../lib/commands.gen";

/**
 * 공휴일·기념일 불러오기(.ics 파일 / URL → 표시일) — docs/PLAN-2026-09-19-calendar-schedule.md §4.
 *
 * 입구가 둘인 걸 헷갈리지 않게: 여기는 **표시일**로 받는다(달력의 빨간 날·이름표). 대시보드 달력 헤더와
 * 데이터 관리의 ".ics 가져오기"는 **노트**로 받는다("일정을 노트로 가져오기"). 파서는 둘이 같다
 * (`lib/ical.ts::parseIcsToEvents`). URL 은 Rust 가 받아 온다 — 웹뷰 CSP 가 외부 fetch 를 막는다.
 *
 * 오류는 한 번만 보인다: 사용자 말로 바꾼 실패(받기 실패·받을 것 없음·너무 많음)는 `DayMarksUserError` 로
 * 던져 호출자가 보여주고, 저장(`call()`) 실패는 이미 토스트가 떴으니 호출자가 다시 쓰지 않는다.
 */

/** 사용자에게 그대로 보여줄 불러오기 실패 — `call()` 토스트와 구분하려고 따로 둔다. */
export class DayMarksUserError extends Error {}

/**
 * 불러오기 실패 → 화면에 보일 문구(없으면 null). 사용자 말 실패는 그 문구, `call()` 이 이미 알린
 * 실패는 null, 그 밖(파서 예외 등 예상 못 한 것)은 진단에 남기고 원문을 보여준다 — 조용히 사라지지 않게.
 */
export function dayMarksErrorText(e: unknown): string | null {
  if (e instanceof DayMarksUserError) return e.message;
  if (isErrorHandled(e)) return null;
  const msg = String((e as { message?: string })?.message ?? e);
  reportFallback("day_marks", "import_unexpected", msg.slice(0, 120));
  return msg;
}

/** repo `SOURCE_MAX_MARKS` 와 같은 값 — 넘으면 서버가 저장을 통째로 거부하니 보내기 전에 말한다. */
const SOURCE_MAX_MARKS = 5000;

/** URL 에서 ics 텍스트. 실패는 사용자 말로 바꿔 던진다(원문 오류는 logError 로 남는다). */
export async function fetchIcsText(url: string): Promise<string> {
  try {
    const r = await callSilent<CalendarFetchIcsOutput>("calendar_fetch_ics", { url });
    return r.text;
  } catch {
    throw new DayMarksUserError(t("dayMarks.import_fetch_failed"));
  }
}

/**
 * ics 텍스트 → 출처 저장(새로 또는 `sourceId` 다시 불러오기, 한 트랜잭션 교체). 성공하면 건너뛴 수까지
 * 담은 알림을 띄운다. 받을 것이 없거나 너무 많으면 사용자 말로 던진다 — 저장은 하지 않는다.
 */
export async function saveIcsAsDayMarks(opts: {
  text: string;
  name: string;
  url: string | null;
  sourceId: string | null;
  dayOff: boolean;
  workspaceId: string | null;
}): Promise<void> {
  const { marks, skippedTimed, skippedRule } = icsEventsToDayMarks(parseIcsToEvents(opts.text), opts.dayOff);
  if (marks.length === 0) {
    const parts = [t("dayMarks.import_empty")];
    if (skippedTimed > 0) parts.push(t("dayMarks.import_skipped_timed", { n: skippedTimed }));
    throw new DayMarksUserError(parts.join(" "));
  }
  if (marks.length > SOURCE_MAX_MARKS) {
    throw new DayMarksUserError(t("dayMarks.import_too_many", { n: marks.length, max: SOURCE_MAX_MARKS }));
  }
  const r = await call<CalendarSourceSaveOutput>("calendar_source_save", {
    ...(opts.workspaceId ? { workspace_id: opts.workspaceId } : {}),
    ...(opts.sourceId ? { source_id: opts.sourceId } : {}),
    name: opts.name,
    ...(opts.url ? { url: opts.url } : {}),
    marks,
  });
  const parts = [t("dayMarks.import_done", { n: marks.length - r.skipped })];
  if (skippedTimed > 0) parts.push(t("dayMarks.import_skipped_timed", { n: skippedTimed }));
  if (skippedRule > 0) parts.push(t("dayMarks.import_skipped_rule", { n: skippedRule }));
  if (r.skipped > 0) parts.push(t("dayMarks.import_skipped_invalid", { n: r.skipped }));
  emitNotice(parts.join(" "));
}

/** URL 의 호스트 — 이름 칸 기본값. 못 읽으면 빈 문자열. */
export function hostOf(url: string): string {
  try {
    return new URL(url.trim().replace(/^webcal:\/\//i, "https://")).host;
  } catch {
    return "";
  }
}

function stripExt(name: string): string {
  return name.replace(/\.ics$/i, "");
}

export function DayMarksImportModal({
  workspaceId,
  onClose,
  onSaved,
}: {
  workspaceId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [from, setFrom] = useState<"file" | "url">("file");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  /** 사용자가 이름을 직접 고쳤으면 파일/주소를 바꿔도 덮지 않는다. */
  const [nameTouched, setNameTouched] = useState(false);
  const [dayOff, setDayOff] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    const f = await pickIcsFile();
    if (!f) return;
    setFile(f);
    if (!nameTouched) setName(stripExt(f.name));
  };

  const submit = async () => {
    const trimmedUrl = url.trim();
    if (from === "file" && !file) return setError(t("dayMarks.import_err_file"));
    if (from === "url" && !trimmedUrl) return setError(t("dayMarks.import_err_url"));
    if (!name.trim()) {
      // "not a url" 처럼 못 읽는 주소는 hostOf() 가 ""를 돌려주고, 그 값을 그대로 받는 이름 칸도
      // 비어 있는 채로 남는다 — 그대로 두면 진짜 원인(주소)이 아니라 손도 안 댄 이름 칸을 탓하는
      // 문구가 뜬다. 이름이 빈 게 주소 파싱 실패 탓일 때만 주소 쪽을 먼저 말한다 — 사용자가 이름을
      // 직접 지운 경우(주소는 멀쩡)는 기존대로 이름 오류를 보여준다.
      if (from === "url" && !hostOf(trimmedUrl)) return setError(t("dayMarks.import_err_url"));
      return setError(t("dayMarks.import_err_name"));
    }
    setBusy(true);
    setError(null);
    try {
      const text = from === "file" ? file!.text : await fetchIcsText(trimmedUrl);
      await saveIcsAsDayMarks({
        text,
        name: name.trim(),
        url: from === "url" ? trimmedUrl : null,
        sourceId: null,
        dayOff,
        workspaceId,
      });
      onSaved();
      onClose();
    } catch (e: unknown) {
      // 저장(call()) 실패는 토스트가 이미 떴다 — 그 밖의 실패만 폼 아래에.
      const msg = dayMarksErrorText(e);
      if (msg) setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={t("dayMarks.import_title")}
      onClose={onClose}
      // 받거나 저장하는 중엔 X·Escape·바깥 클릭 어느 길로도 닫히지 않는다(취소 버튼도 꺼진다).
      busy={busy}
      width={480}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)" }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy} data-testid="day-marks-import-cancel">
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={busy}
            aria-busy={busy || undefined}
            data-testid="day-marks-import-submit"
          >
            {t("dayMarks.import_submit")}
          </button>
        </div>
      }
    >
      <FormStack>
        <FormField as="div" label={t("dayMarks.import_from")}>
          <SegGroup
            value={from}
            onChange={(v) => {
              setFrom(v);
              setError(null);
            }}
            ariaLabel={t("dayMarks.import_from")}
            options={[
              { value: "file", label: t("dayMarks.import_from_file") },
              { value: "url", label: t("dayMarks.import_from_url") },
            ]}
          />
        </FormField>

        {from === "file" ? (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", minWidth: 0 }}>
            <IconAction
              icon={<IconFolderOpen size={16} strokeWidth={1.8} />}
              label={t("dayMarks.import_pick_file")}
              size="lg"
              onClick={() => void pick()}
              data-testid="day-marks-import-pick"
            />
            <span
              style={{
                fontSize: "var(--text-sm)",
                color: file ? "var(--text)" : "var(--muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              data-testid="day-marks-import-file-name"
            >
              {file ? file.name : t("dayMarks.import_no_file")}
            </span>
          </div>
        ) : (
          <FormField label={t("dayMarks.import_url")}>
            <input
              type="url"
              className="field"
              value={url}
              placeholder={t("dayMarks.import_url_placeholder")}
              onChange={(e) => {
                setUrl(e.target.value);
                if (!nameTouched) setName(hostOf(e.target.value));
              }}
              data-testid="day-marks-import-url"
            />
          </FormField>
        )}

        <FormField label={t("dayMarks.import_name")}>
          <input
            type="text"
            className="field"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            data-testid="day-marks-import-name"
          />
        </FormField>

        <FormToggleRow
          label={t("dayMarks.import_day_off")}
          hint={t("dayMarks.import_day_off_hint")}
          checked={dayOff}
          onChange={setDayOff}
          data-testid="day-marks-import-day-off"
        />

        {error && <FormError data-testid="day-marks-import-error">{error}</FormError>}
      </FormStack>
    </ModalShell>
  );
}
