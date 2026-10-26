import { describe, it, expect, vi, beforeEach } from "vitest";
import { assertHookSettles } from "../../../test/renderLoop";
import { useFolderWindows } from "./useFolderWindows";
import { useFavoritesWindow } from "./useFavoritesWindow";
import { useTreeLoadMore } from "./useTreeLoadMore";
import { useNotesStore } from "../../../stores/notes";
import { useSettingsStore } from "../../../stores/settings";
import { call, callSilent } from "../../../lib/invoke";

vi.mock("../../../lib/invoke", () => {
  const handler = async (cmd: string) => {
    // Real setState path: noteQuery must resolve with a shaped payload so
    // setFolderNotes / setFavoriteNotes run (not the catch branch).
    if (cmd === "note_query") {
      return {
        notes: [
          {
            id: "n1",
            folder_id: "f1",
            title: "Note",
            year: 1500,
            is_favorite: true,
            exported_at: null,
            has_image: false,
            tag_names: [],
            region: null,
            status: null,
            icon: null,
            lat: null,
            lng: null,
          },
        ],
        total: 1,
      };
    }
    return {};
  };
  return {
    call: vi.fn(handler),
    callSilent: vi.fn(handler),
    flushAll: vi.fn(async () => {}),
    registerFlush: vi.fn(() => () => {}),
    emitNotice: vi.fn(),
  };
});

describe("NoteTree extracted hooks — render loop guards (assertHookSettles)", () => {
  beforeEach(() => {
    useNotesStore.setState({
      notesByFolder: {},
      folderQueryTotals: {},
      noteIndex: new Map(),
      totalNotes: 0,
    });
  });

  it("useFolderWindows settles and does not loop", async () => {
    const { renders } = await assertHookSettles(() => {
      useFolderWindows({
        searchActive: false,
        openFolderKey: "f1,f2",
        filterAxesKey: '{"tags":[],"tagMode":"or","region":null,"statuses":[]}',
        selectedTags: [],
        tagMode: "or",
        regionFilter: null,
        statusFilter: [],
        dateRange: null,
      });
    }, 12);
    expect(renders).toBeLessThanOrEqual(12);
  });

  it("useFavoritesWindow settles and does not loop", async () => {
    // 펼침 여부는 설정 스토어가 들고 있다(부팅 load()) — 펼친 상태라야 note_query 경로까지 돈다.
    useSettingsStore.setState({ favoritesOpen: true });
    vi.mocked(call).mockClear();
    vi.mocked(callSilent).mockClear();
    const { renders } = await assertHookSettles(() => {
      useFavoritesWindow({
        searchActive: false,
        filterAxesKey: '{"tags":[],"tagMode":"or","region":null,"statuses":[]}',
        selectedTags: [],
        tagMode: "or",
        regionFilter: null,
        statusFilter: [],
        dateRange: null,
      });
    }, 12);
    expect(renders).toBeLessThanOrEqual(12);
    // 사이드바 보기 전환마다 트리가 다시 마운트된다 — 설정 전체를 다시 읽지 않아야 한다.
    const cmds = [...vi.mocked(call).mock.calls, ...vi.mocked(callSilent).mock.calls].map((c) => c[0]);
    expect(cmds).not.toContain("settings_get_all");
    expect(cmds).toContain("note_query");
  });

  it("useTreeLoadMore settles and does not loop", async () => {
    const { renders } = await assertHookSettles(() => {
      useTreeLoadMore({
        searchActive: false,
        selectedTags: [],
        tagMode: "or",
        regionFilter: null,
        statusFilter: [],
        dateRange: null,
        favoritesOpen: true,
        favoriteNotes: [],
        favoritesTotal: 10,
        setFavoriteNotes: () => {},
        setFavoritesTotal: () => {},
        favoritesOffsets: {
          clear: () => {},
          clearKey: () => {},
          claim: () => true,
          has: () => false,
          release: () => {},
        },
        inboxId: "inbox-1",
      });
    }, 12);
    expect(renders).toBeLessThanOrEqual(12);
  });
});
