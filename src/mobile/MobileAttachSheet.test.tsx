import { createRef } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MobileAttachSheet, type AttachSheetHandle } from "./MobileAttachSheet";

describe("MobileAttachSheet", () => {
  it("renders the choices (photo split into camera / gallery) when open, and nothing when closed", () => {
    const { rerender } = render(<MobileAttachSheet open={false} onClose={() => {}} onPick={() => {}} />);
    expect(screen.queryByText("Take photo")).toBeNull();

    rerender(<MobileAttachSheet open onClose={() => {}} onPick={() => {}} />);
    expect(screen.getByText("Take photo")).toBeTruthy();
    expect(screen.getByText("Choose from gallery")).toBeTruthy();
    expect(screen.getByText("Voice")).toBeTruthy();
    expect(screen.getByText("File")).toBeTruthy();
  });

  it("tapping a choice closes the sheet immediately (before any file is picked)", () => {
    const onClose = vi.fn();
    render(<MobileAttachSheet open onClose={onClose} onPick={() => {}} />);

    fireEvent.click(screen.getByText("Take photo"));
    expect(onClose).toHaveBeenCalled();
  });

  // 촬영은 카메라 앱을 바로 열고(capture), 갤러리는 선택기를 연다(capture 없음) — 이 속성이 둘을 가른다.
  it("camera input carries capture=environment, gallery input does not", () => {
    render(<MobileAttachSheet open={false} onClose={() => {}} onPick={() => {}} />);
    const camera = screen.getByTestId("attach-input-camera") as HTMLInputElement;
    const gallery = screen.getByTestId("attach-input-gallery") as HTMLInputElement;
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(gallery.hasAttribute("capture")).toBe(false);
    expect(gallery.accept).toBe("image/*");
  });

  it("routes a gallery pick to onPick as 'photo' too", () => {
    const onPick = vi.fn();
    render(<MobileAttachSheet open onClose={() => {}} onPick={onPick} />);
    const file = new File(["x"], "g.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByTestId("attach-input-gallery"), { target: { files: [file] } });
    expect(onPick).toHaveBeenCalledWith("photo", expect.anything());
  });

  // 스피드 다이얼의 "사진" — 시트를 열지 않고 갤러리 선택기만 바로 띄운다. 입력 요소는 시트가 닫혀 있어도 마운트돼 있어야 한다.
  it("pickGallery() clicks the gallery input directly — the sheet stays closed, onClose is not called, and the pick still reports 'photo'", () => {
    const handle = createRef<AttachSheetHandle>();
    const onClose = vi.fn();
    const onPick = vi.fn();
    render(<MobileAttachSheet ref={handle} open={false} onClose={onClose} onPick={onPick} />);
    const gallery = screen.getByTestId("attach-input-gallery") as HTMLInputElement;
    const click = vi.spyOn(gallery, "click").mockImplementation(() => {});
    const others = ["camera", "audio", "file"].map((k) => vi.spyOn(screen.getByTestId(`attach-input-${k}`) as HTMLInputElement, "click"));

    handle.current!.pickGallery();
    expect(click).toHaveBeenCalledTimes(1);
    others.forEach((o) => expect(o).not.toHaveBeenCalled());
    expect(screen.queryByTestId("mobile-modal")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    const file = new File(["x"], "g.jpg", { type: "image/jpeg" });
    fireEvent.change(gallery, { target: { files: [file] } });
    expect(onPick).toHaveBeenCalledWith("photo", expect.anything());
  });

  it("routes a picked photo file to onPick with kind 'photo', and resets the input", () => {
    const onPick = vi.fn();
    render(<MobileAttachSheet open onClose={() => {}} onPick={onPick} />);

    const input = screen.getByTestId("attach-input-camera") as HTMLInputElement;
    const file = new File(["x"], "sunset.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onPick).toHaveBeenCalledTimes(1);
    const [kind, files] = onPick.mock.calls[0];
    expect(kind).toBe("photo");
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(file);
    expect(input.value).toBe("");
  });

  it("routes a picked audio file to onPick with kind 'audio'", () => {
    const onPick = vi.fn();
    render(<MobileAttachSheet open onClose={() => {}} onPick={onPick} />);

    const input = screen.getByTestId("attach-input-audio") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "memo.m4a", { type: "audio/m4a" })] } });

    expect(onPick).toHaveBeenCalledWith("audio", expect.anything());
  });

  it("routes a picked generic file to onPick with kind 'file'", () => {
    const onPick = vi.fn();
    render(<MobileAttachSheet open onClose={() => {}} onPick={onPick} />);

    const input = screen.getByTestId("attach-input-file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "report.pdf")] } });

    expect(onPick).toHaveBeenCalledWith("file", expect.anything());
  });

  it("does not call onPick when the change event carries no files (picker cancelled)", () => {
    const onPick = vi.fn();
    render(<MobileAttachSheet open onClose={() => {}} onPick={onPick} />);

    const input = screen.getByTestId("attach-input-file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });

    expect(onPick).not.toHaveBeenCalled();
  });

  it("the hidden inputs stay mounted while the sheet is closed (so a still-in-flight OS picker can still fire onChange)", () => {
    const onPick = vi.fn();
    render(<MobileAttachSheet open={false} onClose={() => {}} onPick={onPick} />);

    const input = screen.getByTestId("attach-input-camera") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "a.jpg")] } });

    expect(onPick).toHaveBeenCalledWith("photo", expect.anything());
  });
});
