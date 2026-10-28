import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { DEFAULT_APPEARANCE_SEED } from "../../lib/appearance";
import { catalogIdOf, catalogValue, fontStack, previewFamily, DEFAULT_FONT_MONO } from "../../lib/fonts/stacks";
import type { CatalogFont } from "../../lib/fonts/loader";
import { call, callSilent } from "../../lib/invoke";
import { isBrowser } from "../../lib/env";
import { t } from "../../i18n/t";
import { SettingsRow } from "./SettingsRow";
import { Select, type SelectOption } from "../Select";
import { SETTINGS_CTRL_WIDTH } from "./shared";

/**
 * 글꼴 고르기 한 줄 — docs/PLAN-2026-10-27-fonts.md §8 W5. 세 손잡이가 같은 줄을 쓴다:
 * 앱 화면 글꼴(font_family) · 노트 본문 글꼴(font_editor, Q2 — 손글씨·장식은 여기만) · 코드 글꼴(font_mono, Q3).
 *
 * 목록 = 번들 글꼴 + 윈도우 대표 시스템 글꼴 + 내려받기 카탈로그(받지 않은 것은 크기 표시, 고르면 받은 뒤 적용)
 * + "내 PC 글꼴에서 고르기"(queryLocalFonts, 안 되면 직접 입력) + 직접 입력.
 * 카탈로그(75KB)는 설정 창 부팅 번들에 넣지 않으려고 동적 import 한다.
 */

export type FontTarget = "ui" | "editor" | "mono";

const FONT_CUSTOM = "__custom__";
const FONT_SYSTEM = "__system__";
/** 노트 본문 글꼴의 "앱 화면 글꼴과 같게" — 저장값 "". Select 값은 빈 문자열을 못 쓰는 일이 없게 따로 둔다. */
const FONT_SAME = "__same__";

/** Bundled 3 + Windows-Korean representative system fonts. Uninstalled names fall back honestly.
 *  "Pretendard" 시스템 글꼴 항목은 2026-09-09 에 번들 "pretendard" 로 승격됐다 — 설치돼 있어야
 *  보이던 것이 이제 앱이 들고 다니는 기본값이라, 같은 이름의 시스템 항목은 중복이라 뺐다. */
const CURATED_TEXT: Array<{ value: string; label: () => string }> = [
  { value: "pretendard", label: () => t("settings.font_pretendard") },
  { value: "serif", label: () => t("settings.font_serif") },
  { value: "sans", label: () => t("settings.font_sans") },
  { value: "Malgun Gothic", label: () => t("settings.font_malgun") },
  { value: "Gulim", label: () => t("settings.font_gulim") },
  { value: "Batang", label: () => t("settings.font_batang") },
  { value: "NanumGothic", label: () => t("settings.font_nanum") },
  { value: "Segoe UI", label: () => t("settings.font_segoe") },
];
// 고유명사라 i18n 하지 않는다(카탈로그 이름과 같은 취급).
const CURATED_MONO: Array<{ value: string; label: () => string }> = [
  { value: DEFAULT_FONT_MONO, label: () => "Source Code Pro" },
  { value: "paper-mono", label: () => "Paper Mono" },
];

const CONFIG = {
  ui: { key: "fontFamily", setter: "setFontFamily", testid: "settings-font-family", anchor: "font_family", labelKey: "settings.font_family", fallback: DEFAULT_APPEARANCE_SEED.fontFamily },
  editor: { key: "fontEditor", setter: "setFontEditor", testid: "settings-font-editor", anchor: "font_editor", labelKey: "settings.font_editor", fallback: "" },
  mono: { key: "fontMono", setter: "setFontMono", testid: "settings-font-mono", anchor: "font_mono", labelKey: "settings.font_mono", fallback: DEFAULT_FONT_MONO },
} as const;

/** font_status 응답에서 받은 목록 — 모양이 어긋나면(구 바이너리·목) 빈 목록. */
function installedOf(s: unknown): string[] {
  const v = (s as { installed?: unknown } | null)?.installed;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function formatMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

/** 카탈로그·받은 목록 — 행 셋이 한 번만 부르도록 모듈 단위로 나눠 쓴다. */
let catalogPromise: Promise<typeof import("../../lib/fonts/loader")> | null = null;
function loadCatalogModule() {
  catalogPromise ??= import("../../lib/fonts/loader").catch((e: unknown) => {
    catalogPromise = null;
    throw e;
  });
  return catalogPromise;
}

export function FontPickerRow({ target }: { target: FontTarget }) {
  const cfg = CONFIG[target];
  const value = useSettingsStore((s) => s[cfg.key]);
  const setFont = useSettingsStore((s) => s[cfg.setter]);
  const curated = target === "mono" ? CURATED_MONO : CURATED_TEXT;

  const [catalog, setCatalog] = useState<CatalogFont[]>([]);
  const [installed, setInstalled] = useState<string[]>([]);
  const [loaderMod, setLoaderMod] = useState<typeof import("../../lib/fonts/loader") | null>(null);
  // 받는 중인 값과 진행률 — null = 받는 것 없음. failed = 마지막 받기 실패(다시 시도 버튼).
  const [pending, setPending] = useState<{ value: string; pct: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null);

  const isKnown = (v: string) =>
    v === "" ? target === "editor" : curated.some((c) => c.value === v) || catalogIdOf(v) !== null;

  // 직접 입력 모드는 화면 상태지만 **저장값을 따라간다** — 초기화·불러오기·되돌리기·다른 창·저장 실패 롤백으로
  // 글꼴이 바깥에서 바뀌면 드롭다운과 입력 칸을 저장값에 다시 맞춘다. "직접 입력"만 고르고 아직 확정하지
  // 않은 상태는 저장값이 그대로라 이 effect 가 건드리지 않는다.
  const [customMode, setCustomMode] = useState(() => !isKnown(value));
  const [customInput, setCustomInput] = useState(() => (isKnown(value) ? "" : value));
  useEffect(() => {
    const custom = !isKnown(value);
    setCustomMode(custom);
    setCustomInput(custom ? value : "");
  }, [value]);

  useEffect(() => {
    if (isBrowser()) return; // 동기화 뷰어: fonts_* 는 http:false
    let alive = true;
    void loadCatalogModule()
      .then(async (m) => {
        // 설치본에 든 글꼴(BUNDLED_IDS)은 받지 않아도 받은 것으로 센다.
        const list = [...new Set([...installedOf(await callSilent("font_status")), ...m.BUNDLED_IDS])];
        if (!alive) return;
        setLoaderMod(m);
        const cat = m.catalogFor(target);
        setCatalog(cat);
        setInstalled(list);
        // 목록 미리보기 — 받은 것·안 받은 것·설치본 내장 가리지 않고 전부 이름 글자만 든 작은 파일로 자기 글꼴처럼 보인다.
        // 받은 글꼴 본 파일을 여기서 전부 .load() 하지 않는다(열 때마다 약 0.8MB+). 현재 선택값은 설정 창의
        // applyCssVars 가 이미 등록하고, 목록 항목은 그려질 때 브라우저가 미리보기 파일만 지연 로드한다.
        void m.loadPreviews(cat.map((f) => f.id));
      })
      // silent-ok: 카탈로그 목록은 선택 사항 — callSilent 가 진단에 남기고, 번들·시스템 글꼴 목록은 그대로 쓸 수 있다.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [target]);

  // 받는 중이면 진행률을 본다. 끝나면 등록 기억을 지우고(새 파일로 다시 등록) 그 글꼴을 고른다.
  useEffect(() => {
    if (!pending) return;
    const id = catalogIdOf(pending.value)!;
    // 그 사이 사용자가 다른 글꼴을 골라 pending 이 비었거나 바뀌었으면 이미 날아간 조회의 늦은 응답이 나중 선택을
    // 덮어쓰지 못하게 한다(clearInterval 은 새 틱만 막는다).
    let cancelled = false;
    const timer = window.setInterval(() => {
      void callSilent<{ downloading?: Record<string, number> }>("font_status")
        .then((s) => {
          if (cancelled) return;
          const list = installedOf(s);
          const pct = s?.downloading?.[id];
          if (list.includes(id)) {
            window.clearInterval(timer);
            setInstalled(list);
            loaderMod?.forgetFont(pending.value);
            setPending(null);
            void setFont(pending.value);
          } else if (typeof pct !== "number") {
            window.clearInterval(timer);
            setPending(null);
            setFailed(pending.value);
          } else if (pct !== pending.pct) {
            setPending({ value: pending.value, pct });
          }
        })
        // silent-ok: 한 번의 조회 실패는 다음 틱이 다시 묻는다(callSilent 가 진단에 남긴다).
        .catch(() => {});
    }, 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pending, loaderMod, setFont]);

  // 받는 중이던 글꼴·실패 표시를 버린다 — 사용자가 새로 명시적으로 고른 글꼴이 받기 완료(setFont(pending.value))에 덮이지 않게.
  // 새 받기를 시작하는 startDownload 는 자기 pending 을 await 뒤에 새로 세우므로 이 호출이 앞서도 안전하다.
  const dropPending = () => {
    setPending(null);
    setFailed(null);
  };

  const startDownload = async (v: string) => {
    setFailed(null);
    try {
      await call("font_download", { id: catalogIdOf(v) });
      setPending({ value: v, pct: 0 });
    } catch {
      setFailed(v); // call() 이 토스트를 띄웠다 — 여기선 다시 시도 버튼만 남긴다.
    }
  };

  const choose = (v: string) => {
    if (catalogIdOf(v) !== null && !installed.includes(catalogIdOf(v)!)) {
      void startDownload(v);
      return;
    }
    if (v !== value) void setFont(v);
  };

  const pickSystem = async () => {
    try {
      const fonts = await (loaderMod ?? (await loadCatalogModule())).listSystemFonts();
      setSystemFonts(fonts);
    } catch {
      // queryLocalFonts 가 없거나 거부됨 — 직접 입력으로 물러난다(이름을 알면 그대로 쓸 수 있다).
      setSystemFonts([]);
      setCustomMode(true);
    }
  };

  // 확정(blur/Enter) 한 번 — 타이핑마다 부르지 않는다(setter 는 call() 이라 실패하면 글자마다 토스트가 뜬다).
  // 비우면 직접 입력 모드를 닫는데, 저장값이 **직접 입력한 이름**이었을 때만 기본값으로 되돌린다.
  const commitCustom = () => {
    const typed = customInput.trim();
    if (!typed) {
      setCustomMode(false);
      setCustomInput("");
      if (!isKnown(value)) {
        dropPending();
        void setFont(cfg.fallback);
      }
      return;
    }
    dropPending(); // 이름을 확정한 것 = 명시적 선택. 아무것도 안 바꾸는 blur(빈 칸으로 닫기)는 받는 중인 글꼴을 건드리지 않는다.
    if (typed !== value) void setFont(typed);
  };

  const stackRole = target === "mono" ? "mono" : "text";
  const options: SelectOption[] = [
    ...(target === "editor" ? [{ value: FONT_SAME, label: t("settings.font_editor_same") }] : []),
    ...curated.map((c) => ({ value: c.value, label: c.label(), style: { fontFamily: fontStack(c.value, stackRole) } })),
    ...catalog.map((f) => {
      const v = catalogValue(f.id);
      const extra = [
        installed.includes(f.id) ? null : t("settings.font_download_size", { size: formatMB(loaderMod?.catalogBytes(f) ?? 0) }),
        f.weights === 1 ? t("settings.font_one_weight") : null,
      ].filter(Boolean);
      return {
        value: v,
        label: extra.length ? `${f.name} · ${extra.join(" · ")}` : f.name,
        // 받은 것도 안 받은 것도 같은 이름-글자 미리보기 패밀리로 — 목록을 열 때마다 본 글꼴 파일을 받지 않는다(loadPreviews).
        style: { fontFamily: `"${previewFamily(f.id)}", ${fontStack("pretendard", "text")}` },
      };
    }),
  ];
  // 카탈로그를 아직 못 읽었는데 저장값이 카탈로그 글꼴이면 그 값 자리를 비워 두지 않는다.
  const id = catalogIdOf(value);
  if (id !== null && !options.some((o) => o.value === value)) options.push({ value, label: id });
  if (!isBrowser()) options.push({ value: FONT_SYSTEM, label: t("settings.font_system_pick") });
  options.push({ value: FONT_CUSTOM, label: t("settings.font_custom") });

  const selectValue = customMode ? FONT_CUSTOM : value === "" && target === "editor" ? FONT_SAME : value;
  const label = t(cfg.labelKey);

  return (
    <>
      <SettingsRow
        anchor={cfg.anchor}
        label={label}
        control={
          <Select
            testid={cfg.testid}
            value={selectValue}
            ariaLabel={label}
            onChange={(mode) => {
              if (mode === FONT_CUSTOM) {
                setCustomMode(true);
                return;
              }
              if (mode === FONT_SYSTEM) {
                void pickSystem();
                return;
              }
              dropPending(); // 일반 선택·"앱 화면 글꼴과 같게" 전부 — 설치된 글꼴을 고르는 경로가 pending 을 안 지워서 생기던 덮어쓰기
              setCustomMode(false);
              setSystemFonts(null);
              choose(mode === FONT_SAME ? "" : mode);
            }}
            options={options}
            style={{ width: SETTINGS_CTRL_WIDTH, minWidth: SETTINGS_CTRL_WIDTH }}
          />
        }
      />

      {systemFonts && systemFonts.length > 0 && (
        <SettingsRow
          label={t("settings.font_system_list")}
          control={
            <Select
              testid={`${cfg.testid}-system`}
              value={systemFonts.includes(value) ? value : ""}
              ariaLabel={t("settings.font_system_list")}
              onChange={(name) => {
                if (name) dropPending();
                if (name && name !== value) void setFont(name);
              }}
              options={[
                { value: "", label: "—", disabled: true },
                ...systemFonts.map((name) => ({ value: name, label: name, style: { fontFamily: fontStack(name, stackRole) } })),
              ]}
              style={{ width: SETTINGS_CTRL_WIDTH, minWidth: SETTINGS_CTRL_WIDTH }}
            />
          }
        />
      )}

      {customMode && (
        <input
          className="field"
          type="text"
          value={customInput}
          placeholder={t("settings.font_custom_placeholder")}
          aria-label={t("settings.font_custom")}
          maxLength={64}
          onChange={(e) => setCustomInput(e.target.value)}
          onBlur={commitCustom}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          style={{ width: "100%", marginBottom: "var(--space-2)" }}
          data-testid={target === "ui" ? "settings-font-custom-input" : `${cfg.testid}-custom-input`}
        />
      )}

      {(pending || failed) && (
        <p
          role="status"
          data-testid={`${cfg.testid}-download`}
          style={{ margin: "0 0 var(--space-2)", fontSize: "var(--text-sm)", color: "var(--muted)" }}
        >
          {pending ? (
            t("settings.font_downloading", { pct: pending.pct })
          ) : (
            <>
              {t("settings.font_download_failed")}{" "}
              <button type="button" className="btn-link" onClick={() => failed && void startDownload(failed)}>
                {t("settings.font_download_retry")}
              </button>
            </>
          )}
        </p>
      )}
    </>
  );
}
