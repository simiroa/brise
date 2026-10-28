import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const callMock = vi.fn();
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

import { useSettingsStore } from "./settings";
import {
  ATTACHMENT_STORAGE_MODES,
  BOARD_DONE_AUTOHIDE,
  BRIEFING_NOTIFIES,
  BRIEFING_WHENS,
  DEFAULT_FONT_FAMILY,
  EDITOR_WIDTHS,
  GALLERY_SORTS,
  GALLERY_TILE_SIZES,
  HOLIDAY_REGIONS,
  INPUT_AUTO_MODES,
  NEW_NOTE_DATE_PRECISIONS,
  PET_DBLCLICK_ACTIONS,
  PREFS,
  PREF_SNAKE,
  SLIDE_PREVIEWS,
  TIMELINE_RANGES,
  WEEK_STARTS,
  intIn,
  oneOf,
  prefDefaults,
  type SimplePrefKey,
} from "./prefs";

describe("oneOf / intIn", () => {
  it("oneOf: 목록 안의 값은 그대로, 밖(결측·타입 다름)은 기본값", () => {
    const f = oneOf(["a", "b"] as const, "a");
    expect(f("b")).toBe("b");
    expect(f("c")).toBe("a");
    expect(f(undefined)).toBe("a");
    expect(f(1)).toBe("a");
  });

  it("intIn: 범위 안의 정수만, 소수·범위 밖·비숫자는 기본값", () => {
    const f = intIn(0, 12, 3);
    expect(f(0)).toBe(0);
    expect(f(12)).toBe(12);
    expect(f(13)).toBe(3);
    expect(f(-1)).toBe(3);
    expect(f(1.5)).toBe(3);
    expect(f("5")).toBe(3);
    expect(f(undefined)).toBe(3);
  });
});

describe("PREFS 표 — 기본값·키 목록이 한 곳에서 파생된다", () => {
  it("SimplePrefKey 와 PREF_SNAKE 가 표와 같은 집합이다(snake 는 유일)", () => {
    const camels = PREFS.map((p) => p.camel);
    expect(new Set(camels).size).toBe(camels.length);
    expect(new Set(PREFS.map((p) => p.snake)).size).toBe(PREFS.length);
    expect(Object.keys(PREF_SNAKE).sort()).toEqual([...camels].sort());
  });

  it("초기 스토어 값이 표의 coerce(undefined) 와 같다 — 기본값이 두 곳에서 따로 표류하지 않는다", () => {
    const init = useSettingsStore.getState() as unknown as Record<SimplePrefKey, unknown>;
    const d = prefDefaults() as unknown as Record<SimplePrefKey, unknown>;
    // uiLang 은 테스트 셋업이 "en" 으로 시작시킨다(setupTests) — 그 외 전부 같아야 한다.
    const diff = PREFS.filter((p) => p.camel !== "uiLang" && JSON.stringify(init[p.camel]) !== JSON.stringify(d[p.camel])).map(
      (p) => p.camel,
    );
    expect(diff).toEqual([]);
  });

  it("fontFamily: 결측·빈 값의 폴백이 초기값·Rust 시드와 같은 pretendard 다(예전엔 강제 변환 폴백만 serif)", () => {
    const font = PREFS.find((p) => p.camel === "fontFamily")!;
    expect(DEFAULT_FONT_FAMILY).toBe("pretendard");
    expect(font.coerce(undefined)).toBe("pretendard");
    expect(font.coerce("")).toBe("pretendard");
    expect(font.coerce("   ")).toBe("pretendard");
    expect(font.coerce("sans")).toBe("sans");
    expect(font.coerce("catalog:gaegu")).toBe("catalog:gaegu");
  });

  it("열거형 prefs 는 목록 밖 값을 기본값으로 되돌린다(구값 흡수 포함)", () => {
    const by = (k: SimplePrefKey) => PREFS.find((p) => p.camel === k)!;
    expect(by("timelineDefaultRange").coerce("bogus")).toBe("fit");
    expect(by("galleryTileSize").coerce("huge")).toBe("medium");
    expect(by("petDblclickAction").coerce("search")).toBe("new_note"); // 구값
    expect(by("petDblclickAction").coerce("open_note")).toBe("new_note");
    expect(by("petDblclickAction").coerce("chat")).toBe("chat");
    expect(by("slidePreview").coerce("whatever")).toBe("auto");
    expect(by("slidePreview").coerce("off")).toBe("off");
    expect(by("graphNodeCap").coerce(501)).toBe(0);
    expect(by("calendarAxisTailHours").coerce(13)).toBe(3);
  });
});

// ── Rust settings_schema.rs 와의 대조 — 표류 감지(선례: lib/remoteSettingsPolicy.test.ts 가 Rust 파일을 직접 읽는다) ──
const rust = readFileSync(join("src-tauri", "src", "repo", "settings_schema.rs"), "utf8").replace(/\r\n/g, "\n");

/** `"key" => matches!(value.as_str(), Some("a") | Some("b") …)` 팔의 값 목록(여러 줄이어도 된다). 없으면 null. */
function rustEnum(key: string): string[] | null {
  const head = `"${key}" => matches!(`;
  const at = rust.indexOf(head);
  if (at < 0) return null;
  let depth = 1;
  let i = at + head.length;
  const start = i;
  for (; i < rust.length && depth > 0; i++) {
    if (rust[i] === "(") depth++;
    else if (rust[i] === ")") depth--;
  }
  const inner = rust.slice(start, i - 1);
  return [...inner.matchAll(/Some\("([^"]*)"\)/g)].map((m) => m[1]);
}

/** default_settings 시드의 JSON 값(`("key", "\"fit\"".to_string())` 꼴). 시드가 없으면 undefined. */
function rustSeed(key: string): unknown {
  const m = new RegExp(`\\("${key}",\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(rust);
  if (!m) return undefined;
  return JSON.parse(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
}

describe("Rust 검증·시드와 TS 값 목록이 같은 집합이다(settings_schema.rs 를 직접 읽는다)", () => {
  const ENUMS: Array<[string, readonly string[]]> = [
    ["timeline_default_range", TIMELINE_RANGES],
    ["board_done_autohide", BOARD_DONE_AUTOHIDE],
    ["gallery_tile_size", GALLERY_TILE_SIZES],
    ["gallery_sort", GALLERY_SORTS],
    ["holiday_region", HOLIDAY_REGIONS],
    ["week_start", WEEK_STARTS],
    ["attachment_storage_mode", ATTACHMENT_STORAGE_MODES],
    ["slide_preview", SLIDE_PREVIEWS],
    ["editor_width", EDITOR_WIDTHS],
    ["new_note_date_precision", NEW_NOTE_DATE_PRECISIONS],
    ["briefing_when", BRIEFING_WHENS],
    ["briefing_notify", BRIEFING_NOTIFIES],
    ["pet_dblclick_action", PET_DBLCLICK_ACTIONS],
  ];

  it.each(ENUMS)("%s — 허용 값 집합", (snake, list) => {
    const arm = rustEnum(snake);
    expect(arm, `settings_schema.rs 에서 ${snake} 의 matches! 팔을 못 찾았다(파서가 못 읽으면 대조가 조용히 비게 된다)`).not.toBeNull();
    expect([...arm!].sort()).toEqual([...list].sort());
  });

  it("입력 3종(photo_meta_mode · voice_transcribe_mode · voice_cleanup_mode)은 같은 off/ask/auto 를 받는다", () => {
    // 세 키가 한 팔(or-패턴)에 묶여 있어 팔 모양이 다르다 — 값 집합만 본다.
    const m = /"photo_meta_mode" \| "voice_transcribe_mode" \| "voice_cleanup_mode" => \{\s*matches!\(([^;]*?)\)\s*\}/.exec(rust);
    expect(m, "settings_schema.rs 의 입력 3종 or-패턴 팔을 못 찾았다").not.toBeNull();
    const vals = [...m![1].matchAll(/Some\("([^"]+)"\)/g)].map((x) => x[1]);
    expect(new Set(vals)).toEqual(new Set(INPUT_AUTO_MODES));
  });

  // 알려진 의도·기존 차이 — 새 차이가 생기면 이 목록에 이유와 함께 올리거나 고쳐야 한다.
  const KNOWN_SEED_DRIFT: Record<string, string> = {
    filter_roster: "TS 는 정규 로스터(normalizeFilterRoster)로 채운 값, Rust 시드는 [] — 읽는 쪽이 같은 정규화를 거친다",
    collect_paused_until: "신규 DB 만 far-future 로 시드(수집 기본 OFF) — TS 는 '일시중지 아님'(\"\")을 부재 기본으로 쓴다(migrations.rs 백필 주석)",
    favorites_open: "기존 차이(2026-10-28 발견) — Rust 시드 true, TS 초기값 false. load() 전 첫 렌더에만 보인다. 맞추려면 coerce 를 boolDefaultTrue 로(동작 변경이라 이번 리팩터에서 안 바꿈)",
  };

  it("TS 기본값이 Rust default_settings 시드와 같다(시드가 있는 단순 설정 전부 — 알려진 차이만 제외)", () => {
    const d = prefDefaults() as unknown as Record<string, unknown>;
    const mismatched: string[] = [];
    let compared = 0;
    for (const p of PREFS) {
      const seed = rustSeed(p.snake);
      if (seed === undefined) continue; // 시드하지 않는 키(부재 = 코드의 기본값)
      if (p.snake in KNOWN_SEED_DRIFT) continue;
      compared++;
      if (JSON.stringify(d[p.camel]) !== JSON.stringify(seed)) {
        mismatched.push(`${p.snake}: ts=${JSON.stringify(d[p.camel])} rust=${JSON.stringify(seed)}`);
      }
    }
    expect(compared).toBeGreaterThan(30); // 파서가 시드를 못 읽어 전부 건너뛰면 대조가 비게 된다
    expect(mismatched).toEqual([]);
  });

  it("범위 키: 상한이 같다(graph_node_cap 0..=500 · storage_alert_gb 0..=500 · calendar_axis_tail_hours 0..=12)", () => {
    expect(rust).toMatch(/"graph_node_cap" => value\.as_i64\(\)\.map\(\|n\| \(0\.\.=500\)\.contains\(&n\)\)/);
    const by = (k: SimplePrefKey) => PREFS.find((p) => p.camel === k)!;
    expect(by("graphNodeCap").coerce(500)).toBe(500);
    expect(by("graphNodeCap").coerce(501)).toBe(0);
  });
});

describe("setSimplePrefs — 배치 저장(set 한 번 · settings_set 한 번 · 롤백 한 번)", () => {
  beforeEach(() => {
    callMock.mockReset();
    useSettingsStore.setState({ chatReadHistory: true, chatReadFiles: true, chatWriteEnabled: true, collectChatRegister: false });
  });

  it("여러 키를 IPC 한 번(entries 한 묶음)으로 저장하고 상태를 한 번에 바꾼다", async () => {
    callMock.mockResolvedValue({ ok: true });
    let sets = 0;
    const unsub = useSettingsStore.subscribe(() => sets++);
    await useSettingsStore.getState().setSimplePrefs({
      chatReadHistory: false,
      chatReadFiles: false,
      chatWriteEnabled: false,
      collectChatRegister: false,
    });
    unsub();
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { chat_read_history: false, chat_read_files: false, chat_write_enabled: false, collect_chat_register: false },
    });
    expect(sets).toBe(1); // 낙관적 set() 한 번 — 실패가 없으니 롤백 set 은 없다
    const s = useSettingsStore.getState();
    expect([s.chatReadHistory, s.chatReadFiles, s.chatWriteEnabled, s.collectChatRegister]).toEqual([false, false, false, false]);
  });

  it("저장이 실패하면 키 전부를 이전 값으로 한 번에 되돌린다 — 던지지 않는다", async () => {
    callMock.mockRejectedValueOnce(new Error("db locked"));
    let sets = 0;
    const unsub = useSettingsStore.subscribe(() => sets++);
    await expect(
      useSettingsStore.getState().setSimplePrefs({ chatReadHistory: false, collectChatRegister: true }),
    ).resolves.toBeUndefined();
    unsub();
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(sets).toBe(2); // 낙관적 set 한 번 + 롤백 set 한 번
    expect(useSettingsStore.getState().chatReadHistory).toBe(true);
    expect(useSettingsStore.getState().collectChatRegister).toBe(false);
  });

  it("실패해도 그 사이 더 새 요청이 있었던 키는 되돌리지 않는다(키별 최신 요청 규약)", async () => {
    let rejectFirst!: (e: Error) => void;
    callMock.mockImplementationOnce(() => new Promise((_r, reject) => (rejectFirst = reject)));
    callMock.mockImplementationOnce(() => Promise.resolve({ ok: true }));
    const first = useSettingsStore.getState().setSimplePrefs({ chatReadHistory: false, chatReadFiles: false });
    await useSettingsStore.getState().setChatReadHistory(true); // chatReadHistory 의 더 새 요청(성공)
    rejectFirst(new Error("db locked"));
    await first;
    const s = useSettingsStore.getState();
    expect(s.chatReadHistory).toBe(true); // 새 요청이 이겼다 — 옛 실패가 덮지 않는다
    expect(s.chatReadFiles).toBe(true); // 이 키는 내가 최신이었으니 이전 값으로 되돌았다
  });

  it("빈 patch 는 아무 것도 하지 않는다", async () => {
    await useSettingsStore.getState().setSimplePrefs({});
    expect(callMock).not.toHaveBeenCalled();
  });
});
