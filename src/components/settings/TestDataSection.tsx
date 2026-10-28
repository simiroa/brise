import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { call, callSilent } from "../../lib/invoke";
import type { Workspace } from "../../lib/commands.gen";
import { t } from "../../i18n/t";
import { SettingsRow } from "./SettingsRow";
import { IconFlask, IconPlus, IconTrash } from "../icons";
import { IconAction } from "./IconAction";
import { seedTestDb, TEST_DB_NAME } from "../../lib/testDbSeed";
import { SettingsCard } from "./SettingsCard";

// 임시 개발용 — 다양한 타입이 든 "테스트 DB" 노트북을 만들고 지우는 토글 (2026-08-20 오너).
// 온오프 상태는 설정 키가 아니라 "그 이름의 노트북이 존재하는가"다 — testDbSeed.ts 헤더 참조.
// 기능 검증이 끝나면 이 섹션과 lib/testDbSeed.ts, i18n test_db_* 키를 통째로 지우면 된다.
export function TestDataSection() {
  // 훅은 전부 아래 조기 반환 **위**에 둔다(CLAUDE.md 함정 1).
  const [testWs, setTestWs] = useState<Workspace | null>(null);
  const [busy, setBusy] = useState(false);
  const dev = process.env.NODE_ENV === "development";

  const refresh = async () => {
    try {
      const { workspaces } = await call<{ workspaces: Workspace[] }>("workspace_list", {});
      setTestWs(workspaces.find((w) => w.name === TEST_DB_NAME) ?? null);
    } catch {
      /* call() 이 이미 에러 토스트를 띄웠다 */
    }
  };

  useEffect(() => {
    if (dev) void refresh();
  }, [dev]);

  const toggle = async () => {
    setBusy(true);
    try {
      // 설정 창은 본 창과 다른 웹뷰(스토어 분리) — settingsChanged.ts 와 같은 이유로 이벤트로
      // 알린다. 본 창의 App.tsx 가 "workspaces-changed" 를 받아 목록을 재조회하고,
      // activate 가 실려 있으면 그 노트북으로 전환까지 한다.
      if (testWs) {
        await callSilent("workspace_delete", { id: testWs.id });
        void emit("workspaces-changed", {}).catch(() => {}); // silent-ok: Tauri 밖(테스트·브라우저)엔 이벤트 버스가 없다 — 본 창 갱신만 놓친다
      } else {
        const ws = await seedTestDb();
        void emit("workspaces-changed", { activate: ws.id }).catch(() => {}); // silent-ok: 위와 같다
      }
      await refresh();
    } catch {
      /* call() 이 이미 에러 토스트를 띄웠다 — 남은 반쪽짜리 노트북은 다시 끄기로 지운다 */
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!dev) return null;

  return (
    <SettingsCard
      title={t("settings.test_db_title")}
      icon={<IconFlask size={14} strokeWidth={2} />}
    >
      <SettingsRow
        data-testid="settings-data-test-db-row"
        label={t("settings.test_db_label")}
        hint={testWs ? t("settings.test_db_on_desc") : t("settings.test_db_off_desc")}
        control={
          <IconAction
            // design-review 2026-09-14 §1-G/§4-F: "삭제" 동사가 라벨에 뜨는 순간에만 danger로 —
            // DataManagementSection.tsx의 RESET/RESTORE 확인 버튼과 같은 조건부 패턴(생성 상태를
            // 실수로 붉게 칠하면 그게 더 잘못된 신호다).
            icon={testWs ? <IconTrash size={16} /> : <IconPlus size={16} />}
            label={testWs ? t("settings.test_db_delete") : t("settings.test_db_create")}
            titleOverride={busy ? t("settings.test_db_working") : undefined}
            danger={!!testWs}
            busy={busy}
            data-testid="settings-data-test-db-toggle"
            disabled={busy}
            onClick={() => void toggle()}
          />
        }
      />
    </SettingsCard>
  );
}
