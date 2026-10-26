import { forwardRef, useImperativeHandle, useRef } from "react";
import { t } from "../i18n/t";
import { MobileModal } from "./MobileModal";

/** 촬영과 갤러리 선택은 입력 요소만 둘이고 호출자에게는 같은 "photo" 로 보고한다. */
export type AttachKind = "photo" | "audio" | "file";

/**
 * 시트를 열지 않고 갤러리 선택기만 바로 띄우는 손잡이 — 스피드 다이얼의 "사진"(MobileSpeedDial)이 쓴다.
 * 입력 요소는 이 컴포넌트가 늘 마운트해 두므로(아래 설명) 시트가 닫혀 있어도 `click()` 이 닿는다.
 * **탭 핸들러 안에서 동기로** 불러야 한다 — 타이머·await 뒤에는 WebView 가 선택기를 거절할 수 있다.
 */
export interface AttachSheetHandle {
  pickGallery: () => void;
}

interface MobileAttachSheetProps {
  open: boolean;
  onClose: () => void;
  /** Fires once per picked file (multi-select loops sequentially — MobileNote owns the upload
   *  queue, this component only reports what the OS picker returned). */
  onPick: (kind: AttachKind, files: FileList) => void;
}

/**
 * Attachment picker for the 📎 toolbar button (owner brief: "사진 / 음성 / 파일"), on the shared
 * centered `MobileModal`. 사진은 둘로 쪼갠다(S2): **촬영**(`capture=environment` — 카메라 앱을 바로 연다)
 * 과 **갤러리**(capture 없음 — 갤러리/파일 선택기). 갤러리 사진이 EXIF GPS 를 보존하는지는 브라우저·
 * 기기마다 달라 S22 실측 전에는 가정하지 않는다. The 4 hidden <input type=file> elements MUST stay OUTSIDE the modal and
 * mounted unconditionally (not gated on `open`, not modal children) — the sheet closes the instant
 * a choice is tapped, before the OS picker even resolves, so the input about to receive the native
 * picker's onChange must still be in the DOM. Moving them inside the modal would unmount them
 * mid-click and `ref.current?.click()` would silently no-op.
 */
export const MobileAttachSheet = forwardRef<AttachSheetHandle, MobileAttachSheetProps>(function MobileAttachSheet(
  { open, onClose, onPick },
  handleRef
) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(handleRef, () => ({ pickGallery: () => galleryRef.current?.click() }), []);

  const choose = (ref: typeof cameraRef) => {
    onClose();
    ref.current?.click();
  };

  const handleChange = (kind: AttachKind) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) onPick(kind, files);
    // Reset so picking the exact same file again still fires a change event next time.
    e.target.value = "";
  };

  return (
    <>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        hidden
        onChange={handleChange("photo")}
        data-testid="attach-input-camera"
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={handleChange("photo")}
        data-testid="attach-input-gallery"
      />
      <input
        ref={audioRef}
        type="file"
        accept="audio/*"
        capture
        multiple
        hidden
        onChange={handleChange("audio")}
        data-testid="attach-input-audio"
      />
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={handleChange("file")}
        data-testid="attach-input-file"
      />

      {open && (
        <MobileModal
          title={t("mobile.attach_sheet_title")}
          onClose={onClose}
          footer={
            <button type="button" className="mobile-text-btn" onClick={onClose}>
              {t("common.close")}
            </button>
          }
        >
          <div className="mobile-modal-options">
            <button type="button" className="menu-row mobile-ai-action" onClick={() => choose(cameraRef)}>
              {t("attachmentMeta.camera")}
            </button>
            <button type="button" className="menu-row mobile-ai-action" onClick={() => choose(galleryRef)}>
              {t("attachmentMeta.gallery")}
            </button>
            <button type="button" className="menu-row mobile-ai-action" onClick={() => choose(audioRef)}>
              {t("mobile.attach_audio")}
            </button>
            <button type="button" className="menu-row mobile-ai-action" onClick={() => choose(fileRef)}>
              {t("mobile.attach_file")}
            </button>
          </div>
        </MobileModal>
      )}
    </>
  );
});
