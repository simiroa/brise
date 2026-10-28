import { t } from "../../i18n/t";
import { ATTACHMENT_STORAGE_MODES, type AttachmentStorageMode } from "../../stores/prefs";
import { optionsOf } from "./shared";

/**
 * 둘 이상의 화면이 같은 라벨로 쓰는 열거형 옵션 — 첨부 저장 방식은 설정(AttachmentStorageSection)과 온보딩(OnboardingDataStep)이 같은
 * 세 칸을 그린다. 값 목록은 stores/prefs.ts, 라벨 맵이 모든 값을 덮어야 컴파일된다(shared.ts::optionsOf).
 */
const ATTACHMENT_STORAGE_LABELS: Record<AttachmentStorageMode, () => string> = {
  copy: () => t("settings.attachment_storage_mode_copy"),
  link: () => t("settings.attachment_storage_mode_link"),
  reference: () => t("settings.attachment_storage_mode_reference"),
};
export const attachmentStorageOptions = () => optionsOf(ATTACHMENT_STORAGE_MODES, ATTACHMENT_STORAGE_LABELS);
