import {
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { CalendarItem } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { Select, type SelectOption } from "../../Select";
import { weekdayShortLabels } from "../dateFmt";
import { parseTimeInput } from "../../titlebar/eventDate";
import {
  scheduleLabels,
  parseRruleForUi,
  REPEAT_OPTIONS,
  WEEKDAY_CODES,
  type RepeatDraft,
  type RepeatFreq,
} from "../../titlebar/scheduleRrule";

/** 펼친 설정 안의 입력 크기 — 칩 스케일(`--ctrl-h-sm` + `--text-xs`)에 맞춘다. `.field` 기본값
 *  (`--ctrl-h-lg` + `--text-md`)은 칩보다 9px 높고 글자도 2px 커서 칩 아래에 다른 덩치의
 *  컨트롤이 나온다 — NoteDatesList 가 같은 이유로 같은 보정을 갖고 있다. */
const CHIP_FIELD: CSSProperties = {
  minHeight: "var(--ctrl-h-sm)",
  height: "var(--ctrl-h-sm)",
  padding: "0 var(--space-2)",
  fontSize: "var(--text-xs)",
  flex: "none",
  width: "5ch",
  textAlign: "center",
  color: "var(--accent)",
  fontVariantNumeric: "tabular-nums",
};

export interface ChipScheduleProps {
  /** 바깥 클릭 판정용 — 영역을 아는 것은 이 메뉴고, 리스너는 축이 갖는다(TimeAxis 의 effect). */
  menuRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  item: CalendarItem;
  /** 하루짜리 항목만 끝 시각을 갖는다 — 여러 날 span 의 end_time 은 마지막 날의 것이다(§1.3 I3).
   *  쓰기 쪽 방어는 commitChipTime 이 DB 행으로 한 번 더 한다. */
  resizable: boolean;
  uiLang: string;
  field: "time" | "repeat" | null;
  onToggleField: (field: "time" | "repeat") => void;
  onTime: (part: "start" | "end", value: string | null) => void;
  /** D4(그릴 2026-09-11) — 초안이 바뀔 때마다가 아니라 "적용"을 눌렀을 때만 한 번 온다. */
  onRepeatApply: (draft: RepeatDraft) => void;
}

/**
 * W11 ④ / W12 ③ — 칩의 설정 메뉴. 칩 **아래에 떠 있는 작은 플로팅 메뉴**다(칩 wrapper 가
 * position:absolute 라 그 자체가 이 절대 배치의 기준점이다). W11 에서는 칩 안에서 흐름으로
 * 자랐지만 그러면 칩의 height 가 늘어나고, 그 height 는 **그 일정의 길이**라 "일정이 길어졌다"는
 * 거짓 정보가 된다 — 오너 실기 결정 2026-09-11.
 *
 * **이 저장소의 일반 원칙은 "모달/팝오버 중첩 금지"지만, 이번 건 오너가 명시적으로 요청한
 * 예외다**(오너 결정 2026-09-11, 이유: 칩 높이가 일정 길이를 나타내므로 늘리면 안 된다).
 * 예외는 이 한 겹까지다 — 이 메뉴 **안에서 또 팝오버/모달을 열지 않는다**. 반복 편집기
 * (ChipRepeatEditor)도 따로 뜨는 3단 메뉴가 아니라 이 메뉴 안의 인라인이다.
 *
 * 모양은 노트 쪽의 같은 편집(NoteDatesList 의 알림 칩 줄)을 그대로 따라간다 — 같은 일이 두
 * 화면에서 다르게 보이지 않게.
 * ponytail: 위로 뒤집히지 않는다(항상 top:100%). 23시대 칩이면 축 스크롤러가 조금 더 구를 뿐
 * 잘리지는 않는다 — 뒤집기가 필요해지면 그때.
 *
 * 그 파일의 컴포넌트를 export 해 오지 않고 여기 다시 쓴 이유는 두 가지다: 그것들은 private 이고
 * (공유 파일을 흔드는 값이 15줄보다 크다), 저 줄은 알림 시점 칩까지 셋인데 여기는 오너가 말한
 * **시각·반복 둘**이다. 로직(파싱·조립)은 한 줄도 복제하지 않았다 — parseTimeInput ·
 * parseRruleForUi · buildRrule 을 그대로 가져다 쓴다.
 *
 * 반복 종료일(UNTIL) 입력은 **없다** — 네이티브 date picker 가 OS 달력을 띄우는데 이 화면은 그
 * 자체가 앱 달력이라 달력이 둘이 된다(NoteDatesList 의 같은 결정과 같은 이유). 이미 저장된
 * UNTIL 은 parseRruleForUi → buildRrule 왕복으로 그대로 살아남는다.
 */
export function ChipSchedule({
  menuRef,
  onClose,
  item,
  resizable,
  uiLang,
  field,
  onToggleField,
  onTime,
  onRepeatApply,
}: ChipScheduleProps) {
  const labels = scheduleLabels(item, uiLang);
  return (
    <div
      ref={menuRef}
      data-testid={`cal-chip-menu-${item.note_id}`}
      // 이 **컨테이너 한 곳**에서 포인터·클릭을 삼킨다 — 개별 입력마다 걸지 않는다. 입력에 캐럿을
      // 놓으려던 손짓이 칩을 옮기거나(드래그) 노트를 열면(더블클릭) 안 된다. 펼친 칩의 드래그는
      // onChipPointerDown 이 이미 막고 있으니 이건 두 겹째 안전망이다(메뉴가 칩 밖으로 떠도
      // 그 칩 자체를 잡아 끄는 것은 여전히 막아야 한다 — 그 조기 반환은 그대로다).
      onPointerDown={(ev) => ev.stopPropagation()}
      onClick={(ev) => ev.stopPropagation()}
      onDoubleClick={(ev) => ev.stopPropagation()}
      onKeyDown={(ev) => {
        // ↑/↓·Delete 가 칩의 시각을 바꾸지 않는다. Escape 만 예외로 **막지 않는다** — 그대로
        // window 까지 올라가 축의 dismiss 가 메뉴를 닫는다(칩 wrapper 는 Escape 를 쓰지 않아
        // 새는 곳이 없다). 여기서 직접 닫기도 한다: React 루트에서 전파가 끊기는 환경이라도
        // 메뉴 안의 Escape 가 확실히 닫히게.
        if (ev.key === "Escape") {
          onClose();
          return;
        }
        ev.stopPropagation();
      }}
      style={{
        // W12 ③ — 칩 아래로 떠 있는 메뉴(칩 wrapper 가 기준점). 칩의 height 를 건드리지 않는
        // 유일한 방법이다. zIndex 3 은 칩(1)·현재 시각 선(1)보다 확실히 위이면서 지역 스태킹
        // 범위(0~3) 안이다 — 축 바깥으로 나가는 레이어가 아니므로 --z-* 토큰이 아니다.
        position: "absolute",
        top: "100%",
        left: 0,
        right: 0,
        zIndex: 3,
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-1)",
        // 떠 있으므로 불투명해야 읽힌다 — 아래 칩 위에 겹친다.
        // 정정(그릴 2026-09-13): 축 칩과 같은 이유로 `var(--bg)` 대신 `var(--surface-base)`
        // (알파 없는 단일 톤) — 색 구조 C1 이후 `--bg`는 캔버스 질감+글로우 합성값이라 이런
        // 작은 뜬 표면에 얹으면 배경과 섞여 보인다.
        background: "var(--surface-base)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-sm)",
        boxShadow: "var(--shadow-md)",
        padding: "var(--space-2)",
        // 칩 본체는 nowrap 이지만 이 안의 요일 토글들은 감겨야 한다.
        whiteSpace: "normal",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-2)" }}>
        {resizable && (
          <button
            type="button"
            className="glowline"
            data-testid={`cal-chip-time-${item.note_id}`}
            data-set={labels.time ? "true" : "false"}
            data-open={field === "time"}
            aria-expanded={field === "time"}
            aria-label={t("editor.time_range_label")}
            onClick={() => onToggleField("time")}
          >
            <span className="glowline-value">{labels.time ?? t("editor.chip_add_time")}</span>
          </button>
        )}
        <button
          type="button"
          className="glowline"
          data-testid={`cal-chip-repeat-${item.note_id}`}
          data-set={labels.repeat ? "true" : "false"}
          data-open={field === "repeat"}
          aria-expanded={field === "repeat"}
          aria-label={t("editor.repeat")}
          onClick={() => onToggleField("repeat")}
          // 시각 칩이 없는 여러 날 span 에서는 반복 칩이 줄을 다 쓴다(빈 칸을 남기지 않는다).
          style={resizable ? undefined : { gridColumn: "1 / -1" }}
        >
          <span className="glowline-value">{labels.repeat ?? t("editor.chip_add_repeat")}</span>
        </button>
      </div>
      {field === "time" && resizable && <ChipTimeEditor item={item} onTime={onTime} />}
      {field === "repeat" && <ChipRepeatEditor item={item} uiLang={uiLang} onApply={onRepeatApply} />}
    </div>
  );
}

/** 시각 입력 — 네이티브 `<input type="time">` 이 아닌 텍스트다. 이유는 NoteDatesList 쪽과 같다
 *  (칩은 24시제인데 피커는 로케일 표기 + OS 시계가 뜬다). 빈 입력 = 해제, 파싱 실패 = 커밋 없이
 *  직전 값으로 되돌리기 — 그 구분은 parseTimeInput 이 아니라 이 두 줄이 짓고, 뭉개면 오타가
 *  저장된 시각을 조용히 지운다. */
function ChipTimeEditor({
  item,
  onTime,
}: {
  item: CalendarItem;
  onTime: (part: "start" | "end", value: string | null) => void;
}) {
  const [startText, setStartText] = useState(item.start_time ?? "");
  const [endText, setEndText] = useState(item.end_time ?? "");

  const commit = (
    part: "start" | "end",
    text: string,
    setText: (v: string) => void,
    saved: string | null,
  ) => {
    const trimmed = text.trim();
    if (trimmed === "") {
      setText("");
      onTime(part, null);
      return;
    }
    const parsed = parseTimeInput(trimmed);
    if (parsed === null) {
      setText(saved ?? "");
      return;
    }
    setText(parsed);
    onTime(part, parsed);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
      <input
        type="text"
        inputMode="numeric"
        placeholder="00:00"
        className="field field--seamless"
        aria-label={t("editor.time_start")}
        data-testid={`cal-chip-start-time-${item.note_id}`}
        value={startText}
        onChange={(ev) => setStartText(ev.target.value)}
        onBlur={() => commit("start", startText, setStartText, item.start_time)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            commit("start", startText, setStartText, item.start_time);
          }
        }}
        style={CHIP_FIELD}
      />
      <span aria-hidden style={{ color: "var(--muted)", flex: "none" }}>{"–"}</span>
      <input
        type="text"
        inputMode="numeric"
        placeholder="00:00"
        className="field field--seamless"
        aria-label={t("editor.time_end")}
        data-testid={`cal-chip-end-time-${item.note_id}`}
        value={endText}
        onChange={(ev) => setEndText(ev.target.value)}
        onBlur={() => commit("end", endText, setEndText, item.end_time)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            commit("end", endText, setEndText, item.end_time);
          }
        }}
        style={CHIP_FIELD}
      />
    </div>
  );
}

/**
 * 반복 입력 — RRULE 네 필드(freq/interval/byday/until)는 한 입력에 안 담기므로 지역 초안을
 * 갖는다.
 *
 * D4(그릴 2026-09-11) — 예전엔 고를 때마다 즉시 커밋했다. 이제는 **초안 → 적용**: 필드를
 * 만지는 동안은 이 지역 state 만 바뀌고, 맨 아래 "적용" 버튼을 눌러야 비로소 부모(TimeAxis)에
 * onApply(draft) 가 올라간다 — 거기서부터 확인 다이얼로그 → 저장(DayDetailPanel.resolveRepeatApply)
 * 으로 이어진다. "변경만으로는 저장되지 않는다"는 요구가 이 한 줄의 분리다.
 */
function ChipRepeatEditor({
  item,
  uiLang,
  onApply,
}: {
  item: CalendarItem;
  uiLang: string;
  onApply: (draft: RepeatDraft) => void;
}) {
  const [repeat, setRepeat] = useState<RepeatDraft>(() => parseRruleForUi(item.rrule));
  const weekdayLabels = weekdayShortLabels(uiLang);
  const repeatOptions: SelectOption[] = REPEAT_OPTIONS.map((o) => ({
    value: o.value,
    label: t(o.labelKey),
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)" }}>
        <Select
          value={repeat.freq}
          onChange={(v) => setRepeat({ ...repeat, freq: v as RepeatFreq })}
          options={repeatOptions}
          ariaLabel={t("editor.repeat")}
          testid={`cal-chip-repeat-select-${item.note_id}`}
          className="chip-btn"
        />
        {repeat.freq !== "none" && (
          <input
            type="number"
            min={1}
            max={999}
            className="field"
            data-testid={`cal-chip-interval-${item.note_id}`}
            value={repeat.interval}
            onChange={(ev) => setRepeat({ ...repeat, interval: ev.target.value })}
            style={{ ...CHIP_FIELD, color: "inherit" }}
          />
        )}
        {repeat.freq === "WEEKLY" && (
          <div style={{ display: "flex", gap: "var(--space-1)" }}>
            {WEEKDAY_CODES.map((code, i) => {
              const active = repeat.byday.includes(code);
              return (
                <button
                  key={code}
                  type="button"
                  data-testid={`cal-chip-byday-${code}-${item.note_id}`}
                  aria-pressed={active}
                  onClick={() =>
                    setRepeat({
                      ...repeat,
                      byday: active
                        ? repeat.byday.filter((d) => d !== code)
                        : [...repeat.byday, code],
                    })
                  }
                  style={{
                    // 생 px 이 아니라 칩과 같은 토큰 — 글꼴 배율을 올리면 줄이 어긋난다.
                    width: "var(--ctrl-h-sm)",
                    height: "var(--ctrl-h-sm)",
                    padding: 0,
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--line)",
                    background: active ? "var(--accent)" : "transparent",
                    color: active ? "var(--on-solid)" : "var(--text)",
                    fontSize: "var(--text-xs)",
                    cursor: "pointer",
                  }}
                >
                  {weekdayLabels[i]}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <button
        type="button"
        className="btn btn-sm"
        data-testid={`cal-chip-repeat-apply-${item.note_id}`}
        style={{ alignSelf: "flex-start" }}
        onClick={() => onApply(repeat)}
      >
        {t("common.apply")}
      </button>
    </div>
  );
}
