import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { VideoPreview } from "./VideoPreview";
import type { Attachment } from "../../lib/commands.gen";

vi.mock("../../lib/invoke", () => ({ call: vi.fn(), callSilent: vi.fn(), registerFlush: vi.fn() }));

const att = (): Attachment =>
  ({
    id: "a1",
    note_id: "n1",
    kind: "doc",
    name: "clip.mp4",
    rel_path: "n1/clip.mp4",
    url: null,
    size_bytes: 1234,
    position: 0,
  }) as unknown as Attachment;

describe("VideoPreview", () => {
  it("baseDir·convert 가 있으면 asset URL 로 <video> 를 그린다", () => {
    render(<VideoPreview att={att()} baseDir="/base" convert={(p) => `asset://${p}`} />);
    const v = screen.getByTestId("attachment-video");
    expect(v.tagName).toBe("VIDEO");
    expect(v.getAttribute("src")).toBe("asset:///base/n1/clip.mp4");
    expect(v.hasAttribute("controls")).toBe(true);
  });

  it("파일 URL 을 만들 수 없으면 외부에서 열기로 물러난다 — 검은 <video> 를 남기지 않는다", () => {
    render(<VideoPreview att={att()} baseDir={null} convert={null} />);
    expect(screen.queryByTestId("attachment-video")).toBeNull();
  });
});
