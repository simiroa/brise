import { beforeEach, describe, expect, it, vi } from "vitest";

const emitNoticeMock = vi.fn();
vi.mock("./invoke", () => ({ emitNotice: (...a: unknown[]) => emitNoticeMock(...a) }));

import { t } from "../i18n/t";
import { copyWithNotice } from "./clipboard";

describe("copyWithNotice", () => {
  beforeEach(() => emitNoticeMock.mockClear());

  it("복사에 성공하면 성공 문구만 알리고 true", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    expect(await copyWithNotice("값", "복사했습니다")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("값");
    expect(emitNoticeMock).toHaveBeenCalledTimes(1);
    expect(emitNoticeMock).toHaveBeenCalledWith("복사했습니다");
  });

  it("복사에 실패하면 '복사했습니다' 로 거짓 안내하지 않고 실패 문구를 알리며 false", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    expect(await copyWithNotice("값", "복사했습니다")).toBe(false);
    expect(emitNoticeMock).toHaveBeenCalledTimes(1);
    expect(emitNoticeMock).toHaveBeenCalledWith(t("settings.sync_copy_failed"));
    expect(emitNoticeMock).not.toHaveBeenCalledWith("복사했습니다");
  });
});
