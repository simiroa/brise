import { describe, it, expect } from "vitest";
import { diagNoticeMessage } from "./App";
import { useSettingsStore } from "./stores/settings";

// App 전체를 마운트하지 않고 순수 함수만 본다(App.browserAux.test.tsx 와 같은 이유).
describe("diagNoticeMessage — 스왑 실패 알림(backup.rs::swap_live_state)", () => {
  const notice = (code: string) => ({
    feature: "backup",
    code,
    params: { op: "restore", snapshot: "brise-20261028T000000000000-ab12cd34.db" },
    ts: "2026-10-28T00:00:00Z",
  });

  it("db_connection_lost·swap_recovery_failed 는 공용 문구가 아니라 재시작 안내와 스냅샷 이름을 담는다", () => {
    for (const uiLang of ["ko", "en", "fr"] as const) {
      useSettingsStore.setState({ uiLang } as never);
      for (const code of ["db_connection_lost", "swap_recovery_failed"]) {
        const msg = diagNoticeMessage(notice(code));
        expect(msg).toContain("brise-20261028T000000000000-ab12cd34.db");
        expect(msg).not.toContain("backup/"); // diag_notice_generic("…(backup/code)") 로 떨어지지 않았다
        expect(msg).not.toContain("{{");
      }
    }
  });

  it("모르는 code 는 여전히 공용 문구", () => {
    useSettingsStore.setState({ uiLang: "en" } as never);
    expect(diagNoticeMessage(notice("something_else"))).toContain("backup/something_else");
  });
});
