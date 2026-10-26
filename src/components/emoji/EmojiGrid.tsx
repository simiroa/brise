import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { t } from "../../i18n/t";
import { setEmojiRenderState } from "../../lib/emoji/emojiCore";
import { EMOJI, EMOJI_GROUPS, emojiByKey, type EmojiEntry } from "../../lib/emoji/emojiManifest";
import { useSettingsStore } from "../../stores/settings";
import { call } from "../../lib/invoke";
import { isBrowser } from "../../lib/env";

export interface EmojiGridProps {
  onPick: (glyph: string) => void;
}

type StyleState = {
  present: boolean;
  downloading: boolean;
  progress_pct: number | null;
};

// 2026-08: 3d/animated 스타일 제거 — 남는 스타일은 color 하나뿐이라 탭 스트립도 같이 걷어냈다.
//
// ponytail: 팩 **다운로드** 버튼도 이 격자의 JSX 에서 사라진 지 오래인데 그것을 부르던
// handleDownload 만 아무도 호출하지 않는 채 남아 있었다(문구 3개도 함께 떠 있었다) — 지웠다.
// 팩이 없어도 이모지는 글리프 텍스트로 정상 렌더된다(emojiCore). 되살리려면 emoji_download
// 커맨드는 그대로 있으니 버튼과 문구만 다시 붙이면 된다. 아래 emoji_style_status 조회는
// 살아 있는 코드다 — 렌더러에 팩 존재 여부를 알린다.
type EmojiStyleStatus = {
  color: StyleState;
};

const FAV_GROUP = "__favorites__";
const RECENT_GROUP = "__recent__";

export function EmojiGrid({ onPick }: EmojiGridProps) {
  const emojiRecent = useSettingsStore((s) => s.emojiRecent);
  const addEmojiRecent = useSettingsStore((s) => s.addEmojiRecent);
  const emojiFavorites = useSettingsStore((s) => s.emojiFavorites);
  const toggleEmojiFavorite = useSettingsStore((s) => s.toggleEmojiFavorite);

  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string>(EMOJI_GROUPS[0]);

  const pick = useCallback(
    (e: EmojiEntry) => {
      void addEmojiRecent(e.u);
      onPick(e.g);
    },
    [addEmojiRecent, onPick]
  );
  const onCellContextMenu = useCallback(
    (ev: MouseEvent, key: string) => {
      ev.preventDefault();
      void toggleEmojiFavorite(key);
    },
    [toggleEmojiFavorite]
  );
  const favoriteEntries = useMemo(
    () => emojiFavorites.map((k) => emojiByKey(k)).filter((e): e is EmojiEntry => !!e),
    [emojiFavorites]
  );
  const recentEntries = useMemo(
    () => emojiRecent.map((k) => emojiByKey(k)).filter((e): e is EmojiEntry => !!e),
    [emojiRecent]
  );

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPolling = useCallback(() => {
    if (!timerRef.current) {
      timerRef.current = setInterval(() => {
        void fetchStatus();
      }, 1000);
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    // App.tsx::fetchEmojiStatus 와 같은 이유 — 로컬 디스크 커맨드라 HTTP 표면에서 제외돼 있어
    // 동기화 브라우저 탭에서 부르면 매번 NOT_FOUND 토스트만 띄운다.
    if (isBrowser()) return;
    try {
      const res = await call<EmojiStyleStatus>("emoji_style_status");
      // 응답을 로컬 state 로도 들고 있었지만 읽는 곳이 없다 — 이 호출의 쓸모는 렌더러에게
      // 팩 존재 여부를 알려주는 아래 한 줄뿐이다.
      setEmojiRenderState({ colorPresent: res.color.present });

      if (res.color.downloading) {
        startPolling();
      } else {
        stopPolling();
      }
    } catch {
      // ignore
    }
  }, [startPolling, stopPolling]);

  // Fetch status on mount and poll when downloading
  useEffect(() => {
    void fetchStatus();

    return () => {
      stopPolling();
    };
  }, [fetchStatus, stopPolling]);

  useEffect(() => {
    if (group === FAV_GROUP && favoriteEntries.length === 0) setGroup(EMOJI_GROUPS[0]);
    if (group === RECENT_GROUP && recentEntries.length === 0) setGroup(EMOJI_GROUPS[0]);
  }, [group, favoriteEntries.length, recentEntries.length]);

  const shown: EmojiEntry[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return EMOJI.filter((e) => e.c.toLowerCase().includes(q)).slice(0, 240);
    if (group === FAV_GROUP) return favoriteEntries;
    if (group === RECENT_GROUP) return recentEntries;
    return EMOJI.filter((e) => e.gr === group);
  }, [query, group, favoriteEntries, recentEntries]);

  return (
    <div className="emoji-grid-root">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("editor.emoji_search")}
        className="emoji-search"
      />
      {!query && (
        <div className="emoji-tabs" role="tablist">
          {favoriteEntries.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={group === FAV_GROUP}
              className="emoji-tab"
              data-active={group === FAV_GROUP}
              title={t("editor.emoji_favorites")}
              onClick={() => setGroup(FAV_GROUP)}
            >
              ★
            </button>
          )}
          {recentEntries.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={group === RECENT_GROUP}
              className="emoji-tab"
              data-active={group === RECENT_GROUP}
              title={t("editor.emoji_recent")}
              onClick={() => setGroup(RECENT_GROUP)}
            >
              ◷
            </button>
          )}
          {EMOJI_GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={g === group}
              className="emoji-tab"
              data-active={g === group}
              title={g}
              onClick={() => setGroup(g)}
            >
              {EMOJI.find((e) => e.gr === g)?.g ?? "•"}
            </button>
          ))}
        </div>
      )}
      <div className="emoji-grid" data-testid="emoji-pick-grid">
        {shown.map((e) => (
          <button
            key={e.u}
            type="button"
            className="emoji-cell"
            title={t("editor.emoji_pin_hint", { name: e.c })}
            onClick={() => pick(e)}
            onContextMenu={(ev) => onCellContextMenu(ev, e.u)}
          >
            {e.g}
          </button>
        ))}
        {shown.length === 0 && <div className="emoji-empty">{t("editor.emoji_none")}</div>}
      </div>
    </div>
  );
}
