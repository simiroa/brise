import { describe, it, expect, vi, beforeEach } from "vitest";

const callSilentMock = vi.fn();
const emitNoticeMock = vi.fn();
vi.mock("./invoke", () => ({
  callSilent: (...a: unknown[]) => callSilentMock(...a),
  emitNotice: (...a: unknown[]) => emitNoticeMock(...a),
  // frameNotices → undo.ts 가 로드될 때 부른다.
  registerFlush: () => {},
}));

import { useSettingsStore } from "../stores/settings";
import { resetFrameNoticesForTests, useFrameNotices } from "./frameNotices";
import { checkStorageAlertOnce, isOverStorageLimit, STORAGE_NOTICE_KEY } from "./storageAlert";

const GB = 1024 ** 3;

beforeEach(() => {
  callSilentMock.mockReset();
  emitNoticeMock.mockReset();
  resetFrameNoticesForTests();
});

describe("storageAlert", () => {
  it("isOverStorageLimit: 한도 0 은 끔, 한도를 넘어야 true", () => {
    expect(isOverStorageLimit(100 * GB, 0)).toBe(false);
    expect(isOverStorageLimit(2 * GB, 2)).toBe(false);
    expect(isOverStorageLimit(2 * GB + 1, 2)).toBe(true);
  });

  it("한도 0 이면 db_stats 도 부르지 않는다", async () => {
    useSettingsStore.setState({ storageAlertGb: 0 } as never);
    await checkStorageAlertOnce();
    expect(callSilentMock).not.toHaveBeenCalled();
  });

  it("한도를 넘으면 알리고, 안 넘으면 조용하다", async () => {
    useSettingsStore.setState({ storageAlertGb: 1 } as never);
    callSilentMock.mockResolvedValue({ db_size_bytes: 2 * GB, attachments_size_bytes: 0 });
    await checkStorageAlertOnce();
    expect(emitNoticeMock).toHaveBeenCalledTimes(1);

    emitNoticeMock.mockReset();
    callSilentMock.mockResolvedValue({ db_size_bytes: GB / 2, attachments_size_bytes: 0 });
    await checkStorageAlertOnce();
    expect(emitNoticeMock).not.toHaveBeenCalled();
  });

  it("알림은 토스트로 한 번 뜨고 벨 목록에도 남는다(놓쳐도 다시 볼 수 있게)", async () => {
    useSettingsStore.setState({ storageAlertGb: 1 } as never);
    callSilentMock.mockResolvedValue({ db_size_bytes: 2 * GB, attachments_size_bytes: 0 });
    await checkStorageAlertOnce();
    expect(useFrameNotices.getState().notices.map((n) => n.key)).toEqual([STORAGE_NOTICE_KEY]);
    // 다시 확인해도(부팅이 아닌 재호출) 토스트는 또 뜨지 않고 목록의 항목도 하나다.
    await checkStorageAlertOnce();
    expect(emitNoticeMock).toHaveBeenCalledTimes(1);
    expect(useFrameNotices.getState().notices).toHaveLength(1);
  });
});
